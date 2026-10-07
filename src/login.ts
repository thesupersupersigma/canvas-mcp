// Checks for the multi-user login form: the student's Canvas address, their browser's time zone, and a live
// test of their token. Errors are user-facing, and the same for every kind of network failure.

export interface CanvasCred { url: string; token: string; tz: string }

const MAX_URL = 2048;

/** The lowercase origin of a student-typed Canvas address (https:// added when there is no scheme), or null.
 *  Only https on the default port with a dotted host name; allowHttp (tests only) also takes http, any host and any port. */
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
  return /^[a-z\d-]+(\.[a-z\d-]+)+$/.test(url.hostname) ? url.origin : null;
}

/** The canonical name of a valid IANA time zone, else "UTC". */
export function normalizeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !/^[A-Za-z][\w+\-/]{0,63}$/.test(tz)) return "UTC";
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone; } catch { return "UTC"; }
}

const REJECTED = "Canvas rejected that token. Check that you copied the whole token, or make a new one.";
const UNREACHABLE = "Couldn't reach a Canvas server at that address.";
const NOT_CANVAS = "That doesn't look like a Canvas server.";
const TIMEOUT_MS = 15_000;
const MAX_PROFILE = 1024 * 1024; // users/self is a few hundred bytes

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

/** Tries the token on GET /api/v1/users/self. Null when it works, else a message for the login page. One message
 *  covers every network failure (guard refusal, DNS, connect, TLS, timeout), so the page can't map internal names. */
export async function verifyCanvasLogin(cred: CanvasCred, f: typeof fetch): Promise<string | null> {
  if (typeof cred.token !== "string" || !/^[\x21-\x7e]+$/.test(cred.token)) return REJECTED; // not a Canvas token; never sent
  let res: Response;
  try {
    res = await f(`${cred.url}/api/v1/users/self`, {
      headers: { Authorization: `Bearer ${cred.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return UNREACHABLE;
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    return res.status === 401 ? REJECTED : NOT_CANVAS;
  }
  let text: string | null;
  try { text = await readCapped(res, MAX_PROFILE); } catch { return UNREACHABLE; }
  try {
    const id = text === null ? undefined : JSON.parse(text)?.id;
    return typeof id === "number" || (typeof id === "string" && id !== "") ? null : NOT_CANVAS;
  } catch {
    return NOT_CANVAS;
  }
}
