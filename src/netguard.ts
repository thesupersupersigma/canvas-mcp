// Outbound network guard for multi-user mode. Students type the Canvas URL and Canvas responses
// supply more (file links, Link: next), so every request must be https, every redirect hop is
// re-checked, and every address we connect to must be public: no loopback, LAN, or metadata.
import dns from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

export class NetGuardError extends Error {
  name = "NetGuardError";
}

const v4 = (ip: string) => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);

const V4_BLOCKED = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4"]
  .map((cidr) => { const [ip, bits] = cidr.split("/"); return [v4(ip), 32 - Number(bits)] as const; });

const v4Public = (n: number) => !V4_BLOCKED.some(([base, shift]) => n >>> shift === base >>> shift);

/** The eight 16-bit words of a valid IPv6 address (zone dropped, dotted IPv4 tail folded in). */
function v6Words(ip: string): number[] {
  ip = ip.split("%")[0];
  const dotted = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) { const n = v4(dotted[2]); ip = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  return (tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t]).map((w) => parseInt(w, 16));
}

/** True only for a syntactically valid IP that is safe to connect to from the server. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Public(v4(ip));
  if (kind !== 6) return false;
  const w = v6Words(ip), embedded = w[6] * 65536 + w[7];
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && w[5] === 0xffff) return v4Public(embedded); // ::ffff:a.b.c.d, IPv4-mapped
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return v4Public(embedded); // 64:ff9b::/96, NAT64
  // Otherwise global unicast (2000::/3) only, minus the tunnels that reach IPv4: 6to4 and Teredo.
  // Everything else (::, ::1, IPv4-compatible, fc00::/7, fe80::/10, fec0::/10, ff00::/8, ...) is out.
  return (w[0] & 0xe000) === 0x2000 && w[0] !== 0x2002 && !(w[0] === 0x2001 && w[1] === 0);
}

/** DNS lookup for the socket layer: fails unless every record is public, then hands net only checked addresses. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, []);
    if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address)))
      return callback(new NetGuardError(`${hostname} resolves to a non-public address`), []);
    if (options.all) callback(null, addrs);
    else callback(null, addrs[0].address, addrs[0].family);
  });
};

/** https only, and IP-literal hosts must be public. Hostnames are checked at connect time by guardedLookup
 *  (net and tls skip lookup for IP literals, hence this up-front check). */
function checkUrl(input: string | URL, base?: URL): URL {
  const url = new URL(input, base);
  if (url.protocol !== "https:") throw new NetGuardError(`Only https URLs are allowed, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) && !isPublicAddress(host)) throw new NetGuardError(`${host} is not a public address`);
  return url;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 5;
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/** Checks the URL and follows redirects itself (GET/HEAD only, ≤ 5 hops), re-checking every hop and
 *  dropping credentials once the origin changes. Exported for tests; on its own it does not check DNS —
 *  use createGuardedFetch. */
export function withUrlGuard(transport: typeof fetch): typeof fetch {
  return async (input, init = {}) => {
    if (input instanceof Request) throw new TypeError("Guarded fetch takes a URL, not a Request");
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let url = checkUrl(input);
    for (let hops = 0; ; hops++) {
      const res = await transport(url.href, { ...init, headers, redirect: "manual" });
      const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null;
      if (location === null || init.redirect === "manual") return res;
      await res.body?.cancel().catch(() => {});
      if (init.redirect === "error") throw new TypeError("Unexpected redirect");
      if (method !== "GET" && method !== "HEAD") throw new NetGuardError(`Not following a redirect for ${method}`);
      if (hops === MAX_HOPS) throw new NetGuardError(`More than ${MAX_HOPS} redirects`);
      const next = checkUrl(location, url);
      if (next.origin !== url.origin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
      url = next;
    }
  };
}

/** One per process: owns an undici Agent whose sockets only ever connect to checked public addresses.
 *  allowPrivate (tests only) returns the plain global fetch. */
export function createGuardedFetch(o: { allowPrivate?: boolean } = {}): typeof fetch {
  if (o.allowPrivate) return globalThis.fetch;
  const dispatcher = new Agent({ connect: { lookup: guardedLookup } });
  return withUrlGuard(async (url, init) => {
    try {
      return (await undiciFetch(url as string, { ...(init as UndiciRequestInit), dispatcher })) as unknown as Response;
    } catch (e) {
      // undici reports connect failures as TypeError("fetch failed") with the real error as `cause`.
      for (let c: any = e, depth = 0; c && depth < 8; c = c.cause, depth++) if (c instanceof NetGuardError) throw c;
      throw e;
    }
  });
}
