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
| `get_calendar` | Course calendar for any date range: daily lesson topics, test days, and optionally due dates ("what did we do Tuesday?", "what's been covered since the last test?") |
| `list_discussions` / `get_discussion` | Discussion prompts and replies |
| `list_quizzes` | Quiz/test dates, number of questions, time limits |
| `search_course` | Finds modules, pages, files, and assignments matching a topic |

Prompts (they show up as templates or slash commands in clients that support them): **`study_guide`**, **`quiz_me`**, **`weekly_plan`**.

> If someone already runs a shared server for your class (Option D below), you don't need to build anything: follow [What students do](#what-students-do).

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

If the check passes, it prints your Canvas user id and your active courses. A 401 error means the token is wrong or expired. You can make a new one under Canvas → Account → Settings → Approved Integrations → **+ New Access Token**.

## Step 3: Connect it to Claude

Pick whichever option fits how you use Claude.

### Option A: Claude Code (one command)

```bash
claude mcp add canvas --scope user \
  -e CANVAS_BASE_URL=https://yourschool.instructure.com \
  -e CANVAS_API_TOKEN=xxxx \
  -e CANVAS_TZ=America/New_York \
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
        "CANVAS_TZ": "America/New_York"
      }
    }
  }
}
```
On macOS, use a path like `/Users/you/canvas-mcp/dist/index.js`. Restart Claude Desktop fully after saving.

### Option C: Self-host it and use it from claude.ai (any device, including a Chromebook)

HTTP mode serves MCP at `https://your-host/mcp/<MCP_SECRET>`. claude.ai's servers connect to that URL directly, so it has to be reachable from the public internet.

1. Generate a secret: `openssl rand -hex 24`
2. Deploy the included `Dockerfile` (Coolify: *New Resource → Dockerfile*, or any Docker host). Set these env vars: `CANVAS_BASE_URL`, `CANVAS_API_TOKEN`, `CANVAS_TZ`, `MCP_SECRET`. The container listens on port 7341 and has `/health` for health checks.
3. Expose it on a subdomain, for example `canvas-mcp.yourdomain.com`, through your reverse proxy or Cloudflare Tunnel. **Don't put it behind Cloudflare Access or Basic Auth.** claude.ai can't log in through those, so the secret path is the protection instead.
4. In claude.ai, go to Settings → Connectors, add a custom connector, and paste `https://canvas-mcp.yourdomain.com/mcp/<MCP_SECRET>`.

Without Docker: `node dist/index.js --http` (it reads the same env vars). It binds to 127.0.0.1 by default, so only this machine can reach it; add `--host 0.0.0.0` when a proxy on another machine needs to reach it.

> ⚠️ Anyone who has the full URL can read your Canvas through it. Treat the URL like a password. If it leaks, change `MCP_SECRET`, and also revoke the token in Canvas if you're unsure.

### Option D: Host it for everyone (multi-user)

One server and one URL for a whole class or school. Each student logs in with their own Canvas address and access token. The URL holds no secret, and the server stores nothing.

#### What students do

1. Open the server's page, for example `https://canvas.example.com`. It shows the connector URL, `https://canvas.example.com/mcp`, which is the same for everyone.
2. In claude.ai, go to **Settings → Connectors → Add custom connector**, paste that URL, and click **Connect**.
3. A login page opens. Enter your school's Canvas address and a Canvas access token (the page explains how to make one). Due dates use your browser's time zone.
4. You land back in Claude, and the Canvas tools are ready.

To cut off access at any time, delete the token in Canvas: **Account → Settings → Approved Integrations**.

#### Deploy it on Coolify

1. Make the key: `openssl rand -hex 32`. It must be random like this. A guessable key can be cracked offline from any token the server hands out, and that would expose every student's Canvas token.
2. In Coolify: **New Resource → Public Repository** with this repo (or your fork), build pack **Dockerfile**.
3. Set two environment variables:
   ```
   PUBLIC_URL=https://canvas.example.com
   CANVAS_MCP_KEY=<the key from step 1>
   ```
   Don't also set `MCP_SECRET` (the server refuses to start with both). `CANVAS_BASE_URL`, `CANVAS_API_TOKEN` and `CANVAS_TZ` aren't used in this mode.
4. Set the exposed port to **7341** and the health check path to `/health`.
5. Give it a public HTTPS address (below), deploy, and open `PUBLIC_URL` in a browser. You should see the page from step 1 above.

Without Coolify, any Docker host works the same way. Without Docker: `PUBLIC_URL=… CANVAS_MCP_KEY=… node dist/index.js --http`, behind a reverse proxy on the same machine.

#### Public HTTPS

claude.ai's servers and your students' browsers both have to reach `PUBLIC_URL` over HTTPS.

- **Cloudflare Tunnel**: no port forwarding needed, but your domain's DNS has to be on Cloudflare. Point a public hostname straight at the container's port 7341, not at Coolify's proxy. By default, Coolify's proxy replaces every student's IP address with the tunnel's, so all students would share one login limit.
- **Coolify's built-in proxy**: point the domain's DNS at your server, forward ports 80 and 443 to it, and set the resource's domain to `PUBLIC_URL`. Coolify gets a Let's Encrypt certificate.

**Don't put it behind Cloudflare Access or Basic Auth.** claude.ai can't log in through those; the Canvas login is the protection.

#### Settings (multi-user)

| Env var | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | (required) | The server's public origin, no path, e.g. `https://canvas.example.com`. Must be https (http only for `localhost` testing). |
| `CANVAS_MCP_KEY` | (required) | Encrypts every login. At least 32 characters, random: `openssl rand -hex 32`. Changing it logs everyone out. |
| `CANVAS_MCP_REDIRECT_HOSTS` | claude.ai, claude.com, localhost | Comma-separated origins allowed to receive logins (the OAuth redirect targets of Claude apps). Leave it unset normally. |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Addresses or subnets of the reverse proxies whose `X-Forwarded-For` is believed (Express "trust proxy"). The default covers a proxy on the same machine or a private network, such as Coolify's proxy or cloudflared. Use addresses, not `true` or a hop count: anything trusted can fake a client's IP and dodge the login limit. |
| `CANVAS_MCP_ALLOW_PRIVATE_NETWORK` | off | `1` turns the network guard off, so logins can reach http and private addresses. For local testing only, never in production. |
| `CANVAS_MCP_PORT` / `CANVAS_MCP_HOST` | 7341 / 127.0.0.1 | Listen port and address. The Docker image uses 0.0.0.0. |
| `CANVAS_MAX_CHARS` | 20000 | Max characters per tool response chunk. |

#### Security and limits

- **You're trusted with every student's Canvas token.** It travels inside tokens encrypted with `CANVAS_MCP_KEY` that Claude holds. Nothing is written to disk, and tokens are never logged. Whoever runs the server can read them, and so can anyone who gets both the key and a student's token. A Canvas token can do anything the student can do in Canvas, even though this server only reads.
- **No per-student revoke on the server.** A student cuts access off by deleting their token in Canvas (**Account → Settings → Approved Integrations**). Changing `CANVAS_MCP_KEY` logs everyone out at once.
- **Logins last until 90 days without use**, or until the student's Canvas token expires or is deleted.
- **Run a single instance.** One-time login codes are tracked in memory.
- **Rate limits.** Logins: 10 attempts per 15 minutes per IP address, so a whole school behind one IP shares that. MCP requests: 120 per minute per student, at most 4 at a time per student and 16 at a time in all; past that, requests get a "slow down" or "server busy" error.
- **Signup is open.** Anyone who can reach the server can log in with any Canvas address, including a fake one, and a hostile user can slow the service down for everyone (for example with a deliberately slow fake Canvas). If that happens, restart the server and change `CANVAS_MCP_KEY`.
- **Keep it off your own network.** The server fetches whatever Canvas address a student types. It refuses private and internal addresses, but it can't know your own public IP: a hostname pointing there can reach your router's admin page or anything you port-forward. The public IPv6 addresses of devices on your LAN look public too. Run the container on a network that can't reach your LAN or router, for example a Docker network without IPv6 plus a firewall rule (Docker's `DOCKER-USER` chain) that drops its traffic to your LAN and your public IP.

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
canvas-mcp [--url URL] [--token T] [--tz ZONE] [--max-chars N]      stdio mode (default)
canvas-mcp --http [--port 7341] [--host 127.0.0.1] [--secret S]     HTTP mode, one Canvas account (Option C)
PUBLIC_URL=… CANVAS_MCP_KEY=… canvas-mcp --http [--port] [--host]   HTTP mode, multi-user (Option D)
canvas-mcp --check                                                  test credentials
canvas-mcp --help | --version
```

| Env var | Flag | Default |
|---|---|---|
| `CANVAS_BASE_URL` | `--url` | (required) |
| `CANVAS_API_TOKEN` | `--token` | (required; prefer the env var over the flag so the token doesn't land in shell history) |
| `CANVAS_TZ` | `--tz` | system time zone |
| `CANVAS_MAX_CHARS` | `--max-chars` | 20000 characters per response chunk |
| `MCP_SECRET` | `--secret` | (required for single-user `--http`, minimum 24 chars) |
| `CANVAS_MCP_PORT` / `CANVAS_MCP_HOST` | `--port` / `--host` | 7341 / 127.0.0.1 (Docker image uses 0.0.0.0) |

Multi-user mode has its own settings (`PUBLIC_URL`, `CANVAS_MCP_KEY`, ...); see [Option D](#settings-multi-user).

## Limitations

- **Scanned PDFs** (images with no text layer) come back mostly empty, and the tool says so. Download the file and attach it to the chat so Claude can see the pages.
- **Quiz questions** aren't visible to students through the API until results are released. That's Canvas's rule, not something this server can change.
- Some schools hide tabs such as Files or Pages. Those tools return a 403/404, and Claude can work around it with `list_modules`.
- Some schools disable personal access tokens entirely. If you can't make one, this approach won't work at your school.

## Development

```bash
npm run dev     # tsc --watch
npm test        # unit tests, every tool against a mock Canvas API (stdio + HTTP), the multi-user login flow, docs checks
```

MIT licensed.
