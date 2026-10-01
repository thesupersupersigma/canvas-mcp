#!/usr/bin/env node
import { createServer, IncomingMessage } from "node:http";
import { parseArgs } from "node:util";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CanvasClient } from "./canvas.js";
import { registerPrompts, registerTools } from "./tools.js";

const VERSION = "1.0.0";

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
  --port <n>           HTTP port (default 3000)                               [PORT]
  --host <addr>        HTTP bind address (default 0.0.0.0)                    [HOST]
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
const baseUrl = a.url ?? env.CANVAS_BASE_URL ?? env.CANVAS_URL;
const token = a.token ?? env.CANVAS_API_TOKEN ?? env.CANVAS_TOKEN;
const die = (m: string) => { console.error(`canvas-mcp: ${m}\nRun with --help for usage.`); process.exit(1); };
if (!baseUrl) die("Missing Canvas URL (--url or CANVAS_BASE_URL), e.g. https://yourschool.instructure.com");
if (!token) die("Missing Canvas token (CANVAS_API_TOKEN)");

const timeZone = a.tz ?? env.CANVAS_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const maxChars = Number(a["max-chars"] ?? env.CANVAS_MAX_CHARS ?? 20000);
const canvas = new CanvasClient({ baseUrl: baseUrl!, token: token! });

function buildServer() {
  const server = new McpServer(
    { name: "canvas", version: VERSION },
    {
      instructions:
        "Read-only access to the user's Canvas LMS (they are a student). Start with list_courses to get course ids, or get_upcoming " +
        "for what's due. To study for a test, check list_announcements and get_syllabus for what it covers, then use search_course " +
        "and list_modules to find the material, then actually read it with get_page or read_file before you answer. " +
        "Base explanations on the teacher's material and say which file or page you used. Help the student learn the content " +
        "(explain, quiz, outline) rather than writing graded work for them to hand in.",
    },
  );
  registerTools(server, canvas, { timeZone, maxChars });
  registerPrompts(server);
  return server;
}

async function check() {
  const me = await canvas.get("/users/self");
  const courses = await canvas.getAll("/courses", { enrollment_state: "active" });
  console.log(`✓ Authenticated as ${me.name} (id ${me.id})`);
  console.log(`✓ ${courses.length} active course(s):`);
  for (const c of courses) if (c.name) console.log(`   ${c.id}  ${c.name}`);
}

async function stdio() {
  await buildServer().connect(new StdioServerTransport());
  console.error(`canvas-mcp ${VERSION} running on stdio → ${baseUrl}`);
}

async function http() {
  const secret = a.secret ?? env.MCP_SECRET;
  if (!secret || secret.length < 24) die("HTTP mode needs --secret / MCP_SECRET of at least 24 chars (try: openssl rand -hex 24)");
  const port = Number(a.port ?? env.PORT ?? 3000);
  const host = a.host ?? env.HOST ?? "0.0.0.0";
  const expected = Buffer.from(`/mcp/${secret}`);

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (!chunks.length) return resolve(undefined);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); }
      });
      req.on("error", reject);
    });

  createServer(async (req, res) => {
    const path = Buffer.from((req.url ?? "").split("?")[0].replace(/\/+$/, ""));
    if (path.toString() === "/health") { res.writeHead(200).end("ok"); return; }
    if (path.length !== expected.length || !timingSafeEqual(path, expected)) { res.writeHead(404).end(); return; }
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream or sessions to delete.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    try {
      const body = await readBody(req);
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("request failed:", e);
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null }));
    }
  }).listen(port, host, () => {
    console.error(`canvas-mcp ${VERSION} HTTP on http://${host}:${port}/mcp/<secret>  → ${baseUrl}`);
  });
}

(a.check ? check() : a.http ? http() : stdio()).catch((e) => die(e?.message ?? String(e)));
