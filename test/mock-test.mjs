// Mock Canvas API + MCP client test harness.
import http from "node:http";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const S = new URL("./fixtures", import.meta.url).pathname;
const TOKEN = "test-token";
const base = "http://127.0.0.1:4555";
const now = Date.now();
const iso = (d) => new Date(now + d * 864e5).toISOString();

const routes = {
  "/api/v1/users/self": { id: 1, name: "Super Test" },
  "/api/v1/courses": (u) =>
    u.searchParams.get("page") === "2"
      ? [{ id: "102", name: "AP Bio", course_code: "BIO", term: { name: "Fall" }, enrollments: [{ type: "student", computed_current_grade: "A-", computed_current_score: 91.2 }] }]
      : [{ id: "101", name: "APUSH", course_code: "HIST", term: { name: "Fall" }, enrollments: [{ type: "student", computed_current_grade: "B+", computed_current_score: 88 }] }],
  "/api/v1/courses/102": { id: "102", name: "AP Bio", syllabus_body: "<h1>Syllabus</h1><p>Tests are <b>40%</b>.</p>", teachers: [{ display_name: "Ms. K" }], apply_assignment_group_weights: true, enrollments: [{ type: "student", computed_current_grade: "A-", computed_current_score: 91.2, computed_final_score: 80 }] },
  "/api/v1/planner/items": [
    { plannable_type: "assignment", plannable: { title: "Lab 4", points_possible: 20 }, context_name: "AP Bio", course_id: "102", plannable_date: iso(2), plannable_id: "55", submissions: { submitted: false, missing: false } },
    { plannable_type: "quiz", plannable: { title: "Unit 4 Test", assignment_id: "77" }, context_name: "AP Bio", course_id: "102", plannable_date: iso(5), plannable_id: "9", submissions: { submitted: false } },
    { plannable_type: "calendar_event", plannable: { title: "Review session" }, context_name: "AP Bio", course_id: "102", plannable_date: iso(4), plannable_id: "3", submissions: false },
  ],
  "/api/v1/courses/102/assignments": [{ id: "55", name: "Lab 4", due_at: iso(2), points_possible: 20, submission_types: ["online_upload"], submission: { workflow_state: "unsubmitted", missing: false } }],
  "/api/v1/courses/102/assignments/55": { name: "Lab 4", due_at: iso(2), points_possible: 20, description: "<p>Measure CO<sub>2</sub> output.</p>", rubric: [{ id: "r1", description: "Data", points: 10, ratings: [{ points: 10, description: "Complete" }] }], html_url: "x" },
  "/api/v1/courses/102/assignments/55/submissions/self": { workflow_state: "graded", score: 18, grade: "18", rubric_assessment: { r1: { points: 8, comments: "missing units" } }, submission_comments: [{ author_name: "Ms. K", comment: "Label axes!" }] },
  "/api/v1/courses/102/assignment_groups": [{ name: "Tests", group_weight: 40, rules: { drop_lowest: 1 }, assignments: [{ name: "Unit 3 Test", points_possible: 100, submission: { score: 85 } }] }],
  "/api/v1/courses/102/modules": [{ id: "1", name: "Unit 4: Cellular Respiration", state: "unlocked", items: [{ type: "Page", title: "Glycolysis notes", page_url: "glycolysis-notes" }, { type: "File", title: "notes.pdf", content_id: "900" }, { type: "File", title: "etc.pptx", content_id: "901" }] }],
  "/api/v1/courses/102/pages": [{ title: "Glycolysis notes", url: "glycolysis-notes", updated_at: iso(-3) }],
  "/api/v1/courses/102/pages/glycolysis-notes": { title: "Glycolysis notes", body: "<p>Glucose → 2 pyruvate, net <strong>2 ATP</strong>.</p><img src='x.png'>" },
  "/api/v1/courses/102/files": [{ id: "900", display_name: "notes.pdf", mime_class: "pdf", size: 1893, updated_at: iso(-1) }],
  "/api/v1/files/900": { id: "900", display_name: "notes.pdf", "content-type": "application/pdf", size: 1893, url: base + "/download/900" },
  "/api/v1/files/901": { id: "901", display_name: "etc.pptx", "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 32930, url: base + "/download/901" },
  "/api/v1/files/902": { id: "902", display_name: "locked.pdf", locked_for_user: true, lock_explanation: "<p>Unlocks Friday</p>" },
  "/api/v1/announcements": [{ title: "Test moved", context_code: "course_102", posted_at: iso(-1), author: { display_name: "Ms. K" }, message: "<p>Unit 4 test is now <em>Tuesday</em>.</p>" }],
  "/api/v1/courses/102/quizzes": [{ id: "9", title: "Unit 4 Test", due_at: iso(5), question_count: 30, time_limit: 50, allowed_attempts: 1 }],
  "/api/v1/courses/102/discussion_topics": [{ id: "5", title: "ATP debate", discussion_subentry_count: 2 }],
  "/api/v1/courses/102/discussion_topics/5": { title: "ATP debate", message: "<p>Why is ATP the energy currency?</p>" },
  "/api/v1/courses/102/discussion_topics/5/view": { participants: [{ id: 7, display_name: "Alex" }], view: [{ user_id: 7, message: "<p>Phosphate bonds</p>", replies: [{ user_id: 7, message: "also hydrolysis" }] }] },
};

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, base);
  if (u.pathname.startsWith("/download/")) {
    const f = u.pathname.endsWith("900") ? "notes.pdf" : "etc.pptx";
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(fs.readFileSync(`${S}/${f}`));
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end('{"errors":[{"message":"Invalid access token."}]}'); return; }
  const r = routes[u.pathname];
  if (!r) { res.writeHead(404).end('{"errors":[{"message":"The specified resource does not exist."}]}'); return; }
  const headers = { "content-type": "application/json" };
  if (u.pathname === "/api/v1/courses" && u.searchParams.get("page") !== "2") headers.link = `<${base}/api/v1/courses?page=2&per_page=100>; rel="next"`;
  res.writeHead(200, headers).end(JSON.stringify(typeof r === "function" ? r(u) : r));
});
await new Promise((r) => mock.listen(4555, r));

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
    ["search_course", { course_id: "102", query: "unit 4" }], ["get_page", { course_id: "102", page_url: "nope" }],
  ] : [["list_courses", {}]];
  for (const [name, args] of calls) {
    const r = await client.callTool({ name, arguments: args });
    results.push(`\n=== ${label}:${name} ${JSON.stringify(args)}${r.isError ? " [isError]" : ""}\n${r.content[0].text.slice(0, 700)}`);
  }
}

const env = { ...process.env, CANVAS_BASE_URL: base, CANVAS_API_TOKEN: TOKEN, CANVAS_TZ: "America/Indianapolis" };
const stdioClient = new Client({ name: "t", version: "1" });
await stdioClient.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env }));
await run(stdioClient, "stdio");
await stdioClient.close();

const secret = "a".repeat(32);
const srv = spawn("node", ["dist/index.js", "--http", "--port", "4556", "--secret", secret], { env });
await new Promise((r) => setTimeout(r, 800));
const h = new Client({ name: "t", version: "1" });
await h.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:4556/mcp/${secret}`)));
await run(h, "http");
const wrong = await fetch("http://127.0.0.1:4556/mcp/wrongsecret", { method: "POST" });
results.push(`\n[http] wrong secret -> ${wrong.status}; health -> ${(await fetch("http://127.0.0.1:4556/health")).status}`);
await h.close(); srv.kill();
console.log(results.join("\n"));
mock.close();
