// Mock Canvas API + MCP client test harness.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { CanvasClient } from "../dist/canvas.js";
import { startMockCanvas } from "./mock-canvas.mjs";

const mock = await startMockCanvas(4555);
const { base, token: TOKEN } = mock;

// CanvasClient routes every request through an injected fetch.
const seen = [];
const spy = new CanvasClient({ baseUrl: base, token: TOKEN, fetch: (u, i) => (seen.push(String(u)), fetch(u, i)) });
assert.equal((await spy.get("/users/self")).id, 1);
await spy.download(base + "/download/900");
assert.deepEqual(seen, [base + "/api/v1/users/self", base + "/download/900"]);

const results = [];
async function run(client, label) {
  const tools = await client.listTools();
  results.push(`[${label}] ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);
  const prompts = await client.listPrompts();
  results.push(`[${label}] prompts: ${prompts.prompts.map((p) => p.name).join(", ")}`);
  const calls = label === "stdio" ? [
    ["list_courses", {}], ["get_syllabus", { course_id: 102 }], ["get_upcoming", {}],
    ["list_assignments", { course_id: "102" }], ["get_assignment", { course_id: "102", assignment_id: "55" }],
    ["get_grades", { course_id: "102" }], ["list_modules", { course_id: "102" }], ["get_page", { course_id: "102", page_url: "glycolysis-notes" }],
    ["list_files", { course_id: "102" }], ["read_file", { file_id: "900" }], ["read_file", { file_id: "901" }], ["read_file", { file_id: "902" }],
    ["list_announcements", {}], ["list_quizzes", { course_id: "102" }], ["get_discussion", { course_id: "102", topic_id: "5" }],
    ["search_course", { course_id: "102", query: "unit 4" }],
    ["read_file", { file_id: "910" }], ["read_file", { file_id: "911" }], ["read_file", { file_id: "911", pages: "1", as_images: true }],
    ["get_assignment", { course_id: "101", assignment_id: "80" }], ["list_files", { course_id: "101", search: "study" }],
    ["search_course", { course_id: "101", query: "slides" }],
    ["get_calendar", { start_date: "2026-09-01", end_date: "2026-10-31", include_assignments: true }], ["get_calendar", { search: "test" }], ["get_page", { course_id: "102", page_url: "nope" }],
    ["search", { query: "unit 4" }], ["fetch", { id: "page:102:glycolysis-notes" }], ["fetch", { id: "file:102:900" }],
    ["fetch", { id: "assignment:102:55" }], ["fetch", { id: "bogus" }],
  ] : [["list_courses", {}], ["search", { query: "glycolysis" }]];
  for (const [name, args] of calls) {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    const imgs = r.content.filter((c) => c.type === "image");
    imgs.forEach((im, k) => fs.writeFileSync(`${process.env.IMG_OUT ?? os.tmpdir()}/${name}-${k}.jpg`, Buffer.from(im.data, "base64")));
    results.push(`
=== ${label}:${name} ${JSON.stringify(args)}${r.isError ? " [isError]" : ""}${imgs.length ? ` [${imgs.length} image(s), ${imgs.map((i) => Math.round(i.data.length * 0.75 / 1024) + "KB").join(" ")}]` : ""}
${text.slice(0, 700)}`);
    const expectError = (name === "read_file" && args.file_id === "902") || (name === "get_page" && args.page_url === "nope") || (name === "fetch" && args.id === "bogus");
    assert.equal(!!r.isError, expectError, `${label}:${name} ${JSON.stringify(args)} isError`);
    if (name === "list_courses") for (const c of ["APUSH", "AP Bio"]) assert.ok(text.includes(c), `${label}:list_courses lists ${c}`);
  }
}

const env = { ...process.env, CANVAS_BASE_URL: base, CANVAS_API_TOKEN: TOKEN, CANVAS_TZ: "America/New_York" };
let srv;
try {
  const stdioClient = new Client({ name: "t", version: "1" });
  await stdioClient.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env }));
  await run(stdioClient, "stdio");
  await stdioClient.close();

  const secret = "a".repeat(32);
  srv = spawn("node", ["dist/index.js", "--http", "--port", "4556", "--secret", secret], { env });
  await new Promise((r) => setTimeout(r, 800));
  const h = new Client({ name: "t", version: "1" });
  await h.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:4556/mcp/${secret}`)));
  await run(h, "http");
  const wrong = await fetch("http://127.0.0.1:4556/mcp/wrongsecret", { method: "POST" });
  const health = (await fetch("http://127.0.0.1:4556/health")).status;
  results.push(`\n[http] wrong secret -> ${wrong.status}; health -> ${health}`);
  assert.equal(wrong.status, 404);
  assert.equal(health, 200);
  await h.close();

  // Windows can't send signals: kill() there ends the process outright, so this only runs elsewhere.
  if (process.platform !== "win32") {
    // SIGTERM (docker stop) while a request is stuck at Canvas: the server gives it a few seconds, then closes it and
    // exits 0, before the 10 s docker waits ahead of SIGKILL.
    const exit = new Promise((resolve) => srv.on("exit", (code, signal) => resolve({ code, signal })));
    const stuck = fetch(`http://127.0.0.1:4556/mcp/${secret}`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_syllabus", arguments: { course_id: 999 } } }),
    }).then(() => "answered", () => "cut off");
    for (const end = Date.now() + 5000; mock.held() < 1; await new Promise((r) => setTimeout(r, 20)))
      if (Date.now() > end) throw new Error("the request never reached the mock Canvas");
    const stopped = Date.now();
    srv.kill("SIGTERM");
    assert.deepEqual(await exit, { code: 0, signal: null });
    const took = Date.now() - stopped;
    assert.ok(took < 9000, `exited ${took} ms after SIGTERM`);
    assert.equal(await stuck, "cut off");
    results.push(`\n[http] SIGTERM with a request stuck at Canvas -> exit 0 after ${took} ms`);
  }
} finally {
  console.log(results.join("\n"));
  srv?.kill();
  await mock.close();
}
