#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CanvasClient } from "./canvas.js";
import { buildServer, VERSION } from "./server.js";
import { startSecretHttp } from "./http.js";

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
  --secret <s>         Required in HTTP mode: endpoint becomes /mcp/<secret>  [MCP_SECRET]
  --check              Verify credentials and exit
  -v, --version
  -h, --help
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

async function http() {
  const port = Number(a.port ?? env.CANVAS_MCP_PORT ?? 7341);
  const host = a.host ?? env.CANVAS_MCP_HOST ?? "127.0.0.1";
  const { baseUrl, canvas } = canvasFromArgs();
  const secret = a.secret ?? env.MCP_SECRET;
  if (!secret || secret.length < 24) die("HTTP mode needs --secret / MCP_SECRET of at least 24 chars (try: openssl rand -hex 24)");
  startSecretHttp({ secret, port, host, baseUrl, make: () => buildServer(canvas, opts) });
}

(a.check ? check() : a.http ? http() : stdio()).catch((e) => die(e?.message ?? String(e)));
