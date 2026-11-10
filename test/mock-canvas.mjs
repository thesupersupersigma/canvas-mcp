// Mock Canvas API shared by the integration tests. startMockCanvas(port) → { base, token, close, held, release, requests }.
// GET /api/v1/courses/999 is held open until release(), so tests can keep requests in flight; held() counts the ones
// whose connection is still open, requests() the API requests answered or held. Besides `token`, any `${token}-<digits>`
// is accepted, for tests that need several logins. { courses: n } makes /courses list n courses, 100 per page.
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { makeDocx, makeZip } from "./make-zip.mjs";

const S = fileURLToPath(new URL("./fixtures", import.meta.url));
const TOKEN = "test-token";
const AUTHORIZED = new RegExp(`^Bearer ${TOKEN}(-\\d+)?$`);
const MiB = 1024 * 1024;
// Zip bombs, about 17 kB each: one entry inflates to 17 MiB, past read_file's 16 MiB per entry.
const BOMBS = {
  903: makeZip([["ppt/slides/slide1.xml", Buffer.alloc(17 * MiB, 0x20)]]),
  904: makeDocx([], { document: Buffer.alloc(17 * MiB, 0x20) }),
};
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function startMockCanvas(port, { courses } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const now = Date.now();
  const iso = (d) => new Date(now + d * 864e5).toISOString();
  const page = (u) => Number(u.searchParams.get("page") ?? 1);

  const routes = {
    "/api/v1/users/self": { id: 1, name: "Super Test" },
    "/api/v1/courses": (u) => courses
      ? Array.from({ length: Math.min(100, courses - (page(u) - 1) * 100) }, (_, i) => ({ id: String((page(u) - 1) * 100 + i + 1), name: `Course ${(page(u) - 1) * 100 + i + 1}` }))
      : page(u) === 2
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
    "/api/v1/files/903": { id: "903", display_name: "bomb.pptx", "content-type": PPTX, size: BOMBS[903].length, url: base + "/download/903" },
    "/api/v1/files/904": { id: "904", display_name: "bomb.docx", "content-type": DOCX, size: BOMBS[904].length, url: base + "/download/904" },
    // One API page of 17 MiB, past the 16 MiB a multi-user request reads per page.
    "/api/v1/courses/104/pages": () => [{ title: "Huge", url: "huge", updated_at: iso(-1), body: "x".repeat(17 * MiB) }],
    "/api/v1/calendar_events": (u) => u.searchParams.get("type") === "assignment"
      ? [{ title: "Lab 4", start_at: iso(2), context_code: "course_102", assignment: { id: "55", due_at: iso(2) } }]
      : [
          { title: "4.2 Factoring By Grouping", start_at: "2026-09-29T04:00:00Z", all_day: true, context_code: "course_101", description: "<p>Notes p. 12</p>" },
          { title: "Unit 4 Test", start_at: "2026-10-06T04:00:00Z", all_day: true, context_code: "course_102" },
          { title: "Review session", start_at: "2026-10-05T19:30:00Z", all_day: false, context_code: "course_102", location_name: "Room 210" },
        ],
    // Scanned (no text layer) and mixed PDFs, for page images.
    "/api/v1/files/910": { id: "910", display_name: "Study Guide Key.pdf", "content-type": "application/pdf", size: 9000, url: base + "/download/910" },
    "/api/v1/files/911": { id: "911", display_name: "mixed.pdf", "content-type": "application/pdf", size: 9000, url: base + "/download/911" },
    // Course 101 hides its Files tab (403 below), so files are found through modules, assignments and pages.
    "/api/v1/courses/101": { id: "101", name: "APUSH", syllabus_body: "" },
    "/api/v1/courses/101/modules": [{ id: "7", name: "Unit 2", items: [{ type: "File", title: "Unit 2 Study Guide.docx", content_id: "905" }] }],
    "/api/v1/courses/101/assignments": [{ id: "80", name: "CHEM: Review", description: '<p>Study guide: <a class="instructure_file_link" title="Unit 2 Study Guide.docx" href="https://x/courses/101/files/905?wrap=1" data-api-endpoint="https://x/api/v1/courses/101/files/905">Unit 2 Study Guide.docx</a> and <a href="/courses/101/files/910/download">Study Guide Key.pdf</a></p>' }],
    "/api/v1/courses/101/assignments/80": { name: "CHEM: Review", points_possible: 0, description: '<p>Study guide: <a class="instructure_file_link" title="Unit 2 Study Guide.docx" href="https://x/courses/101/files/905?wrap=1">Unit 2 Study Guide.docx</a> and <a href="/courses/101/files/910/download">Study Guide Key.pdf</a></p>' },
    "/api/v1/courses/101/pages": [{ title: "Notes", url: "notes" }],
    "/api/v1/courses/101/pages/notes": { title: "Notes", body: '<p>Slides: <a href="/courses/101/files/906">Ions slides.pptx</a></p>' },
    "/api/v1/announcements": [{ title: "Test moved", context_code: "course_102", posted_at: iso(-1), author: { display_name: "Ms. K" }, message: "<p>Unit 4 test is now <em>Tuesday</em>.</p>" }],
    "/api/v1/courses/102/quizzes": [{ id: "9", title: "Unit 4 Test", due_at: iso(5), question_count: 30, time_limit: 50, allowed_attempts: 1 }],
    "/api/v1/courses/102/discussion_topics": [{ id: "5", title: "ATP debate", discussion_subentry_count: 2 }],
    "/api/v1/courses/102/discussion_topics/5": { title: "ATP debate", message: "<p>Why is ATP the energy currency?</p>" },
    "/api/v1/courses/102/discussion_topics/5/view": { participants: [{ id: 7, display_name: "Alex" }], view: [{ user_id: 7, message: "<p>Phosphate bonds</p>", replies: [{ user_id: 7, message: "also hydrolysis" }] }] },
  };

  const parked = [];
  let requests = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname.startsWith("/download/")) {
      const id = u.pathname.slice("/download/".length);
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(BOMBS[id] ?? fs.readFileSync(`${S}/${{ 900: "notes.pdf", 910: "scanned.pdf", 911: "mixed.pdf" }[id] ?? "etc.pptx"}`));
      return;
    }
    if (!AUTHORIZED.test(req.headers.authorization ?? "")) { res.writeHead(401).end('{"errors":[{"message":"Invalid access token."}]}'); return; }
    requests++;
    if (u.pathname === "/api/v1/courses/101/files") { res.writeHead(403).end('{"status":"unauthorized"}'); return; }
    if (u.pathname === "/api/v1/courses/999") {
      parked.push(res);
      res.on("close", () => parked.includes(res) && parked.splice(parked.indexOf(res), 1));
      return;
    }
    const r = routes[u.pathname];
    if (!r) { res.writeHead(404).end('{"errors":[{"message":"The specified resource does not exist."}]}'); return; }
    const headers = { "content-type": "application/json" };
    if (u.pathname === "/api/v1/courses" && (courses ? page(u) * 100 < courses : page(u) !== 2))
      headers.link = `<${base}/api/v1/courses?page=${page(u) + 1}&per_page=100>; rel="next"`;
    res.writeHead(200, headers).end(JSON.stringify(typeof r === "function" ? r(u) : r));
  });
  await new Promise((r) => server.listen(port, r));

  return {
    base,
    token: TOKEN,
    held: () => parked.length,
    requests: () => requests,
    release: () => {
      for (const res of parked.splice(0))
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "999", name: "Held course", syllabus_body: "<p>Held</p>" }));
    },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
