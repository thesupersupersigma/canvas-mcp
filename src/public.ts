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
import { closeOnSignal } from "./http.js";
import { CanvasCred, isSameOriginPost, normalizeCanvasUrl, normalizeTimeZone, verifyCanvasLogin } from "./login.js";
import { createGuardedFetch } from "./netguard.js";
import { StatelessProvider } from "./oauth.js";
import { errorPage, landingPage, loginPage, pageHeaders } from "./pages.js";
import { Sealer } from "./seal.js";
import { buildServer, VERSION } from "./server.js";

// In-flight /mcp work. Each request can hold up to REQUEST_BUDGET.bytes of Canvas responses plus extracted text, hence
// a small process-wide cap; the per-credential cap stops one student, or one fake "Canvas" that answers slowly, from
// taking every slot. Remaining risk: an attacker who runs a slow fake Canvas and logs in 3 times (16 / 6, rounded up;
// the per-IP /login limit only slows that) can still keep every slot busy, so other students get 503.
const MAX_IN_FLIGHT = 16;
const MAX_IN_FLIGHT_PER_CRED = 6;
/** Messages in one JSON-RPC batch; the batch shares its request's slot and budget (the SDK alone would take 100). */
const MAX_BATCH = 8;
const MiB = 1024 * 1024;
/** What one POST /mcp may ask of Canvas, over all of its tool calls: the slots cap how many requests run at once, this
 *  caps what each one does. Past it, the fetch that would cross it fails with BudgetError. */
export const REQUEST_BUDGET = Object.freeze({
  fetches: 100, // Canvas requests (get_calendar over every course makes one per 10 courses)
  bytes: 96 * MiB, // response bodies, counted after decoding
  ms: 120_000, // from admission; then every Canvas fetch still running is cancelled
  pageBytes: 16 * MiB, // one API (JSON) response, as CanvasClient's maxJsonBytes; file downloads keep the guard's 60 MiB
});
export class BudgetError extends Error {
  name = "BudgetError";
  constructor() { super("This request needed too much data from Canvas."); }
}
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

  /** A slot for `key`, held from now until `res` closes and the tracked work settles; or which limit is in the way.
   *  A response that has already closed (its client hung up while the body was read) won't emit "close" again, so its
   *  slot is released at once and its signal starts out aborted. */
  enter(key: string, res: Pick<EventEmitter, "once"> & { closed?: boolean; destroyed?: boolean }): Work | "credential" | "server" {
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
    let open = true;
    const close = () => { if (open) { open = false; ctl.abort(); settle(); } };
    res.once("close", close);
    if (res.closed || res.destroyed) close();
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

/** The fetch for one admitted request's Canvas work: cancelled when its response closes or its time is up, every call
 *  tracked by its slot, and refused with BudgetError past the budget's fetch count or total of body bytes. */
export function budgetedFetch(fetch: typeof globalThis.fetch, work: Work, budget = REQUEST_BUDGET): typeof globalThis.fetch {
  const timeUp = new AbortController();
  const timer = setTimeout(() => timeUp.abort(new BudgetError()), budget.ms);
  const stop = () => clearTimeout(timer);
  if (work.signal.aborted) stop();
  else work.signal.addEventListener("abort", stop, { once: true });
  const signal = AbortSignal.any([work.signal, timeUp.signal]);
  let fetches = 0, bytes = 0;
  const count = (n: number) => { if ((bytes += n) > budget.bytes) throw new BudgetError(); };
  return async (input, init) => {
    if (++fetches > budget.fetches) throw new BudgetError();
    const res = await work.track(fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }));
    return metered(res, count);
  };
}

type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>; // `Response` here is Express's

/** `res` with every body chunk passed to `count` on its way through; a throw from `count` fails the read and cancels
 *  the source body. */
function metered(res: FetchResponse, count: (bytes: number) => void): FetchResponse {
  if (!res.body) return res;
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { count(chunk.byteLength); controller.enqueue(chunk); },
  }));
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, "url", { value: res.url });
  return out;
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
    express.json({ limit: "256kb" }),
    // A batch runs all its tool calls at once in one slot, on one budget; MCP 2025-03-26 clients may send them.
    (req, res, next) => Array.isArray(req.body) && (req.body.length === 0 || req.body.length > MAX_BATCH)
      ? void res.status(400).json(rpcError(`A JSON-RPC batch must hold 1 to ${MAX_BATCH} messages`, -32600))
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
      // Every Canvas fetch is cancelled when the response closes or the budget's time is up, counted until it settles,
      // and within the request's budget; every tool call is counted until it settles too.
      const fetch = budgetedFetch(guardedFetch, work);
      // A server per request: tools keep a per-server file cache, which must never be shared between students.
      const canvas = new CanvasClient({ baseUrl: cred.url, token: cred.token, fetch, maxJsonBytes: REQUEST_BUDGET.pageBytes });
      const server = buildServer(canvas, { timeZone: cred.tz, maxChars, track: (call) => void work.track(call) });
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
  closeOnSignal(app.listen(port, host, (err?: Error) => {
    if (err) { console.error(`canvas-mcp: can't listen on ${host}:${port}: ${err.message}`); process.exit(1); }
    console.error(`canvas-mcp ${VERSION} multi-user HTTP on http://${host}:${port}`);
  }));
}
