// HTML for the multi-user mode: landing page, login form, and errors. Self-contained (no external fonts, images or
// scripts), and every interpolated value goes through escapeHtml.
import { createHash } from "node:crypto";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

// The only script: fills the hidden tz field with the browser's IANA time zone. The CSP allows it by hash, so the
// hash is taken from this exact string, which is also what the page embeds.
const TZ_SCRIPT = `try{document.getElementById("tz").value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}`;
const TZ_HASH = createHash("sha256").update(TZ_SCRIPT, "utf8").digest("base64");

const ORIGIN = /^https?:\/\/([a-z\d-]+(\.[a-z\d-]+)*|\[[\da-f:.]+\])(:\d{1,5})?$/;

/** Security headers for every page. formActionOrigin (an exact origin such as https://claude.ai) is added to
 *  form-action for the login page, whose POST ends in a redirect there; browsers hold that redirect to form-action.
 *  Referrer-Policy is same-origin, not no-referrer: under no-referrer the login form's own POST carries "Origin: null",
 *  which any attacker's page can also send, and isSameOriginPost (login.ts) relies on Origin when a browser sends no
 *  Sec-Fetch-Site. same-origin still sends no referrer to claude.ai or any other origin. */
export function pageHeaders(formActionOrigin?: string): Record<string, string> {
  let formAction = "'self'";
  if (formActionOrigin !== undefined) {
    let canonical = false;
    try { canonical = new URL(formActionOrigin).origin === formActionOrigin; } catch {}
    if (!canonical || !ORIGIN.test(formActionOrigin)) throw new Error("form-action origin must be scheme://host[:port]");
    formAction += ` ${formActionOrigin}`;
  }
  return {
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${TZ_HASH}'; img-src 'self' data:; ` +
      `form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  };
}

const STYLE = `:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--box:#f6f8fa;--line:#d1d9e0;--err:#8a1c1c;--err-bg:#fdecec}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--box:#151b23;--line:#3d444d;--err:#ffb3b3;--err-bg:#3c1618}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;margin:0 auto;padding:2rem 1rem 3rem}
h1{font-size:1.5rem;margin:0 0 .5rem}
h2{font-size:1.05rem;margin:1.75rem 0 .5rem}
label{display:block;font-weight:600;margin:1rem 0 .25rem}
input{width:100%;font:inherit;padding:.6rem .7rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{width:100%;margin-top:1.25rem;font:inherit;font-weight:600;padding:.7rem;border:0;border-radius:6px;background:#0b5cad;color:#fff;cursor:pointer}
ol,ul{padding-left:1.25rem}
li{margin:.3rem 0}
code{font:.95em ui-monospace,Menlo,Consolas,monospace;background:var(--box);padding:.1rem .3rem;border-radius:4px;overflow-wrap:anywhere}
.muted{color:var(--muted);font-size:.9rem}
.note{background:var(--box);border:1px solid var(--line);border-radius:6px;padding:.75rem 1rem .75rem 2rem}
.error{background:var(--err-bg);color:var(--err);border-radius:6px;padding:.75rem 1rem}`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Canvas for Claude</h1>
${body}
</main>
</body>
</html>
`;
}

const NOTES = `<ul class="note">
<li>This connector only reads from Canvas. The token itself is full-power, though: it can do anything you can do in Canvas.</li>
<li>The person who runs this server is trusted with your token. Only log in if you trust them.</li>
<li>To cut off access at any time, delete the token in Canvas: <strong>Account → Settings → Approved Integrations</strong>.</li>
</ul>`;

/** GET /: how to add this server to claude.ai. */
export function landingPage(publicUrl: string): string {
  const mcp = `${publicUrl.replace(/\/+$/, "")}/mcp`;
  return page("Canvas for Claude", `<p>Lets Claude read your Canvas courses, assignments, grades, and files.</p>
<h2>Add it to Claude</h2>
<ol>
<li>In claude.ai, open <strong>Settings → Connectors</strong>.</li>
<li>Click <strong>Add custom connector</strong> and paste this URL:<br><code>${escapeHtml(mcp)}</code></li>
<li>Click <strong>Connect</strong>, then log in with your school's Canvas address and a Canvas access token.</li>
</ol>
<h2>Good to know</h2>
${NOTES}`);
}

/** The login form, posted to /login. authreq is the sealed authorization request; redirectHost is where the browser goes next. */
export function loginPage(p: { authreq: string; redirectHost: string; error?: string; canvasUrl?: string }): string {
  const error = p.error ? `<p class="error" role="alert">${escapeHtml(p.error)}</p>\n` : "";
  return page("Log in · Canvas for Claude", `<p>Log in with Canvas so Claude can read your courses, assignments, grades, and files.</p>
${error}<form method="post" action="/login">
<input type="hidden" name="authreq" value="${escapeHtml(p.authreq)}">
<input type="hidden" name="tz" id="tz" value="">
<label for="canvas_url">Your school's Canvas address</label>
<input id="canvas_url" name="canvas_url" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" required placeholder="https://yourschool.instructure.com" value="${escapeHtml(p.canvasUrl ?? "")}">
<label for="token">Canvas access token</label>
<input id="token" name="token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required>
<button type="submit">Log in</button>
<p class="muted">After you log in you'll go back to <strong>${escapeHtml(p.redirectHost)}</strong>.</p>
</form>
<script>${TZ_SCRIPT}</script>
<h2>How to make a token</h2>
<ol>
<li>In Canvas, go to <strong>Account → Settings</strong>.</li>
<li>Under <strong>Approved Integrations</strong>, click <strong>+ New Access Token</strong>.</li>
<li>For the purpose, type something like “Claude”. An expiry date is optional.</li>
<li>Click <strong>Generate Token</strong>, then copy the token and paste it above. Canvas shows it only once.</li>
</ol>
<h2>Before you log in</h2>
${NOTES}`);
}

/** A dead end (for example an expired login link): the message, and how to start over. */
export function errorPage(message: string): string {
  return page("Canvas for Claude", `<p class="error" role="alert">${escapeHtml(message)}</p>
<p>Start again from Claude: open <strong>Settings → Connectors</strong> and click <strong>Connect</strong>.</p>`);
}
