// Unit tests for the multi-user building blocks (no network). Run after `npm run build`.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
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

let failed = 0;
for (const { name, fn } of sections) {
  try { await fn(); } catch (e) { failed++; console.error(`[unit] ${name} FAILED:`, e); }
}
console.log(`[unit] ${sections.length - failed}/${sections.length} sections passed (${sections.map((s) => s.name).join(", ")})`);
if (failed) process.exitCode = 1;
