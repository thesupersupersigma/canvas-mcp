// Checks for the multi-user login form: the student's Canvas address, their browser's time zone, and a live
// test of their token. Errors are user-facing, and the same for every kind of network failure.
import { isIP } from "node:net";

export interface CanvasCred { url: string; token: string; tz: string }

const MAX_URL = 2048;

/** The lowercase origin of a student-typed Canvas address (https:// added when there is no scheme), or null.
 *  Only https on the default port with a dotted host name that is not an IP address; allowHttp (tests only) also takes
 *  http, any host and any port. */
export function normalizeCanvasUrl(input: string, allowHttp = false): string | null {
  if (typeof input !== "string" || input.length > MAX_URL) return null;
  let s = input.trim();
  if (!s) return null;
  // "yourschool.instructure.com" or "...:443" has no scheme; "javascript:..." does and is refused below.
  if (!/^[a-z][a-z\d+.-]*:(?!\d)/i.test(s)) s = `https://${s}`;
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (url.username || url.password) return null;
  if (allowHttp) return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  if (url.protocol !== "https:" || url.port) return null;
  // A real Canvas never runs on a bare IP, however it is spelled (the URL parser reads "123" and "0x7f.1" as IPv4).
  if (isIP(url.hostname.replace(/^\[(.*)\]$/, "$1")) !== 0 || /(^|\.)\d+$/.test(url.hostname)) return null;
  return /^[a-z\d-]+(\.[a-z\d-]+)+$/.test(url.hostname) ? url.origin : null;
}

/** Whether a POST /login came from this server's own login page. A cross-site form must be refused (403, and its
 *  canvas_url never shown back): otherwise it could land a student on the real login page with an attacker's Canvas
 *  address filled in, and the token they paste would be sent there. When the browser sends Sec-Fetch-Site, it decides;
 *  when it doesn't, Origin must be exactly publicOrigin. That fallback works because pageHeaders sets
 *  Referrer-Policy: same-origin (under no-referrer the page's own POST says "Origin: null", like any attacker's page).
 *  `headers` is Node's req.headers (lowercase names; a header sent twice is joined, so it never matches). */
export function isSameOriginPost(headers: Record<string, string | string[] | undefined>, publicOrigin: string): boolean {
  let canonical = false;
  try { canonical = /^https?:\/\//.test(publicOrigin) && new URL(publicOrigin).origin === publicOrigin; } catch {}
  if (!canonical) throw new Error("publicOrigin must be the server's exact origin, scheme://host[:port]");
  const site = headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin";
  return headers["origin"] === publicOrigin;
}

/** The canonical name of a valid IANA time zone, else "UTC". */
export function normalizeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !/^[A-Za-z][\w+\-/]{0,63}$/.test(tz)) return "UTC";
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone; } catch { return "UTC"; }
}

const REJECTED = "Canvas rejected that token. Check that you copied the whole token, or make a new one.";
const UNREACHABLE = "Couldn't reach a Canvas server at that address.";
const NOT_CANVAS = "That doesn't look like a Canvas server.";
const MAX_TOKEN = 512; // Canvas tokens are about 70 characters
const TIMEOUT_MS = 15_000;
const MAX_PROFILE = 1024 * 1024; // users/self is a few hundred bytes
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PROFILE = "/api/v1/users/self";

/** The body as text, or null past `max` bytes (the rest is cancelled). Throws if the connection fails mid-body. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  for (let size = 0; ;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    if ((size += value.byteLength) > max) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
}

/** Where a redirect from `requestUrl` points, as a normalized Canvas origin other than `from`; else null. Only a redirect
 *  to the same API path counts (vanity-domain redirects keep it): the token is never re-sent to a login page, an SSO
 *  provider, or anything else an address happens to redirect to. */
function redirectTarget(location: string | null, requestUrl: string, from: string, allowHttp: boolean): string | null {
  if (location === null) return null;
  let to: URL;
  try { to = new URL(location, requestUrl); } catch { return null; }
  if (to.pathname !== PROFILE) return null;
  const origin = to.origin === "null" ? null : normalizeCanvasUrl(to.origin, allowHttp); // "null": javascript:, data:, ...
  return origin === from ? null : origin;
}

/** Tries the token on GET /api/v1/users/self. On success, the Canvas origin that accepted it: an address that
 *  redirects to another plausible Canvas origin (instructure.com to a school's own domain, or the reverse) is tried
 *  there once, since the guarded fetch drops the token on a cross-origin hop. Otherwise a message for the login page;
 *  one message covers every network failure (guard refusal, DNS, connect, TLS, timeout), so the page can't map
 *  internal names. cred.url must already be an exact origin (normalizeCanvasUrl). allowHttp (tests only, from the
 *  server's config) lets that redirect go to an http, IP or any-port address, as normalizeCanvasUrl does. */
export async function verifyCanvasLogin(cred: CanvasCred, f: typeof fetch, opts: { allowHttp?: boolean } = {}): Promise<{ url: string } | { error: string }> {
  const { url: start, token } = cred;
  if (typeof token !== "string" || token.length > MAX_TOKEN || !/^[\x21-\x7e]+$/.test(token)) return { error: REJECTED }; // never sent
  let origin: string | undefined;
  try { origin = new URL(start).origin; } catch {}
  if (typeof start !== "string" || start !== origin) return { error: UNREACHABLE };
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS), // for the whole attempt, redirect included
  };
  for (let url = start, hops = 0; ; hops++) {
    const requestUrl = `${url}${PROFILE}`;
    let res: Response;
    try { res = await f(requestUrl, init); } catch { return { error: UNREACHABLE }; }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      if (res.status === 401) return { error: REJECTED };
      const next = hops === 0 && REDIRECTS.has(res.status)
        ? redirectTarget(res.headers.get("location"), requestUrl, url, opts.allowHttp === true) : null;
      if (next === null) return { error: NOT_CANVAS };
      url = next;
      continue;
    }
    let text: string | null;
    try { text = await readCapped(res, MAX_PROFILE); } catch { return { error: UNREACHABLE }; }
    try {
      const id = text === null ? undefined : JSON.parse(text)?.id;
      return typeof id === "number" || (typeof id === "string" && id !== "") ? { url } : { error: NOT_CANVAS };
    } catch {
      return { error: NOT_CANVAS };
    }
  }
}
