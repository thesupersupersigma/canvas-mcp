// Unit tests for the multi-user building blocks (no network). Run after `npm run build`.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import { createGuardedFetch, guardedLookup, isPublicAddress, NetGuardError, withUrlGuard } from "../dist/netguard.js";
import { Sealer } from "../dist/seal.js";

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
});

let failed = 0;
for (const { name, fn } of sections) {
  try { await fn(); } catch (e) { failed++; console.error(`[unit] ${name} FAILED:`, e); }
}
console.log(`[unit] ${sections.length - failed}/${sections.length} sections passed (${sections.map((s) => s.name).join(", ")})`);
if (failed) process.exitCode = 1;
