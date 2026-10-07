// Multi-user HTTP mode: an OAuth authorization server (claude.ai custom connector) in front of the MCP endpoint.
// Students log in with their own Canvas URL and token, which travel inside sealed tokens; nothing is stored.
import { createHash } from "node:crypto";
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from "express";
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

const MAX_IN_FLIGHT = 16; // concurrent /mcp requests, process-wide: each can hold tens of MB of Canvas responses
const rpcError = (message: string) => ({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
/** The Canvas credential sealed in the bearer token; only after requireBearerAuth. */
const credOf = (req: Request) => req.auth!.extra!.cred as CanvasCred;
const sendPage = (res: Response, status: number, html: string, formActionOrigin?: string) =>
  void res.status(status).set(pageHeaders(formActionOrigin)).type("html").send(html);

/** At most `max` requests past this point at once; the rest get 503 and a hint to retry. */
function concurrencyGate(max: number): RequestHandler {
  let inFlight = 0;
  return (_req, res, next) => {
    if (inFlight >= max) {
      res.status(503).set("Retry-After", "5").json(rpcError("Server busy, try again in a few seconds"));
      return;
    }
    inFlight++;
    res.once("close", () => inFlight--);
    next();
  };
}

export function createPublicApp(o: {
  publicUrl: string; key: string; redirectOrigins: string[]; trustProxy: string; allowPrivateNetwork: boolean; maxChars: number;
}): Express {
  const { publicUrl, allowPrivateNetwork: allowHttp, maxChars } = o;
  const publicOrigin = new URL(publicUrl).origin;
  const mcpUrl = new URL("/mcp", publicUrl);
  const provider = new StatelessProvider({ sealer: new Sealer(o.key), redirectOrigins: o.redirectOrigins });
  const guardedFetch = createGuardedFetch({ allowPrivate: allowHttp }); // one per process: one undici Agent

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
    rateLimit({
      windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false,
      // Per student, not per IP (claude.ai's requests all come from its servers). Keyed by a hash, never the token.
      keyGenerator: (req) => { const { url, token } = credOf(req); return createHash("sha256").update(`${url}\n${token}`).digest("base64url"); },
      handler: (_req, res) => void res.status(429).json(rpcError("Too many requests, slow down")),
    }),
    express.json({ limit: "1mb" }),
    concurrencyGate(MAX_IN_FLIGHT),
    async (req, res) => {
      const cred = credOf(req);
      // A server per request: tools keep a per-server file cache, which must never be shared between students.
      const server = buildServer(new CanvasClient({ baseUrl: cred.url, token: cred.token, fetch: guardedFetch }), { timeZone: cred.tz, maxChars });
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
