import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "./canvas.js";
import { registerPrompts, registerTools, ToolOptions } from "./tools.js";

export const VERSION = "1.0.0";

export function buildServer(canvas: CanvasClient, opts: ToolOptions): McpServer {
  const server = new McpServer(
    { name: "canvas", version: VERSION },
    {
      instructions:
        "Read-only access to the user's Canvas LMS (they are a student). Start with list_courses to get course ids, or get_upcoming " +
        "for what's due, or get_calendar for what was taught on which day (teachers often post one calendar event per lesson). To study for a test, check list_announcements and get_syllabus for what it covers, then use search_course " +
        "and list_modules to find the material, then actually read it with get_page or read_file before you answer. " +
        "Base explanations on the teacher's material and say which file or page you used. Help the student learn the content " +
        "(explain, quiz, outline) rather than writing graded work for them to hand in.",
    },
  );
  registerTools(server, canvas, opts);
  registerPrompts(server);
  return server;
}
