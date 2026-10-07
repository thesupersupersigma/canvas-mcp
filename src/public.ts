// Multi-user HTTP mode: an OAuth authorization server (claude.ai custom connector) in front of the MCP endpoint.
// Students log in with their own Canvas URL and token, which travel inside sealed tokens; nothing is stored.
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import express, { type ErrorRequestHandler, type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CanvasClient } from "./canvas.js";
import { CanvasCred, isSameOriginPost, normalizeCanvasUrl, normalizeTimeZone, verifyCanvasLogin } from "./login.js";
import { createGuardedFetch } from "./netguard.js";
import { StatelessProvider } from "./oauth.js";
import { errorPage, landingPage, loginPage, pageHeaders } from "./pages.js";
import { Sealer } from "./seal.js";
import { buildServer, VERSION } from "./server.js";

// In-flight /mcp work. Each request can hold tens of MB of Canvas responses and extracted text, hence a small
// process-wide cap; the per-credential cap stops one student, or one fake "Canvas" that answers slowly, from taking every
// slot. Remaining risk: an attacker who runs a slow fake Canvas and logs in MAX_IN_FLIGHT / MAX_IN_FLIGHT_PER_CRED times
// (4 logins, which the per-IP /login limit only slows) can still keep every slot busy, so other students get 503.
const MAX_IN_FLIGHT = 16;
const MAX_IN_FLIGHT_PER_CRED = 4;
const rpcError = (message: string, code = -32000) => ({ jsonrpc: "2.0", error: { code, message }, id: null });
/** The Canvas credential sealed in the bearer token; only after requireBearerAuth. */
const credOf = (req: Request) => req.auth!.extra!.cred as CanvasCred;
/** Identifies one Canvas credential (every token issued for it) without keeping the Canvas token itself. */
const credKey = ({ url, token }: CanvasCred) => createHash("sha256").update(`${url}\n${token}`).digest("base64url");
const sendPage = (res: Response, status: number, html: string, formActionOrigin?: string) =>
  void res.status(status).set(pageHeaders(formActionOrigin)).type("html").send(html);

/** One admitted request's work: `signal` aborts when its response closes; tracked promises keep its slot taken. */
export interface Work {
  readonly signal: AbortSignal;
  track<T>(work: Promise<T>): Promise<T>;
}

/** Slots for in-flight work, at most `max` in all and `maxPerKey` per key. A request keeps its slot until its response
 *  has closed AND everything it tracked has settled, so a client that hangs up frees nothing while its Canvas fetches
 *  or file extraction still run; closing the response aborts `signal`, which cancels those fetches. */
export class WorkGate {
  private total = 0;
  private readonly perKey = new Map<string, number>();
  constructor(private readonly max: number, private readonly maxPerKey: number) {}

  get inFlight(): number { return this.total; }

  /** A slot for `key`, held from now until `res` closes and the tracked work settles; or which limit is in the way. */
  enter(key: string, res: Pick<EventEmitter, "once">): Work | "credential" | "server" {
    const mine = this.perKey.get(key) ?? 0;
    if (mine >= this.maxPerKey) return "credential";
    if (this.total >= this.max) return "server";
    this.total++;
    this.perKey.set(key, mine + 1);
    const ctl = new AbortController();
    let pending = 1; // the response itself, until it closes
    const settle = () => {
      if (--pending > 0) return;
      this.total--;
      const left = this.perKey.get(key)! - 1;
      if (left) this.perKey.set(key, left);
      else this.perKey.delete(key);
    };
    res.once("close", () => { ctl.abort(); settle(); });
    return {
      signal: ctl.signal,
      track: (work) => {
        // After the release the signal has fired, so whatever starts now is cancelled at its first fetch.
        if (pending > 0) { pending++; work.then(settle, settle); }
        return work;
      },
    };
  }
}

export function createPublicApp(o: {
  publicUrl: string; key: string; redirectOrigins: string[]; trustProxy: string; allowPrivateNetwork: boolean; maxChars: number;
}): Express {
  const { publicUrl, allowPrivateNetwork: allowHttp, maxChars } = o;
  const publicOrigin = new URL(publicUrl).origin;
  const mcpUrl = new URL("/mcp", publicUrl);
  const provider = new StatelessProvider({ sealer: new Sealer(o.key), redirectOrigins: o.redirectOrigins });
  const guardedFetch = createGuardedFetch({ allowPrivate: allowHttp }); // one per process: one undici Agent
  const gate = new WorkGate(MAX_IN_FLIGHT, MAX_IN_FLIGHT_PER_CRED);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", o.trustProxy);

  app.get("/health", (_req, res) => void res.type("text").send("ok"));
  app.get("/", (_req, res) => sendPage(res, 200, landingPage(publicUrl)));

  // claude.ai registers and fetches tokens from its servers, so many students share a few IPs there.
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(publicUrl),
    resourceServerUrl: mcpUrl,
    clientRegistrationOptions: { clientSecretExpirySeconds: 0, rateLimit: { windowMs: 60 * 60_000, limit: 300 } },
    tokenOptions: { rateLimit: { windowMs: 15 * 60_000, limit: 1000 } },
  }));

  const expired = (res: Response) => sendPage(res, 400, errorPage("This login link expired."));
  app.post("/login",
    // Before anything else: a cross-site form gets nothing back, least of all the Canvas address it posted.
    (req, res, next) => isSameOriginPost(req.headers, publicOrigin) ? next() : sendPage(res, 403, errorPage("This login form didn't come from this site.")),
    rateLimit({
      windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
      handler: (_req, res) => sendPage(res, 429, errorPage("Too many login attempts. Wait 15 minutes, then try again.")),
    }),
    express.urlencoded({ extended: false, limit: "10kb" }),
    async (req, res) => {
      const field = (name: string) => typeof req.body?.[name] === "string" ? req.body[name] as string : "";
      const authreq = field("authreq");
      const pending = provider.openAuthReq(authreq);
      if (!pending) return expired(res);
      const to = new URL(pending.redirectUri);
      const retry = (error: string) => sendPage(res, 200, loginPage({ authreq, redirectHost: to.host, error, canvasUrl: field("canvas_url") }), to.origin);
      const url = normalizeCanvasUrl(field("canvas_url"), allowHttp);
      if (!url) return retry("Enter your school's Canvas address, like https://yourschool.instructure.com");
      const cred: CanvasCred = { url, token: field("token").trim(), tz: normalizeTimeZone(req.body?.tz) };
      const verified = await verifyCanvasLogin(cred, guardedFetch, { allowHttp });
      if ("error" in verified) return retry(verified.error);
      const back = provider.completeLogin(authreq, { ...cred, url: verified.url });
      if (!back) return expired(res);
      res.redirect(302, back);
    });

  app.post("/mcp",
    requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }),
    (req, res, next) => { res.locals.credKey = credKey(credOf(req)); next(); },
    rateLimit({
      windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false,
      // Per student, not per IP (claude.ai's requests all come from its servers). Keyed by a hash, never the token.
      keyGenerator: (_req, res) => res.locals.credKey,
      handler: (_req, res) => void res.status(429).json(rpcError("Too many requests, slow down")),
    }),
    express.json({ limit: "1mb" }),
    // One message per POST, so one slot is one tool call: a batch could run up to 100 of them (current MCP has no batches).
    (req, res, next) => Array.isArray(req.body)
      ? void res.status(400).json(rpcError("Batched JSON-RPC requests aren't supported; send one per request", -32600))
      : next(),
    (_req, res, next) => {
      const work = gate.enter(res.locals.credKey, res);
      if (work === "credential")
        return void res.status(429).set("Retry-After", "5").json(rpcError(`At most ${MAX_IN_FLIGHT_PER_CRED} requests at once per Canvas login; wait for one to finish`));
      if (work === "server") return void res.status(503).set("Retry-After", "5").json(rpcError("Server busy, try again in a few seconds"));
      res.locals.work = work;
      next();
    },
    async (req, res) => {
      const cred = credOf(req), work: Work = res.locals.work;
      // Every Canvas fetch is cancelled when the response closes, and counted until it settles; so is every tool call.
      const fetch: typeof globalThis.fetch = (input, init) => work.track(guardedFetch(input,
        { ...init, signal: init?.signal ? AbortSignal.any([init.signal, work.signal]) : work.signal }));
      // A server per request: tools keep a per-server file cache, which must never be shared between students.
      const server = buildServer(new CanvasClient({ baseUrl: cred.url, token: cred.token, fetch }),
        { timeZone: cred.tz, maxChars, track: (call) => void work.track(call) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void Promise.allSettled([transport.close(), server.close()]));
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  // Stateless server: no standalone SSE stream or sessions to delete.
  app.all("/mcp", (_req, res) => void res.status(405).set("Allow", "POST").end());

  // Last: a generic answer, and a log line without the error itself (a body-parser error quotes the request body).
  app.use(((err, _req, res, _next) => {
    const status = Number(err?.status ?? err?.statusCode);
    console.error(`request failed: ${err?.name ?? "Error"}${err?.type ? ` (${err.type})` : ""}`);
    if (res.headersSent) return void res.destroy();
    const client = status >= 400 && status < 500;
    res.status(client ? status : 500).json({ error: client ? "Bad request" : "Internal server error" });
  }) as ErrorRequestHandler);

  return app;
}

export function startPublicHttp(app: Express, port: number, host: string): void {
  app.listen(port, host, (err?: Error) => {
    if (err) { console.error(`canvas-mcp: can't listen on ${host}:${port}: ${err.message}`); process.exit(1); }
    console.error(`canvas-mcp ${VERSION} multi-user HTTP on http://${host}:${port}`);
  });
}
