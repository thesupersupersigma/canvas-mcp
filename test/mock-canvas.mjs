// Mock Canvas API shared by the integration tests. startMockCanvas(port) → { base, token, close, held, release, requests }.
// GET /api/v1/courses/999 is held open until release(), so tests can keep requests in flight; held() counts the ones
// whose connection is still open, requests() the API requests answered or held. Besides `token`, any `${token}-<digits>`
// is accepted, for tests that need several logins. { courses: n } makes /courses list n courses, 100 per page.
import http from "node:http";
import fs from "node:fs";
import { makeDocx, makeZip } from "./make-zip.mjs";

const S = new URL("./fixtures", import.meta.url).pathname;
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
    "/api/v1/calendar_events": [],
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
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(BOMBS[id] ?? fs.readFileSync(`${S}/${id === "900" ? "notes.pdf" : "etc.pptx"}`));
      return;
    }
    if (!AUTHORIZED.test(req.headers.authorization ?? "")) { res.writeHead(401).end('{"errors":[{"message":"Invalid access token."}]}'); return; }
    requests++;
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
