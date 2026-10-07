// Unit tests for the multi-user building blocks (no network). Run after `npm run build`.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import * as netguard from "../dist/netguard.js";
import { Sealer } from "../dist/seal.js";

const { _testing, createGuardedFetch, isPublicAddress, NetGuardError } = netguard;
const { guardedFetch, guardedLookup, LIMITS, withUrlGuard } = _testing;

const sections = [];
const section = (name, fn) => sections.push({ name, fn });
const nowSec = () => Math.floor(Date.now() / 1000);

section("seal", () => {
  const secret = "a".repeat(32);
  const s = new Sealer(secret);
  const t = s.seal("access", { a: 1 }, 60);
  assert.match(t, /^[A-Za-z0-9_-]+$/, "base64url without padding");
  const p = s.open("access", t);
  assert.equal(p.a, 1);
  assert.ok(p.exp > nowSec() && p.exp <= nowSec() + 60, "exp is unix seconds, now + ttl");
  assert.notEqual(s.seal("access", { a: 1 }, 60), t, "fresh IV per token");

  // Format: base64url(iv[12] ‖ ciphertext ‖ tag[16]), key = HKDF-SHA256, purpose as AAD.
  const key = Buffer.from(hkdfSync("sha256", secret, "", "canvas-mcp seal v1", 32));
  const raw = Buffer.from(t, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAAD(Buffer.from("access"));
  d.setAuthTag(raw.subarray(-16));
  assert.equal(JSON.parse(Buffer.concat([d.update(raw.subarray(12, -16)), d.final()]).toString()).a, 1);
  const forge = (purpose, text) => {
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(purpose));
    const ct = Buffer.concat([c.update(text), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url");
  };
  assert.deepEqual(s.open("client", forge("client", '{"a":2}')), { a: 2 });
  for (const text of ["null", "[1]", '"x"', "7", "{bad json"]) assert.equal(s.open("client", forge("client", text)), null, `non-object payload ${text}`);

  assert.equal(s.open("refresh", t), null, "wrong purpose");
  const flip = (str, i) => str.slice(0, i) + (str[i] === "A" ? "B" : "A") + str.slice(i + 1);
  assert.equal(s.open("access", flip(t, Math.floor(t.length / 2))), null, "tamper in the middle");
  for (let i = 0; i < t.length; i++) assert.equal(s.open("access", flip(t, i)), null, `tamper at ${i}`);
  assert.equal(new Sealer("b".repeat(32)).open("access", t), null, "other key");

  assert.equal(s.open("access", s.seal("access", {}, -1)), null, "expired");
  assert.equal(s.open("access", s.seal("access", {}, 0)), null, "exp == now is expired");
  assert.equal(s.open("access", s.seal("access", { exp: nowSec() + 999 }, -1)), null, "ttl overrides payload exp");
  assert.ok(s.open("access", s.seal("access", { exp: 1 }, 60)).exp > nowSec(), "ttl overrides stale payload exp");

  assert.deepEqual(s.open("client", s.seal("client", { a: 1 })), { a: 1 }, "no ttl, no exp added");
  assert.equal(s.open("client", s.seal("client", { exp: nowSec() - 1 })), null, "no ttl, own past exp rejected");
  assert.equal(s.open("client", s.seal("client", { exp: "never" })), null, "non-numeric exp rejected");
  assert.ok(s.open("client", s.seal("client", { exp: nowSec() + 60 })), "no ttl, own future exp accepted");

  for (const bad of ["!!", "", undefined, null, 42, {}, t + "=", t + "!", t.slice(0, 20), t.slice(0, 39), "A".repeat(200)])
    assert.equal(s.open("access", bad), null, `garbage ${String(bad).slice(0, 20)}`);

  const msg = { message: "CANVAS_MCP_KEY must be at least 32 characters" };
  assert.throws(() => new Sealer("a".repeat(31)), msg);
  assert.throws(() => new Sealer(""), msg);
  assert.throws(() => new Sealer(undefined), msg);
});

section("netguard", async () => {
  assert.deepEqual(Object.keys(netguard).sort(), ["NetGuardError", "_testing", "createGuardedFetch", "isPublicAddress"],
    "public surface is the brief's three exports; the unsafe-alone helpers live only under _testing");
  const blocked = ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0",
    "0.1.2.3", "100.127.255.255", "172.16.0.0", "172.31.255.255", "192.0.0.8", "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:0a00:0001", "0:0:0:0:0:ffff:c0a8:0101", "::127.0.0.1", "::7f00:1", "fc00::1", "fdff:ffff::1", "fe80::1%eth0", "febf::1",
    "fec0::1", "ff02::1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::1", "2002:7f00:1::1", "2001:0:4136:e378::1", "100::1", "1fff:ffff::1", "4000::1",
    "localhost", "", "1.2.3", "010.0.0.1", "example.com", "[::1]"];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, `blocked ${ip}`);
  const open = ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "1.0.0.0", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0",
    "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0", "192.0.1.0", "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0", "223.255.255.255",
    "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2001:4860:4860::8888", "2a00:1450::1", "2c0f:fb50::1"];
  for (const ip of open) assert.equal(isPublicAddress(ip), true, `public ${ip}`);

  assert.equal(createGuardedFetch({ allowPrivate: true }), globalThis.fetch, "test escape hatch is the plain fetch");
  const f = createGuardedFetch();
  // https only; IP literals in any spelling the URL parser normalizes; hostnames that resolve to loopback.
  for (const url of ["http://example.com", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://2130706433/", "https://0x7f.1/", "https://127.1/",
    "https://0/", "https://[::ffff:127.0.0.1]/", "https://[::]/", "https://169.254.169.254/latest/meta-data/", "https://10.0.0.1:8443/", "ftp://example.com/", "file:///etc/passwd"])
    await assert.rejects(f(url), NetGuardError, url);

  // Nothing reaches a local listener: the guard refuses before the TCP connect.
  let hits = 0;
  const srv = net.createServer((s) => { hits++; s.destroy(); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const { port } = srv.address();
    for (const url of [`https://127.0.0.1:${port}/`, `https://localhost:${port}/`, `http://127.0.0.1:${port}/`]) await assert.rejects(f(url), NetGuardError, url);
    assert.equal(hits, 0, "no connection reached the local server");
  } finally { srv.close(); }

  // DNS: every record must be public (no mixed answers); non-guard DNS errors pass through untouched.
  const realLookup = dns.lookup;
  const answer = (addrs) => { dns.lookup = (host, opts, cb) => { assert.equal(opts.all, true, "always asks for every record"); cb(null, addrs); }; };
  const look = (opts) => new Promise((resolve) => guardedLookup("h.example", opts, (err, address, family) => resolve({ err, address, family })));
  try {
    const pub = [{ address: "203.0.113.7", family: 4 }, { address: "2606:4700::1111", family: 6 }];
    answer(pub);
    assert.deepEqual(await look({ all: true }), { err: null, address: pub, family: undefined });
    assert.deepEqual(await look({ family: 0 }), { err: null, address: "203.0.113.7", family: 4 });
    for (const bad of [[...pub, { address: "10.0.0.1", family: 4 }], [{ address: "::ffff:7f00:1", family: 6 }, ...pub], []]) {
      answer(bad);
      assert.ok((await look({ all: true })).err instanceof NetGuardError, JSON.stringify(bad));
      assert.ok((await look({})).err instanceof NetGuardError, JSON.stringify(bad));
    }
    // The guarded fetch connects through this lookup, and surfaces NetGuardError rather than undici's "fetch failed".
    answer([{ address: "203.0.113.7", family: 4 }, { address: "192.168.1.1", family: 4 }]);
    await assert.rejects(f("https://rebind.example/"), NetGuardError);
    dns.lookup = (host, opts, cb) => cb(Object.assign(new Error("getaddrinfo ENOTFOUND missing.example"), { code: "ENOTFOUND" }));
    await assert.rejects(f("https://missing.example/"), (e) => !(e instanceof NetGuardError) && e instanceof TypeError && e.cause?.code === "ENOTFOUND");
  } finally { dns.lookup = realLookup; }

  // Redirects, against a fake transport: every hop re-checked, at most 5, credentials dropped cross-origin.
  let calls = [];
  const fake = (routes) => async (url, init) => {
    const h = new Headers(init.headers);
    calls.push({ url, auth: h.get("authorization"), accept: h.get("accept"), method: init.method, redirect: init.redirect });
    return routes[url]?.() ?? new Response("ok");
  };
  const to = (status, location) => () => new Response("moved", { status, headers: { location } });
  const g = withUrlGuard(fake({
    "https://a.example/start": to(302, "/next?x=1"),
    "https://a.example/next?x=1": to(301, "https://b.example/file"),
    "https://b.example/file": to(307, "https://a.example/back"),
  }));
  const res = await g("https://a.example/start", { headers: { Authorization: "Bearer t", Accept: "application/json" } });
  assert.equal(await res.text(), "ok");
  assert.deepEqual(calls.map((c) => [c.url, c.auth]), [
    ["https://a.example/start", "Bearer t"], ["https://a.example/next?x=1", "Bearer t"], ["https://b.example/file", null], ["https://a.example/back", null],
  ], "relative Location resolved; Authorization dropped on origin change and not restored");
  assert.ok(calls.every((c) => c.accept === "application/json"), "other headers kept on every hop");
  assert.ok(calls.every((c) => c.redirect === "manual"), "transport never follows redirects itself");

  for (const target of ["http://a.example/", "ftp://a.example/", "https://127.0.0.1/", "https://[::1]/", "https://0x7f.1/", "https://[::ffff:7f00:1]/", "https://169.254.169.254/", "//10.0.0.1/x"]) {
    calls = [];
    await assert.rejects(withUrlGuard(fake({ "https://a.example/": to(302, target) }))("https://a.example/"), NetGuardError, target);
    assert.equal(calls.length, 1, `never requested ${target}`);
  }
  for (const url of ["http://a.example/", "https://192.168.0.1/"]) {
    calls = [];
    await assert.rejects(withUrlGuard(fake({}))(url), NetGuardError, url);
    assert.equal(calls.length, 0, `never requested ${url}`);
  }

  const chain = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`https://a.example/${i}`, to(302, `/${i + 1}`)]));
  calls = [];
  assert.equal((await withUrlGuard(fake(chain(5)))("https://a.example/0")).status, 200, "5 hops allowed");
  assert.equal(calls.length, 6);
  await assert.rejects(withUrlGuard(fake(chain(6)))("https://a.example/0"), NetGuardError, "6th hop refused");

  const one = (status) => withUrlGuard(fake({ "https://a.example/": to(status, "/x") }));
  calls = [];
  await one(303)("https://a.example/", { method: "HEAD" });
  assert.deepEqual(calls.map((c) => c.method), ["HEAD", "HEAD"], "HEAD stays HEAD");
  assert.equal((await one(302)("https://a.example/", { redirect: "manual" })).status, 302, "caller's manual mode honored");
  await assert.rejects(one(302)("https://a.example/", { redirect: "error" }), TypeError);
  await assert.rejects(one(307)("https://a.example/", { method: "POST", body: "x" }), NetGuardError, "only GET/HEAD redirects are followed");
  assert.equal((await withUrlGuard(fake({ "https://a.example/": () => new Response(null, { status: 304 }) }))("https://a.example/")).status, 304);
  await assert.rejects(withUrlGuard(fake({}))(new Request("https://a.example/")), TypeError, "Request objects refused");

  // The body cap applies to the final response only; cancelled redirect bodies don't count.
  const tiny = (routes) => withUrlGuard(fake(routes), { deadlineMs: 5000, maxBodyBytes: 4 });
  const long = () => new Response("x".repeat(100), { status: 302, headers: { location: "/four" } });
  assert.equal(await (await tiny({ "https://a.example/": long, "https://a.example/four": () => new Response("four") })("https://a.example/")).text(), "four");
  await assert.rejects((await tiny({ "https://a.example/": () => new Response("fives") })("https://a.example/")).text(), NetGuardError);

  // The deadline ends the body even when the transport ignores the abort signal and keeps feeding bytes.
  let drip, giveUpTimer, cancelled = false;
  const endless = () => new Response(new ReadableStream({
    start(c) { drip = setInterval(() => c.enqueue(new Uint8Array(1)), 10); },
    cancel() { cancelled = true; clearInterval(drip); },
  }));
  try {
    const slow = await withUrlGuard(fake({ "https://a.example/": endless }), { deadlineMs: 100, maxBodyBytes: 1e6 })("https://a.example/");
    const giveUp = new Promise((_, reject) => { giveUpTimer = setTimeout(() => reject(new Error("deadline never fired")), 2000); });
    await assert.rejects(Promise.race([slow.arrayBuffer(), giveUp]), { name: "NetGuardError", message: "No complete response within 0.1 s" });
    assert.ok(cancelled, "source body cancelled at the deadline");
  } finally { clearInterval(drip); clearTimeout(giveUpTimer); }

  // The re-wrap can't fail after the body is in flight: a reason phrase the Response constructor rejects is dropped,
  // and any other construction failure cancels the source and surfaces as NetGuardError.
  let srcCancelled = 0;
  const body = (close) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("ok")); if (close) c.close(); }, cancel() { srcCancelled++; } });
  const odd = (statusText, headers = [], close = true) => () => ({ status: 200, statusText, headers, url: "https://a.example/", body: body(close) });
  for (const reason of ["€", "\u0001", "A\u0000B", "�", "\u007f"]) {
    const r = await withUrlGuard(fake({ "https://a.example/": odd(reason) }))("https://a.example/");
    assert.deepEqual([r.status, r.statusText, await r.text()], [200, "", "ok"], `reason phrase ${JSON.stringify(reason)} dropped`);
  }
  assert.equal((await withUrlGuard(fake({ "https://a.example/": odd("Café\tOK") }))("https://a.example/")).statusText, "Café\tOK", "valid reason phrase kept");
  await assert.rejects(withUrlGuard(fake({ "https://a.example/": odd("OK", [["bad name", "x"]], false) }))("https://a.example/"),
    { name: "NetGuardError", message: "Malformed HTTP response" });
  assert.equal(srcCancelled, 1, "source body cancelled when the re-wrap fails");
});

section("netguard limits", async () => {
  const MiB = 1024 * 1024;
  assert.deepEqual({ ...LIMITS }, { connectTimeoutMs: 10_000, headersTimeoutMs: 20_000, bodyTimeoutMs: 20_000, deadlineMs: 60_000, maxBodyBytes: 60 * MiB });
  assert.ok(Object.isFrozen(LIMITS));

  // A hostile "Canvas" on a local plain-HTTP server. tls.connect is pointed at it (so no certificate is needed);
  // everything else is the real stack: undici's Agent with our options, its gzip decoding, and the guard.
  const gz = (n) => zlib.gzipSync(Buffer.alloc(n));
  const gzipped = { "/1mib.gz": gz(MiB), "/2mib.gz": gz(2 * MiB), "/60mib-plus-1.gz": gz(60 * MiB + 1) };
  // Reason phrases undici passes through (decoded as UTF-8) but the Response constructor refuses, plus one it accepts.
  const REASONS = { euro: [0xe2, 0x82, 0xac], ctl: [0x01], nul: [0x41, 0x00, 0x42], lone: [0xe9], cafe: [...Buffer.from("Café")] };
  const rawHead = (statusLine, ...lines) => Buffer.concat([Buffer.from("HTTP/1.1 "), Buffer.from(statusLine), ...lines.map((l) => Buffer.from(`\r\n${l}`)), Buffer.from("\r\n\r\n")]);
  let seen = [], unfinished = 0; // responses that never end on their own: only the client tearing down the socket closes them
  const srv = http.createServer((req, res) => {
    seen.push([req.headers.host, req.url, req.headers.authorization ?? null]);
    if (["/hang", "/stall", "/trickle", "/reason-stall", "/bad-header-stall"].includes(req.url)) { unfinished++; res.on("close", () => unfinished--); }
    const reason = req.url.match(/^\/reason\/(\w+)$/); // raw socket writes: Node's own writer refuses these bytes
    if (reason) return req.socket.end(Buffer.concat([rawHead([...Buffer.from("200 "), ...REASONS[reason[1]]], "Content-Length: 2", "Connection: close"), Buffer.from("ok")]));
    // A megabyte of body and then silence, so undici's parser pauses on backpressure once nobody reads.
    if (req.url === "/reason-stall") return req.socket.write(Buffer.concat([rawHead([...Buffer.from("200 "), ...REASONS.euro]), Buffer.alloc(MiB, 0x20)]));
    if (req.url === "/bad-header-stall") return req.socket.write(Buffer.concat([rawHead("200 OK", "X A: b"), Buffer.alloc(MiB, 0x20)]));
    if (gzipped[req.url]) { res.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" }); return res.end(gzipped[req.url]); }
    if (req.url === "/hop") { res.writeHead(302, { location: "https://other.example/echo" }); return res.end("moved"); }
    if (req.url === "/echo") return res.end("ok");
    if (req.url === "/status-999") { res.writeHead(999); return res.end("x"); }
    if (req.url === "/raw-over-1mib") { res.writeHead(200); return res.end(Buffer.alloc(MiB + 1)); }
    if (req.url === "/stall") { res.writeHead(200); return res.write("x"); } // headers and one byte, then silence
    if (req.url === "/trickle") { // a byte every 50 ms, forever: never trips a per-chunk body timeout
      res.writeHead(200);
      const t = setInterval(() => res.write("x"), 50);
      return res.on("close", () => clearInterval(t));
    } // "/hang": never answers
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const realConnect = tls.connect, connects = [];
  tls.connect = (opts) => {
    connects.push(opts);
    const s = net.connect(srv.address().port, "127.0.0.1");
    s.once("connect", () => s.emit("secureConnect"));
    return s;
  };
  const elapsed = async (p) => { const t0 = Date.now(); await p; return Date.now() - t0; };
  try {
    // Decoded-size cap: a small gzip body can't inflate past the cap, whichever way the body is read.
    const g = guardedFetch({ ...LIMITS, maxBodyBytes: MiB });
    assert.equal((await (await g("https://c.example/1mib.gz")).arrayBuffer()).byteLength, MiB, "exactly at the cap is fine");
    for (const read of ["arrayBuffer", "json", "text"]) await assert.rejects((await g("https://c.example/2mib.gz"))[read](), NetGuardError, read);
    // Wire-size cap (the Agent's maxResponseSize) on an uncompressed body.
    await assert.rejects(g("https://c.example/raw-over-1mib").then((r) => r.arrayBuffer()), (e) => !(e instanceof NetGuardError) && e.cause?.code === "UND_ERR_RES_EXCEEDED_MAX_SIZE");
    // The production instance carries the 60 MiB default: about 60 kB of gzip on the wire, refused once decoded.
    await assert.rejects((await createGuardedFetch()("https://c.example/60mib-plus-1.gz")).arrayBuffer(), { name: "NetGuardError", message: "Response body is over 60 MB" });

    // Per-response timeouts on the Agent (undici's coarse timers make each take about a second, so run both at once).
    const t = guardedFetch({ ...LIMITS, headersTimeoutMs: 200, bodyTimeoutMs: 200, deadlineMs: 5000 });
    await Promise.all([
      assert.rejects(t("https://c.example/hang"), (e) => e.cause?.code === "UND_ERR_HEADERS_TIMEOUT"),
      assert.rejects(t("https://c.example/stall").then((r) => r.arrayBuffer()), (e) => e.cause?.code === "UND_ERR_BODY_TIMEOUT"),
    ]);
    // The caller's own signal still works, before and during the request.
    await assert.rejects(t("https://c.example/hang", { signal: AbortSignal.abort(new Error("early")) }), { message: "early" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("caller")), 50);
    await assert.rejects(t("https://c.example/hang", { signal: ac.signal }), { message: "caller" });

    // Overall deadline: covers waiting for headers and a body that trickles in under the per-chunk timeout.
    const d = guardedFetch({ ...LIMITS, headersTimeoutMs: 5000, bodyTimeoutMs: 5000, deadlineMs: 300 });
    assert.ok(await elapsed(assert.rejects(d("https://c.example/hang"), NetGuardError)) < 2000);
    const trickle = await d("https://c.example/trickle");
    assert.ok(await elapsed(assert.rejects(trickle.arrayBuffer(), { name: "NetGuardError", message: "No complete response within 0.3 s" })) < 2000);
    // A hostile reason phrase is dropped rather than failing the re-wrap after the body is in flight: the response
    // comes back, and when nobody reads its endless body the deadline (still armed) tears the connection down.
    for (const kind of ["euro", "ctl", "nul", "lone"]) {
      const r = await g(`https://c.example/reason/${kind}`);
      assert.deepEqual([r.status, r.statusText, await r.text()], [200, "", "ok"], `reason phrase ${kind}`);
    }
    const cafe = await g("https://c.example/reason/cafe");
    assert.deepEqual([cafe.statusText, await cafe.text()], ["Café", "ok"], "a valid reason phrase is kept");
    const unread = await d("https://c.example/reason-stall");
    assert.deepEqual([unread.status, unread.statusText], [200, ""]);
    // A header name undici passes but Headers refuses: NetGuardError, and the source is cancelled at once (g's deadline is 60 s).
    await assert.rejects(g("https://c.example/bad-header-stall"), { name: "NetGuardError", message: "Malformed HTTP response" });
    for (let i = 0; i < 300 && unfinished > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(unfinished, 0, "every timed-out, aborted or refused response released its connection");

    // undici's manual redirects through the guard: Location followed, credentials left behind on the old origin.
    seen = [];
    const res = await g("https://c.example/hop", { headers: { Authorization: "Bearer t" } });
    assert.equal(await res.text(), "ok");
    assert.equal(res.url, "https://other.example/echo", "url survives the body re-wrap");
    assert.deepEqual(seen, [["c.example", "/hop", "Bearer t"], ["other.example", "/echo", null]]);
    // A status no Response can carry is refused cleanly rather than escaping as a RangeError.
    await assert.rejects(g("https://c.example/status-999"), { name: "NetGuardError", message: "Unexpected HTTP status 999" });
    assert.ok(connects.length > 0 && connects.every((o) => o.lookup === guardedLookup), "every connection resolves through guardedLookup");
  } finally {
    tls.connect = realConnect;
    srv.closeAllConnections();
    srv.close();
  }
});

let failed = 0;
for (const { name, fn } of sections) {
  try { await fn(); } catch (e) { failed++; console.error(`[unit] ${name} FAILED:`, e); }
}
console.log(`[unit] ${sections.length - failed}/${sections.length} sections passed (${sections.map((s) => s.name).join(", ")})`);
if (failed) process.exitCode = 1;
