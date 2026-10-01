import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CanvasClient } from "./canvas.js";
import { extractFileText, htmlToText, truncate } from "./extract.js";

export interface ToolOptions {
  timeZone: string;
  maxChars: number;
}

const courseId = z.union([z.string(), z.number()]).transform(String).describe("Canvas course id (from list_courses)");

export function registerTools(server: McpServer, canvas: CanvasClient, opts: ToolOptions) {
  const fmt = (iso?: string | null) => {
    if (!iso) return null;
    return new Date(iso).toLocaleString("en-US", {
      timeZone: opts.timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  };
  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }],
  });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: String((e as Error)?.message ?? e) }] });
  const safe = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
    try { return ok(await fn(a)); } catch (e) { return fail(e); }
  };
  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  // ---------- Courses ----------
  server.registerTool("list_courses", {
    title: "List courses",
    description: "List the student's Canvas courses with ids and current grades. Call this first to get course ids.",
    inputSchema: { include_past: z.boolean().default(false).describe("Also include completed/past courses") },
    annotations: ro,
  }, safe(async ({ include_past }) => {
    const courses = await canvas.getAll("/courses", {
      enrollment_state: include_past ? undefined : "active",
      include: ["term", "total_scores"],
    });
    return courses
      .filter((c: any) => c.name)
      .map((c: any) => {
        const e = c.enrollments?.find((x: any) => x.type === "student") ?? c.enrollments?.[0];
        return {
          id: c.id, name: c.name, code: c.course_code, term: c.term?.name,
          grade: e?.computed_current_grade ?? null, score: e?.computed_current_score ?? null,
        };
      });
  }));

  server.registerTool("get_syllabus", {
    title: "Get syllabus",
    description: "Get a course's syllabus page as text (grading policy, schedule, exam dates, etc.).",
    inputSchema: { course_id: courseId },
    annotations: ro,
  }, safe(async ({ course_id }) => {
    const c = await canvas.get(`/courses/${course_id}`, { include: ["syllabus_body", "teachers"] });
    return {
      course: c.name,
      teachers: c.teachers?.map((t: any) => t.display_name),
      syllabus: htmlToText(c.syllabus_body, opts.maxChars) || "(No syllabus text on Canvas. Check list_files or list_modules for a syllabus PDF.)",
    };
  }));

  // ---------- What's due ----------
  server.registerTool("get_upcoming", {
    title: "What's due / coming up",
    description:
      "Everything coming up across all courses: assignments, quizzes, tests, discussions and calendar events, " +
      "with submission status. Use for 'what's due this week', 'when is my next test', and similar questions.",
    inputSchema: {
      days_ahead: z.number().int().min(1).max(120).default(14),
      days_back: z.number().int().min(0).max(60).default(3).describe("Also include recently-past items (catches overdue work)"),
    },
    annotations: ro,
  }, safe(async ({ days_ahead, days_back }) => {
    const now = Date.now();
    const items = await canvas.getAll("/planner/items", {
      start_date: new Date(now - days_back * 864e5).toISOString(),
      end_date: new Date(now + days_ahead * 864e5).toISOString(),
    });
    return items.map((i: any) => {
      const s = i.submissions || {};
      const status = s.graded ? "graded" : s.submitted ? "submitted" : s.missing ? "MISSING" : s.late ? "late" :
        i.plannable_type === "calendar_event" || i.plannable_type === "announcement" ? undefined : "not submitted";
      return {
        type: i.plannable_type, title: i.plannable?.title, course: i.context_name, course_id: i.course_id,
        due: fmt(i.plannable_date), points: i.plannable?.points_possible, status,
        id: i.plannable_id, assignment_id: i.plannable?.assignment_id,
      };
    });
  }));

  // ---------- Assignments ----------
  server.registerTool("list_assignments", {
    title: "List assignments",
    description: "List assignments in a course with due dates, points, and your submission status/score.",
    inputSchema: {
      course_id: courseId,
      bucket: z.enum(["upcoming", "past", "overdue", "undated", "ungraded", "unsubmitted", "future"]).optional()
        .describe("Optional filter"),
      search: z.string().optional().describe("Filter by name, e.g. 'chapter 5' or 'lab'"),
    },
    annotations: ro,
  }, safe(async ({ course_id, bucket, search }) => {
    const list = await canvas.getAll(`/courses/${course_id}/assignments`, {
      bucket, search_term: search, include: ["submission"], order_by: "due_at",
    });
    return list.map((a: any) => ({
      id: a.id, name: a.name, due: fmt(a.due_at), points: a.points_possible,
      types: a.submission_types, is_quiz: a.is_quiz_assignment || a.submission_types?.includes("online_quiz") || undefined,
      status: a.submission?.workflow_state, score: a.submission?.score ?? null, missing: a.submission?.missing || undefined,
    }));
  }));

  server.registerTool("get_assignment", {
    title: "Get assignment details",
    description: "Full instructions for one assignment, plus the rubric, your submission, your grade, and teacher feedback comments.",
    inputSchema: { course_id: courseId, assignment_id: z.union([z.string(), z.number()]).transform(String) },
    annotations: ro,
  }, safe(async ({ course_id, assignment_id }) => {
    const [a, sub] = await Promise.all([
      canvas.get(`/courses/${course_id}/assignments/${assignment_id}`),
      canvas.get(`/courses/${course_id}/assignments/${assignment_id}/submissions/self`, {
        include: ["submission_comments", "rubric_assessment"],
      }).catch(() => null),
    ]);
    return {
      name: a.name, due: fmt(a.due_at), lock_at: fmt(a.lock_at), points: a.points_possible,
      submission_types: a.submission_types, allowed_extensions: a.allowed_extensions,
      instructions: htmlToText(a.description, opts.maxChars) || "(no description)",
      rubric: a.rubric?.map((r: any) => ({
        criterion: r.description, details: r.long_description || undefined, points: r.points,
        ratings: r.ratings?.map((x: any) => `${x.points}: ${x.description}`),
        my_score: sub?.rubric_assessment?.[r.id]?.points, my_comment: sub?.rubric_assessment?.[r.id]?.comments || undefined,
      })),
      my_submission: sub && {
        state: sub.workflow_state, submitted: fmt(sub.submitted_at), late: sub.late, missing: sub.missing,
        score: sub.score, grade: sub.grade, attempt: sub.attempt,
        feedback: sub.submission_comments?.map((c: any) => `${c.author_name}: ${c.comment}`),
      },
      url: a.html_url,
    };
  }));

  // ---------- Grades ----------
  server.registerTool("get_grades", {
    title: "Get grades",
    description:
      "Grade breakdown for a course: assignment groups with their weights, and every graded item. " +
      "Use it for 'what's my grade', 'what do I need on the final', and 'where am I losing points'.",
    inputSchema: { course_id: courseId },
    annotations: ro,
  }, safe(async ({ course_id }) => {
    const [course, groups] = await Promise.all([
      canvas.get(`/courses/${course_id}`, { include: ["total_scores"] }),
      canvas.getAll(`/courses/${course_id}/assignment_groups`, { include: ["assignments", "submission"] }),
    ]);
    const e = course.enrollments?.find((x: any) => x.type === "student");
    return {
      course: course.name,
      current_grade: e?.computed_current_grade, current_score: e?.computed_current_score,
      final_score_if_ungraded_are_zero: e?.computed_final_score,
      weighted_groups: course.apply_assignment_group_weights ?? undefined,
      groups: groups.map((g: any) => ({
        name: g.name, weight: g.group_weight, drop_lowest: g.rules?.drop_lowest, drop_highest: g.rules?.drop_highest,
        items: g.assignments?.map((a: any) => ({
          name: a.name, score: a.submission?.score ?? null, out_of: a.points_possible,
          due: fmt(a.due_at), missing: a.submission?.missing || undefined, excused: a.submission?.excused || undefined,
          omit_from_final: a.omit_from_final_grade || undefined,
        })),
      })),
    };
  }));

  // ---------- Modules / pages ----------
  server.registerTool("list_modules", {
    title: "List modules",
    description:
      "A course's modules (units/weeks) and the items inside them. This is usually the best map of what was taught. " +
      "Each item gives the id you need for get_page (Page → page_url), read_file (File → content_id), " +
      "get_assignment (Assignment → content_id), or get_discussion (Discussion → content_id).",
    inputSchema: { course_id: courseId, search: z.string().optional().describe("Filter modules/items by name") },
    annotations: ro,
  }, safe(async ({ course_id, search }) => {
    const mods = await canvas.getAll(`/courses/${course_id}/modules`, { include: ["items"], search_term: search });
    return mods.map((m: any) => ({
      module: m.name, id: m.id, state: m.state,
      items: (m.items ?? []).filter((i: any) => i.type !== "SubHeader" || i.title).map((i: any) => ({
        type: i.type, title: i.title, content_id: i.content_id, page_url: i.page_url, external_url: i.external_url,
      })),
    }));
  }));

  server.registerTool("list_pages", {
    title: "List pages",
    description: "List wiki pages in a course (notes, readings, study guides the teacher wrote in Canvas).",
    inputSchema: { course_id: courseId, search: z.string().optional() },
    annotations: ro,
  }, safe(async ({ course_id, search }) => {
    const pages = await canvas.getAll(`/courses/${course_id}/pages`, { search_term: search, sort: "updated_at", order: "desc" });
    return pages.map((p: any) => ({ title: p.title, page_url: p.url, updated: fmt(p.updated_at) }));
  }));

  server.registerTool("get_page", {
    title: "Read page",
    description: "Read the full text of a Canvas page.",
    inputSchema: { course_id: courseId, page_url: z.string().describe("page_url slug from list_pages/list_modules, or a page id") },
    annotations: ro,
  }, safe(async ({ course_id, page_url }) => {
    const p = await canvas.get(`/courses/${course_id}/pages/${encodeURIComponent(page_url)}`);
    return `# ${p.title}\n\n${htmlToText(p.body, opts.maxChars)}`;
  }));

  // ---------- Files ----------
  server.registerTool("list_files", {
    title: "List files",
    description: "List or search files uploaded to a course (slides, PDFs, worksheets, study guides).",
    inputSchema: {
      course_id: courseId,
      search: z.string().optional().describe("Search by filename (at least 2 characters)"),
      sort: z.enum(["updated_at", "name"]).default("updated_at"),
    },
    annotations: ro,
  }, safe(async ({ course_id, search, sort }) => {
    const files = await canvas.getAll(`/courses/${course_id}/files`, {
      search_term: search && search.length >= 2 ? search : undefined, sort, order: sort === "updated_at" ? "desc" : "asc",
    }, 3);
    return files.map((f: any) => ({
      id: f.id, name: f.display_name, type: f.mime_class, size_kb: Math.round(f.size / 1024), updated: fmt(f.updated_at),
    }));
  }));

  const fileCache = new Map<string, { name: string; kind: string; text: string }>();
  server.registerTool("read_file", {
    title: "Read file",
    description:
      "Download a course file and extract its text (PDF, DOCX, PPTX with speaker notes, HTML, text/code). " +
      "Long files come back in chunks; to keep reading, call again with the offset given at the end of the previous chunk.",
    inputSchema: {
      file_id: z.union([z.string(), z.number()]).transform(String),
      offset: z.number().int().min(0).default(0).describe("Character offset to start reading from"),
    },
    annotations: ro,
  }, safe(async ({ file_id, offset }) => {
    let doc = fileCache.get(file_id);
    if (!doc) {
      const meta = await canvas.get(`/files/${file_id}`);
      if (!meta.url) throw new Error(`File "${meta.display_name}" is locked or has no download link${meta.lock_explanation ? `: ${htmlToText(meta.lock_explanation)}` : ""}`);
      if (meta.size > 50 * 1024 * 1024) throw new Error(`File is ${Math.round(meta.size / 1048576)} MB; too large to read here.`);
      const { bytes, contentType } = await canvas.download(meta.url);
      const { text, kind } = await extractFileText(bytes, meta.display_name, meta["content-type"] || contentType);
      doc = { name: meta.display_name, kind, text };
      fileCache.set(file_id, doc);
      if (fileCache.size > 30) fileCache.delete(fileCache.keys().next().value!);
    }
    const chunk = doc.text.slice(offset, offset + opts.maxChars);
    const end = offset + chunk.length;
    const more = end < doc.text.length ? `\n\n…[${doc.text.length - end} more characters — call read_file with offset=${end}]` : "";
    return `# ${doc.name} (${doc.kind}, chars ${offset}-${end} of ${doc.text.length})\n\n${chunk}${more}`;
  }));

  // ---------- Announcements & discussions ----------
  server.registerTool("list_announcements", {
    title: "Announcements",
    description: "Recent announcements from teachers, across all courses or one course (test reminders, schedule changes).",
    inputSchema: {
      course_id: courseId.optional().describe("Omit to include all active courses"),
      days_back: z.number().int().min(1).max(365).default(21),
    },
    annotations: ro,
  }, safe(async ({ course_id, days_back }) => {
    let ids = course_id ? [course_id] : (await canvas.getAll("/courses", { enrollment_state: "active" })).map((c: any) => String(c.id));
    const anns = await canvas.getAll("/announcements", {
      context_codes: ids.map((id) => `course_${id}`),
      start_date: new Date(Date.now() - days_back * 864e5).toISOString(),
      end_date: new Date(Date.now() + 864e5).toISOString(),
    });
    return anns.map((a: any) => ({
      title: a.title, course_id: a.context_code?.replace("course_", ""), posted: fmt(a.posted_at), by: a.author?.display_name,
      message: htmlToText(a.message, 3000),
    }));
  }));

  server.registerTool("list_discussions", {
    title: "List discussions",
    description: "List discussion topics in a course.",
    inputSchema: { course_id: courseId, search: z.string().optional() },
    annotations: ro,
  }, safe(async ({ course_id, search }) => {
    const t = await canvas.getAll(`/courses/${course_id}/discussion_topics`, { search_term: search, order_by: "recent_activity" }, 3);
    return t.map((d: any) => ({
      id: d.id, title: d.title, posted: fmt(d.posted_at), replies: d.discussion_subentry_count,
      assignment_id: d.assignment_id ?? undefined, due: fmt(d.assignment?.due_at),
    }));
  }));

  server.registerTool("get_discussion", {
    title: "Read discussion",
    description: "Read a discussion prompt and its replies.",
    inputSchema: { course_id: courseId, topic_id: z.union([z.string(), z.number()]).transform(String) },
    annotations: ro,
  }, safe(async ({ course_id, topic_id }) => {
    const [topic, view] = await Promise.all([
      canvas.get(`/courses/${course_id}/discussion_topics/${topic_id}`),
      canvas.get(`/courses/${course_id}/discussion_topics/${topic_id}/view`).catch(() => null),
    ]);
    const names = new Map((view?.participants ?? []).map((p: any) => [p.id, p.display_name]));
    const flatten = (entries: any[] = [], depth = 0): string[] =>
      entries.flatMap((e) => [
        `${"  ".repeat(depth)}- ${names.get(e.user_id) ?? "someone"}: ${htmlToText(e.message, 1500)}`,
        ...flatten(e.replies, depth + 1),
      ]);
    return truncate(
      `# ${topic.title}\n\n${htmlToText(topic.message)}\n\n## Replies\n${flatten(view?.view).join("\n") || "(none visible — you may need to post first)"}`,
      opts.maxChars,
    );
  }));

  // ---------- Quizzes ----------
  server.registerTool("list_quizzes", {
    title: "List quizzes",
    description: "List quizzes/tests in a course with due dates, time limits, and attempts. (New Quizzes appear in list_assignments instead.)",
    inputSchema: { course_id: courseId },
    annotations: ro,
  }, safe(async ({ course_id }) => {
    const q = await canvas.getAll(`/courses/${course_id}/quizzes`).catch(() => []);
    return q.map((x: any) => ({
      id: x.id, title: x.title, due: fmt(x.due_at), points: x.points_possible, questions: x.question_count,
      time_limit_min: x.time_limit, attempts: x.allowed_attempts, type: x.quiz_type,
      description: htmlToText(x.description, 1500) || undefined,
    }));
  }));

  // ---------- Search ----------
  server.registerTool("search_course", {
    title: "Search course",
    description:
      "Find everything in a course related to a topic (e.g. 'photosynthesis', 'unit 3', 'midterm') " +
      "by searching the names of modules, pages, files, and assignments. Use this to gather material before making a study guide.",
    inputSchema: { course_id: courseId, query: z.string().min(2) },
    annotations: ro,
  }, safe(async ({ course_id, query }) => {
    const q = query.toLowerCase();
    const hit = (s?: string) => !!s && s.toLowerCase().includes(q);
    const [mods, pages, files, assigns] = await Promise.all([
      canvas.getAll(`/courses/${course_id}/modules`, { include: ["items"] }).catch(() => []),
      canvas.getAll(`/courses/${course_id}/pages`, { search_term: query }).catch(() => []),
      canvas.getAll(`/courses/${course_id}/files`, { search_term: query }, 2).catch(() => []),
      canvas.getAll(`/courses/${course_id}/assignments`, { search_term: query }).catch(() => []),
    ]);
    const moduleHits = mods.flatMap((m: any) =>
      hit(m.name)
        ? [{ module: m.name, items: m.items?.map((i: any) => ({ type: i.type, title: i.title, content_id: i.content_id, page_url: i.page_url })) }]
        : (m.items ?? []).filter((i: any) => hit(i.title)).map((i: any) => ({ module: m.name, type: i.type, title: i.title, content_id: i.content_id, page_url: i.page_url })),
    );
    return {
      modules: moduleHits,
      pages: pages.map((p: any) => ({ title: p.title, page_url: p.url })),
      files: files.map((f: any) => ({ id: f.id, name: f.display_name })),
      assignments: assigns.map((a: any) => ({ id: a.id, name: a.name, due: fmt(a.due_at) })),
    };
  }));
}

// ---------- Prompts (show up as slash-commands / templates in Claude clients) ----------
export function registerPrompts(server: McpServer) {
  server.registerPrompt("study_guide", {
    title: "Make a study guide",
    description: "Build a study guide for an upcoming test from your actual course materials",
    argsSchema: { course: z.string().describe("Course name"), topic: z.string().describe("Test or unit, e.g. 'Unit 4 test'") },
  }, ({ course, topic }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Make me a study guide for "${topic}" in my ${course} class. Use the Canvas tools: find the course, ` +
          `check announcements and the syllabus for what the test covers, use search_course / list_modules to find the matching ` +
          `material, and actually read the relevant pages and files. Organize it as: what the test covers, key terms/definitions, ` +
          `main concepts explained simply, likely question types, and things I've lost points on before (from get_grades feedback). ` +
          `Cite which Canvas file/page each section came from.`,
      },
    }],
  }));

  server.registerPrompt("quiz_me", {
    title: "Quiz me",
    description: "Practice questions from your course materials, one at a time",
    argsSchema: { course: z.string(), topic: z.string() },
  }, ({ course, topic }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Quiz me on "${topic}" from my ${course} class. First read the relevant course materials using the Canvas tools. ` +
          `Then ask me one question at a time, in the style my teacher uses. Wait for my answer, tell me if I'm right, explain anything I miss, ` +
          `and give me harder questions as I get them right. Keep score.`,
      },
    }],
  }));

  server.registerPrompt("weekly_plan", {
    title: "Plan my week",
    description: "Everything due soon across all classes, prioritized",
    argsSchema: {},
  }, () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Look at everything due in the next 7 days and anything missing or overdue using get_upcoming and list_announcements. ` +
          `Give me a prioritized plan: what to do first, rough time for each, and flag any tests coming up.`,
      },
    }],
  }));
}
