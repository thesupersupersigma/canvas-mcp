// Single-user HTTP mode: the MCP endpoint is /mcp/<secret>.
import { createServer, IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VERSION } from "./server.js";

/** For both HTTP modes. `docker stop` sends SIGTERM and kills the process 10 s later, and a Node process running as
 *  PID 1 has no default handler for it. On SIGTERM or SIGINT: stop accepting connections, give open requests up to
 *  `graceMs` (dropping each connection once its answer is out), then close whatever is left and exit 0. */
export function closeOnSignal(server: Server, graceMs = 5000): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.error(`canvas-mcp: ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // close() drops the idle keep-alive connections it finds; a connection whose answer goes out later is idle then.
    const idle = setInterval(() => server.closeIdleConnections(), 100);
    setTimeout(() => { clearInterval(idle); server.closeAllConnections(); process.exit(0); }, graceMs);
  };
  process.once("SIGTERM", stop).once("SIGINT", stop);
}

export function startSecretHttp(o: { secret: string; port: number; host: string; baseUrl: string; make: () => McpServer }): void {
  const { port, host } = o;
  const expected = Buffer.from(`/mcp/${o.secret}`);

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

  const server = createServer(async (req, res) => {
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
      const server = o.make();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("request failed:", e);
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null }));
    }
  });
  server.listen(port, host, () => {
    console.error(`canvas-mcp ${VERSION} HTTP on http://${host}:${port}/mcp/<secret>  → ${o.baseUrl}`);
  });
  closeOnSignal(server);
}
