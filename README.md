# canvas-mcp

A **read-only** [MCP](https://modelcontextprotocol.io) server that gives Claude access to your Canvas LMS courses, so it can help you study from your teachers' actual materials: what's due, what a test covers, explanations of the slides, practice quizzes, and where you're losing points.

It can't submit, post, or change anything in Canvas. Every tool only reads.

## Tools

| Tool | What it's for |
|---|---|
| `list_courses` | Your courses, their ids, and current grades. Claude starts here. |
| `get_upcoming` | Everything due or scheduled across all classes, with submitted/missing status |
| `list_assignments` / `get_assignment` | Due dates, full instructions, rubric, your score, and teacher feedback |
| `get_grades` | Weighted grade breakdown (good for "what do I need on the final?") |
| `get_syllabus` | Syllabus text |
| `list_modules` | Units/weeks and their contents. Usually the best map of a course. |
| `list_pages` / `get_page` | Notes and pages the teacher wrote in Canvas |
| `list_files` / `read_file` | Reads **PDF, DOCX, PPTX (with speaker notes), HTML, text/code**. Long files come back in chunks. |
| `list_announcements` | Recent announcements ("test moved to Tuesday") |
| `list_discussions` / `get_discussion` | Discussion prompts and replies |
| `list_quizzes` | Quiz/test dates, number of questions, time limits |
| `search_course` | Finds modules, pages, files, and assignments matching a topic |

Prompts (they show up as templates or slash commands in clients that support them): **`study_guide`**, **`quiz_me`**, **`weekly_plan`**.

---

## Step 1: Build it

Needs Node 20+.

```bash
cd canvas-mcp
npm install
npm run build
```

## Step 2: Check your token

Your Canvas URL is the address you log into, for example `https://yourschool.instructure.com`. Leave off any `/api/v1`.

**macOS / Linux**
```bash
CANVAS_BASE_URL=https://yourschool.instructure.com CANVAS_API_TOKEN=xxxx npm run check
```
**Windows (PowerShell)**
```powershell
$env:CANVAS_BASE_URL="https://yourschool.instructure.com"; $env:CANVAS_API_TOKEN="xxxx"; npm run check
```

If the check passes, it prints your name and your active courses. A 401 error means the token is wrong or expired. You can make a new one under Canvas → Account → Settings → Approved Integrations → **+ New Access Token**.

## Step 3: Connect it to Claude

Pick whichever option fits how you use Claude.

### Option A: Claude Code (one command)

```bash
claude mcp add canvas --scope user \
  -e CANVAS_BASE_URL=https://yourschool.instructure.com \
  -e CANVAS_API_TOKEN=xxxx \
  -e CANVAS_TZ=America/Indianapolis \
  -- node /ABSOLUTE/PATH/TO/canvas-mcp/dist/index.js
```

### Option B: Claude Desktop

Open the config file from Claude Desktop → Settings → Developer → Edit Config, and add this:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "node",
      "args": ["C:\\Users\\you\\canvas-mcp\\dist\\index.js"],
      "env": {
        "CANVAS_BASE_URL": "https://yourschool.instructure.com",
        "CANVAS_API_TOKEN": "xxxx",
        "CANVAS_TZ": "America/Indianapolis"
      }
    }
  }
}
```
On macOS, use a path like `/Users/you/canvas-mcp/dist/index.js`. Restart Claude Desktop fully after saving.

### Option C: Self-host it and use it from claude.ai (any device, including a Chromebook)

HTTP mode serves MCP at `https://your-host/mcp/<MCP_SECRET>`. claude.ai's servers connect to that URL directly, so it has to be reachable from the public internet.

1. Generate a secret: `openssl rand -hex 24`
2. Deploy the included `Dockerfile` (Coolify: *New Resource → Dockerfile*, or any Docker host). Set these env vars: `CANVAS_BASE_URL`, `CANVAS_API_TOKEN`, `CANVAS_TZ`, `MCP_SECRET`. The container listens on port 3000 and has `/health` for health checks.
3. Expose it on a subdomain, for example `canvas-mcp.yourdomain.com`, through your reverse proxy or Cloudflare Tunnel. **Don't put it behind Cloudflare Access or Basic Auth.** claude.ai can't log in through those, so the secret path is the protection instead.
4. In claude.ai, go to Settings → Connectors, add a custom connector, and paste `https://canvas-mcp.yourdomain.com/mcp/<MCP_SECRET>`.

Without Docker: `node dist/index.js --http --port 3000` (it reads the same env vars).

> ⚠️ Anyone who has the full URL can read your Canvas through it. Treat the URL like a password. If it leaks, change `MCP_SECRET`, and also revoke the token in Canvas if you're unsure.

---

## Using it

Example requests:

- "What's due this week across all my classes? Anything missing?"
- "My AP Bio Unit 4 test is Tuesday. Make me a study guide from the actual slides and notes."
- "Quiz me on the APUSH Period 5 material, one question at a time."
- "Explain slide 12 of the cell respiration PowerPoint like I'm confused."
- "What do I need on the final to keep an A in chemistry?"
- "Where did I lose points on my last lab? Read the rubric feedback."

## CLI reference

```
canvas-mcp [--url URL] [--token T] [--tz ZONE] [--max-chars N]   stdio mode (default)
canvas-mcp --http [--port 3000] [--host 0.0.0.0] [--secret S]      HTTP mode
canvas-mcp --check                                                  test credentials
canvas-mcp --help | --version
```

| Env var | Flag | Default |
|---|---|---|
| `CANVAS_BASE_URL` | `--url` | (required) |
| `CANVAS_API_TOKEN` | `--token` | (required; prefer the env var over the flag so the token doesn't land in shell history) |
| `CANVAS_TZ` | `--tz` | system time zone |
| `CANVAS_MAX_CHARS` | `--max-chars` | 20000 characters per response chunk |
| `MCP_SECRET` | `--secret` | (required for `--http`, minimum 24 chars) |
| `PORT` / `HOST` | `--port` / `--host` | 3000 / 0.0.0.0 |

## Limitations

- **Scanned PDFs** (images with no text layer) come back mostly empty, and the tool says so. Download the file and attach it to the chat so Claude can see the pages.
- **Quiz questions** aren't visible to students through the API until results are released. That's Canvas's rule, not something this server can change.
- Some schools hide tabs such as Files or Pages. Those tools return a 403/404, and Claude can work around it with `list_modules`.
- Some schools disable personal access tokens entirely. If you can't make one, this approach won't work at your school.

## Development

```bash
npm run dev     # tsc --watch
npm test        # runs every tool against a mock Canvas API (stdio + HTTP)
```

MIT licensed.
