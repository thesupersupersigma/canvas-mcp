#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CanvasClient } from "./canvas.js";
import { buildServer, VERSION } from "./server.js";
import { startSecretHttp } from "./http.js";
import { parseRedirectOrigins } from "./oauth.js";
import { createPublicApp, startPublicHttp } from "./public.js";

const HELP = `canvas-mcp ${VERSION} — Canvas LMS MCP server (read-only)

Usage:
  canvas-mcp [options]              Run over stdio (Claude Desktop / Claude Code)
  canvas-mcp --http [options]       Run as an HTTP server (claude.ai custom connector)
  canvas-mcp --check                Test your token and list your courses, then exit

Options (each also settable by env var):
  --url <url>          Canvas base URL, e.g. https://school.instructure.com   [CANVAS_BASE_URL]
  --token <token>      Canvas access token (prefer the env var)               [CANVAS_API_TOKEN]
  --tz <zone>          Time zone for due dates (default: system)               [CANVAS_TZ]
  --max-chars <n>      Max characters per tool response chunk (default 20000) [CANVAS_MAX_CHARS]
  --http               Serve MCP over Streamable HTTP instead of stdio
  --port <n>           HTTP port (default 7341)                               [CANVAS_MCP_PORT]
  --host <addr>        HTTP bind address (default 127.0.0.1 = this PC only)   [CANVAS_MCP_HOST]
  --secret <s>         Single-user HTTP mode: endpoint becomes /mcp/<secret>  [MCP_SECRET]
  --check              Verify credentials and exit
  -v, --version
  -h, --help

Multi-user mode (--http with PUBLIC_URL instead of a secret; each student logs in with their own Canvas):
  PUBLIC_URL                   The server's public origin, e.g. https://canvas.example.com
  CANVAS_MCP_KEY               At least 32 chars; encrypts every token (try: openssl rand -hex 32)
  CANVAS_MCP_REDIRECT_HOSTS    Optional: comma-separated origins that may receive logins
                               (default: https://claude.ai, https://claude.com, http://localhost, http://127.0.0.1)
  TRUST_PROXY                  Optional: Express "trust proxy" (default: loopback, linklocal, uniquelocal)
`;

const { values: a } = parseArgs({
  options: {
    url: { type: "string" }, token: { type: "string" }, tz: { type: "string" }, "max-chars": { type: "string" },
    http: { type: "boolean" }, port: { type: "string" }, host: { type: "string" }, secret: { type: "string" },
    check: { type: "boolean" }, version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" },
  },
});

if (a.help) { process.stdout.write(HELP); process.exit(0); }
if (a.version) { process.stdout.write(VERSION + "\n"); process.exit(0); }

const env = process.env;
function die(m: string): never { console.error(`canvas-mcp: ${m}\nRun with --help for usage.`); process.exit(1); }
const opts = {
  timeZone: a.tz ?? env.CANVAS_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  maxChars: Number(a["max-chars"] ?? env.CANVAS_MAX_CHARS ?? 20000),
};

/** stdio, --check and single-user HTTP all talk to one Canvas account given at startup. */
function canvasFromArgs() {
  const baseUrl = a.url ?? env.CANVAS_BASE_URL ?? env.CANVAS_URL;
  const token = a.token ?? env.CANVAS_API_TOKEN ?? env.CANVAS_TOKEN;
  if (!baseUrl) die("Missing Canvas URL (--url or CANVAS_BASE_URL), e.g. https://yourschool.instructure.com");
  if (!token) die("Missing Canvas token (CANVAS_API_TOKEN)");
  return { baseUrl, canvas: new CanvasClient({ baseUrl, token }) };
}

async function check() {
  const { canvas } = canvasFromArgs();
  const me = await canvas.get("/users/self");
  const courses = await canvas.getAll("/courses", { enrollment_state: "active" });
  console.log(`✓ Authenticated (Canvas user id ${me.id})`);
  console.log(`✓ ${courses.length} active course(s):`);
  for (const c of courses) if (c.name) console.log(`   ${c.id}  ${c.name}`);
}

async function stdio() {
  const { baseUrl, canvas } = canvasFromArgs();
  await buildServer(canvas, opts).connect(new StdioServerTransport());
  console.error(`canvas-mcp ${VERSION} running on stdio → ${baseUrl}`);
}

/** PUBLIC_URL as a bare origin (a trailing slash is fine); anything with a path, query or credentials is refused. */
function publicOrigin(raw: string): string {
  let u: URL | undefined;
  try { u = new URL(raw); } catch {}
  if (!u || !/^https?:$/.test(u.protocol) || u.pathname !== "/" || u.search || u.hash || u.username || u.password)
    die("PUBLIC_URL must be the server's origin with no path, e.g. https://canvas.example.com");
  if (u.protocol === "http:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1")
    die("PUBLIC_URL must use https (http only for localhost testing)");
  return u.origin;
}

async function http() {
  const port = Number(a.port ?? env.CANVAS_MCP_PORT ?? 7341);
  const host = a.host ?? env.CANVAS_MCP_HOST ?? "127.0.0.1";
  const secret = a.secret ?? env.MCP_SECRET;
  if (env.PUBLIC_URL) {
    if (secret) die("Set either PUBLIC_URL (multi-user) or MCP_SECRET (single-user), not both");
    const allowPrivateNetwork = env.CANVAS_MCP_ALLOW_PRIVATE_NETWORK === "1";
    // Throws (and so dies with) a clear message for a short CANVAS_MCP_KEY or a bad CANVAS_MCP_REDIRECT_HOSTS.
    const app = createPublicApp({
      publicUrl: publicOrigin(env.PUBLIC_URL), key: env.CANVAS_MCP_KEY ?? "", redirectOrigins: parseRedirectOrigins(env.CANVAS_MCP_REDIRECT_HOSTS),
      trustProxy: env.TRUST_PROXY || "loopback, linklocal, uniquelocal", allowPrivateNetwork, maxChars: opts.maxChars,
    });
    if (allowPrivateNetwork) console.error("WARNING: private network access enabled — testing only");
    startPublicHttp(app, port, host);
    return;
  }
  const { baseUrl, canvas } = canvasFromArgs();
  if (!secret || secret.length < 24) die("HTTP mode needs --secret / MCP_SECRET of at least 24 chars (try: openssl rand -hex 24)");
  startSecretHttp({ secret, port, host, baseUrl, make: () => buildServer(canvas, opts) });
}

(a.check ? check() : a.http ? http() : stdio()).catch((e) => die(e?.message ?? String(e)));
