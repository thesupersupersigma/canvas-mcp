// Multi-user OAuth mode end to end: mock Canvas on 4558, the real server (dist/index.js --http with PUBLIC_URL) on 4557,
// and an MCP client. Run after `npm run build`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Sealer } from "../dist/seal.js";
import { startMockCanvas } from "./mock-canvas.mjs";

const PORT = 4557, ORIGIN = `http://127.0.0.1:${PORT}`, KEY = "k".repeat(32);
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const sealer = new Sealer(KEY);
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const until = async (what, check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await check()) return;
  throw new Error(`timed out waiting for ${what}`);
};

// Environment for child processes, without anything from the shell that would change the mode.
const baseEnv = { ...process.env };
for (const k of ["MCP_SECRET", "PUBLIC_URL", "CANVAS_MCP_KEY", "CANVAS_MCP_REDIRECT_HOSTS", "TRUST_PROXY", "CANVAS_MCP_ALLOW_PRIVATE_NETWORK",
  "CANVAS_BASE_URL", "CANVAS_URL", "CANVAS_API_TOKEN", "CANVAS_TOKEN"]) delete baseEnv[k];

/** Runs the CLI with `env` until it exits (it must, within 5 s); `.child` is the process. */
function runCli(args, env) {
  let child;
  const exited = new Promise((resolve, reject) => {
    const p = child = spawn("node", ["dist/index.js", ...args], { env: { ...baseEnv, ...env } });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { p.kill(); reject(new Error(`CLI did not exit: ${stderr}`)); }, 5000);
    p.on("exit", (code) => { clearTimeout(t); resolve({ code, stderr }); });
  });
  return Object.assign(exited, { child });
}

const mock = await startMockCanvas(4558);
const { base, token: TOKEN } = mock;
let srv, stdioClient, mcp, many, manyClient;
let stderr = "";
const checks = [];
const ok = (name) => checks.push(name);
try {
  // Startup configuration: mode conflicts and bad values exit with a clear message.
  const pub = { PUBLIC_URL: `${ORIGIN}/`, CANVAS_MCP_KEY: KEY };
  for (const [env, message] of [
    [{ ...pub, MCP_SECRET: "a".repeat(32) }, "Set either PUBLIC_URL (multi-user) or MCP_SECRET (single-user), not both"],
    [{ ...pub, CANVAS_MCP_KEY: "short" }, "CANVAS_MCP_KEY must be at least 32 characters"],
    [{ PUBLIC_URL: `${ORIGIN}/` }, "CANVAS_MCP_KEY must be at least 32 characters"],
    [{ ...pub, PUBLIC_URL: `${ORIGIN}/connector` }, "PUBLIC_URL"],
    [{ ...pub, PUBLIC_URL: `${ORIGIN}/?x=1` }, "PUBLIC_URL"],
    [{ ...pub, PUBLIC_URL: "ftp://127.0.0.1:4559" }, "PUBLIC_URL"],
    [{ ...pub, PUBLIC_URL: "canvas.example.com" }, "PUBLIC_URL"],
    [{ ...pub, PUBLIC_URL: "http://canvas.example.com" }, "PUBLIC_URL must use https"],
    [{ ...pub, CANVAS_MCP_REDIRECT_HOSTS: "https://claude.ai,claude.com" }, "CANVAS_MCP_REDIRECT_HOSTS"],
    [{ ...pub, CANVAS_MCP_REDIRECT_HOSTS: "https://claude.ai/api/mcp/auth_callback" }, "CANVAS_MCP_REDIRECT_HOSTS"],
    [{ ...pub, CANVAS_MCP_REDIRECT_HOSTS: "https://a_b.example" }, "CANVAS_MCP_REDIRECT_HOSTS"],
  ]) {
    const r = await runCli(["--http", "--port", "4559"], env);
    assert.equal(r.code, 1, `${JSON.stringify(env)} exits with an error`);
    assert.ok(r.stderr.includes(message), `${JSON.stringify(env)}: ${r.stderr}`);
  }
  ok("startup config errors");

  // Ctrl+C (SIGINT) stops the server cleanly too.
  const interrupted = runCli(["--http", "--port", "4559"], pub);
  await until("the server on 4559", async () => { try { return (await fetch("http://127.0.0.1:4559/health")).ok; } catch { return false; } });
  interrupted.child.kill("SIGINT");
  const stoppedByCtrlC = await interrupted;
  assert.equal(stoppedByCtrlC.code, 0, stoppedByCtrlC.stderr);
  assert.ok(stoppedByCtrlC.stderr.includes("canvas-mcp: SIGINT, shutting down"), stoppedByCtrlC.stderr);
  ok("SIGINT");

  srv = spawn("node", ["dist/index.js", "--http", "--port", String(PORT)],
    { env: { ...baseEnv, PUBLIC_URL: `${ORIGIN}/`, CANVAS_MCP_KEY: KEY, CANVAS_MCP_ALLOW_PRIVATE_NETWORK: "1" } });
  srv.stderr.on("data", (d) => (stderr += d));
  let exited = false;
  const exit = new Promise((resolve) => srv.on("exit", (code, signal) => resolve({ code, signal })));
  srv.on("exit", () => (exited = true));
  await until("the server's /health", async () => {
    if (exited) throw new Error(`server exited: ${stderr}`);
    try { return (await fetch(`${ORIGIN}/health`)).status === 200; } catch { return false; }
  });
  assert.equal(await (await fetch(`${ORIGIN}/health`)).text(), "ok");
  assert.ok(stderr.includes("WARNING: private network access enabled — testing only"), stderr);

  // Pages and metadata.
  const landing = await fetch(`${ORIGIN}/`);
  assert.equal(landing.status, 200);
  assert.ok((await landing.text()).includes(`<code>${ORIGIN}/mcp</code>`));
  assert.match(landing.headers.get("content-security-policy"), /form-action 'self';/);
  assert.equal(landing.headers.get("x-powered-by"), null);
  const asMeta = await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
  assert.equal(asMeta.status, 200);
  const meta = await asMeta.json();
  assert.equal(meta.authorization_endpoint, `${ORIGIN}/authorize`);
  assert.equal(meta.token_endpoint, `${ORIGIN}/token`);
  assert.equal(meta.registration_endpoint, `${ORIGIN}/register`);
  const prm = await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.status, 200);
  const resource = (await prm.json()).resource;
  assert.ok(resource.endsWith("/mcp"), resource);
  assert.equal(resource, `${ORIGIN}/mcp`);
  for (const method of ["GET", "DELETE"]) assert.equal((await fetch(`${ORIGIN}/mcp`, { method })).status, 405, `${method} /mcp`);
  ok("metadata and pages");

  // /mcp without a bearer: 401 pointing at the protected-resource metadata.
  const rpc = (body, auth, init = {}) => fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
  const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const noAuth = await rpc(listTools);
  assert.equal(noAuth.status, 401);
  assert.ok(noAuth.headers.get("www-authenticate").includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`));
  ok("401 without bearer");

  // Dynamic client registration: only allowlisted redirect URIs.
  const register = (redirect_uris, extra = {}) => fetch(`${ORIGIN}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Test", redirect_uris, ...extra }),
  });
  for (const uri of ["https://evil.example/cb", "https://claude.ai.evil.example/cb", "http://claude.ai/api/mcp/auth_callback", "https://claude.ai:8443/cb", "http://10.0.0.1:80/cb"]) {
    const r = await register([uri]);
    assert.equal(r.status, 400, uri);
    assert.equal((await r.json()).error, "invalid_client_metadata", uri);
  }
  assert.equal((await register([CALLBACK, "https://evil.example/cb"])).status, 400, "every redirect URI must be allowed");
  for (const uri of ["http://localhost:6274/oauth/callback", "http://127.0.0.1:33418/cb", "https://claude.com/api/mcp/auth_callback"])
    assert.equal((await register([uri])).status, 201, uri);
  const reg = await register([CALLBACK]);
  assert.equal(reg.status, 201);
  assert.equal(reg.headers.get("ratelimit-limit"), "300", "register: 300 per hour (claude.ai registers from shared IPs)");
  const client = await reg.json();
  assert.ok(client.client_id && client.client_secret, "confidential client by default");
  assert.equal(client.client_secret_expires_at, 0, "client secrets don't expire");
  assert.deepEqual(sealer.open("client", client.client_id).redirect_uris, [CALLBACK], "client_id is the sealed client");
  const client2 = await (await register([CALLBACK])).json();
  ok("registration allowlist");

  // /authorize renders the login form with a sealed authreq.
  const verifier = b64url(randomBytes(32)), challenge = b64url(createHash("sha256").update(verifier).digest());
  const authorizeUrl = (c, extra = {}) => `${ORIGIN}/authorize?` + new URLSearchParams({
    response_type: "code", client_id: c.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "xyz",
    resource: `${ORIGIN}/mcp`, ...extra,
  });
  const authorize = async (c) => {
    const r = await fetch(authorizeUrl(c));
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /^text\/html/);
    assert.match(r.headers.get("content-security-policy"), /form-action 'self' https:\/\/claude\.ai;/, "the login POST may end in a redirect to claude.ai");
    const html = await r.text();
    assert.ok(html.includes('name="authreq"'));
    assert.ok(html.includes("After you log in you'll go back to <strong>claude.ai</strong>."));
    return html.match(/name="authreq" value="([^"]+)"/)[1];
  };
  const authreq = await authorize(client);
  const lifetime = (purpose, t) => sealer.open(purpose, t).exp - Date.now() / 1000;
  const pendingReq = sealer.open("authreq", authreq);
  assert.deepEqual([pendingReq.client_id, pendingReq.redirect_uri, pendingReq.code_challenge, pendingReq.state], [client.client_id, CALLBACK, challenge, "xyz"]);
  assert.ok(lifetime("authreq", authreq) > 590 && lifetime("authreq", authreq) <= 600, "authreq: 10 minutes");
  assert.equal((await fetch(authorizeUrl(client, { redirect_uri: "https://claude.ai/other" }))).status, 400, "unregistered redirect_uri");
  assert.equal((await fetch(authorizeUrl({ client_id: "forged" }))).status, 400, "unknown client");
  ok("authorize renders the login page");

  // POST /login.
  let logins = 0; // same-origin posts, which count toward the per-IP limit
  const login = (fields, headers) => {
    if (!headers) logins++;
    return fetch(`${ORIGIN}/login`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(headers ?? { Origin: ORIGIN }) }, body: new URLSearchParams(fields), redirect: "manual",
    });
  };
  const cross = await login({ authreq, canvas_url: "https://attacker-canvas.example", token: "x" }, { Origin: "https://evil.example" });
  assert.equal(cross.status, 403, "cross-site POST /login");
  const crossHtml = await cross.text();
  assert.ok(!crossHtml.includes("attacker-canvas"), "the posted canvas_url is never shown back");
  assert.match(cross.headers.get("content-security-policy"), /form-action 'self';/);
  assert.equal((await login({ authreq, canvas_url: base, token: TOKEN }, { "Sec-Fetch-Site": "cross-site", Origin: ORIGIN })).status, 403, "Sec-Fetch-Site decides");

  const wrong = await login({ authreq, canvas_url: base, token: "wrong", tz: "America/New_York" });
  assert.equal(wrong.status, 200);
  const wrongHtml = await wrong.text();
  assert.ok(wrongHtml.includes("Canvas rejected that token"));
  assert.ok(wrongHtml.includes(`value="${base}"`), "the entered URL is kept");
  assert.ok(wrongHtml.includes(`name="authreq" value="${authreq}"`), "the same authreq");
  assert.match(wrong.headers.get("content-security-policy"), /form-action 'self' https:\/\/claude\.ai;/, "re-render keeps the redirect origin");
  const badUrl = await login({ authreq, canvas_url: "javascript:alert(1)", token: TOKEN });
  assert.equal(badUrl.status, 200);
  assert.ok((await badUrl.text()).includes("Enter your school&#39;s Canvas address"));

  const good = await login({ authreq, canvas_url: `${base}/courses/101`, token: `  ${TOKEN}\n` });
  assert.equal(good.status, 302);
  const back = new URL(good.headers.get("location"));
  assert.equal(back.origin + back.pathname, CALLBACK);
  assert.equal(back.searchParams.get("state"), "xyz");
  const code = back.searchParams.get("code");
  assert.ok(lifetime("code", code) > 50 && lifetime("code", code) <= 60, "code: 60 seconds");
  assert.match(good.headers.get("location"), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=[^&]+&state=xyz$/);

  const expired = sealer.seal("authreq", { client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, state: "xyz", scopes: [] }, -1);
  const stale = await login({ authreq: expired, canvas_url: base, token: TOKEN });
  assert.equal(stale.status, 400);
  assert.match(await stale.text(), /start again/i);
  assert.equal((await login({ authreq: "garbage", canvas_url: base, token: TOKEN })).status, 400, "a forged authreq");
  ok("login form");

  // /token: PKCE, single use, client binding.
  const token = (fields, c = client) => fetch(`${ORIGIN}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, ...fields }),
  });
  const exchange = (fields, c) => token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK, ...fields }, c);
  const badVerifier = await exchange({ code_verifier: b64url(randomBytes(32)) });
  assert.equal(badVerifier.status, 400);
  assert.equal((await badVerifier.json()).error, "invalid_grant");
  assert.equal((await exchange({}, client2)).status, 400, "another client can't use the code");
  assert.equal((await exchange({ redirect_uri: "https://claude.ai/other" })).status, 400, "redirect_uri must match");
  assert.equal((await exchange({ client_secret: "wrong" })).status, 400, "client secret checked");
  const issued = await exchange({ resource: `${ORIGIN}/mcp` });
  assert.equal(issued.status, 200, "failed attempts didn't use up the code");
  assert.equal(issued.headers.get("ratelimit-limit"), "1000", "token: 1000 per 15 min (claude.ai calls from shared IPs)");
  const tokens = await issued.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.token_type.toLowerCase(), "bearer");
  const reused = await exchange({});
  assert.equal(reused.status, 400, "a code works once");
  assert.equal((await reused.json()).error, "invalid_grant");
  assert.deepEqual(sealer.open("access", tokens.access_token).cred, { url: base, token: TOKEN, tz: "UTC" }, "trimmed token, canonical origin, tz defaulted");
  assert.ok(lifetime("access", tokens.access_token) > 3590 && lifetime("access", tokens.access_token) <= 3600, "access: 1 hour");
  assert.ok(lifetime("refresh", tokens.refresh_token) > 7_776_000 - 10 && lifetime("refresh", tokens.refresh_token) <= 7_776_000, "refresh: 90 days");
  ok("token exchange");

  // The MCP client with the bearer: same tools as stdio mode, and real Canvas data.
  stdioClient = new Client({ name: "t", version: "1" });
  await stdioClient.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...baseEnv, CANVAS_BASE_URL: base, CANVAS_API_TOKEN: TOKEN }, stderr: "ignore" }));
  const stdioTools = (await stdioClient.listTools()).tools.map((t) => t.name).sort();
  mcp = new Client({ name: "t", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  assert.deepEqual((await mcp.listTools()).tools.map((t) => t.name).sort(), stdioTools);
  assert.ok(stdioTools.length > 5);
  const courses = await mcp.callTool({ name: "list_courses", arguments: {} });
  assert.ok(!courses.isError && courses.content[0].text.includes("APUSH"), courses.content[0].text);
  const limited = await rpc(listTools, tokens.access_token);
  assert.equal(limited.status, 200);
  assert.equal(limited.headers.get("ratelimit-limit"), "120", "/mcp: 120 per minute");
  ok("MCP over OAuth");

  // A file whose zip contents inflate past the cap (17 kB on the wire, 17 MiB inflated) is a tool error; the server carries on.
  for (const file_id of ["903", "904"]) {
    const bomb = await mcp.callTool({ name: "read_file", arguments: { file_id } });
    assert.ok(bomb.isError, file_id);
    assert.equal(bomb.content[0].text, "File is too large to read here.", file_id);
  }
  assert.equal(await (await fetch(`${ORIGIN}/health`)).text(), "ok");
  assert.ok((await mcp.callTool({ name: "read_file", arguments: { file_id: "901" } })).content[0].text.includes("--- Slide 1 ---"), "a real .pptx still reads");
  ok("zip bombs refused");

  // One request's Canvas work has a budget. get_calendar over a Canvas with 1,000 courses needs 110 fetches (10 pages of
  // courses, then 100 batches of events): the 101st is refused before it leaves, and the next request starts afresh.
  // An API page over 16 MiB is refused on its own (stdio mode reads it).
  many = await startMockCanvas(4560, { courses: 1000 });
  manyClient = new Client({ name: "t", version: "1" });
  const manyBearer = sealer.seal("access", { client_id: client.client_id, cred: { url: many.base, token: TOKEN, tz: "UTC" } }, 3600);
  await manyClient.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${manyBearer}` } } }));
  const calendar = await manyClient.callTool({ name: "get_calendar", arguments: {} });
  assert.ok(calendar.isError);
  assert.equal(calendar.content[0].text, "This request needed too much data from Canvas.");
  assert.equal(many.requests(), 100, "exactly 100 fetches reached Canvas");
  const manyCourses = await manyClient.callTool({ name: "list_courses", arguments: {} });
  assert.ok(!manyCourses.isError && manyCourses.content[0].text.includes("Course 1000"), "the next request has a budget of its own");
  const hugePage = await mcp.callTool({ name: "list_pages", arguments: { course_id: "104" } });
  assert.ok(hugePage.isError);
  assert.match(hugePage.content[0].text, /more than 16 MB/);
  const hugeLocally = await stdioClient.callTool({ name: "list_pages", arguments: { course_id: "104" } });
  assert.ok(!hugeLocally.isError && hugeLocally.content[0].text.includes("Huge"), "no page cap in stdio mode");
  ok("request budget");

  // Refresh, and tokens that must not work.
  const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.ok(next.access_token && next.refresh_token && next.access_token !== tokens.access_token);
  assert.equal(next.expires_in, 3600);
  assert.equal((await rpc(listTools, next.access_token)).status, 200, "the refreshed access token works");
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, client2)).status, 400, "another client can't refresh");
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: tokens.access_token })).status, 400, "an access token is not a refresh token");
  const cred = { url: base, token: TOKEN, tz: "UTC" };
  const flip = (t) => t.slice(0, 20) + (t[20] === "A" ? "B" : "A") + t.slice(21);
  for (const [bad, why] of [[tokens.refresh_token, "refresh token as bearer"], [sealer.seal("access", { client_id: client.client_id, cred }, -1), "expired access token"],
    [flip(tokens.access_token), "one character changed"], [new Sealer("z".repeat(32)).seal("access", { client_id: client.client_id, cred }, 3600), "other key"],
    [code, "authorization code as bearer"]]) {
    const r = await rpc(listTools, bad);
    assert.equal(r.status, 401, why);
    assert.ok(r.headers.get("www-authenticate").includes("resource_metadata="), why);
  }
  ok("refresh and rejected tokens");

  // In-flight /mcp work: at most 6 requests per Canvas credential and 16 in all. Refusals come with Retry-After and a JSON-RPC body.
  // Bearer tokens for Canvas credential n: 0 is the one from the OAuth flow, the others are sealed here for test-token-n.
  const bearerFor = (n) => n ? sealer.seal("access", { client_id: client.client_id, cred: { url: base, token: `${TOKEN}-${n}`, tz: "UTC" } }, 3600) : tokens.access_token;
  const call = (bearer, id, init) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_syllabus", arguments: { course_id: 999 } } }, bearer, init);
  const hold = (n, count, firstId, init) => Array.from({ length: count }, (_, i) => call(bearerFor(n), firstId + i, init));
  // 16 requests held at once: 6 + 6 + 4 from credentials 0, 1 and 2.
  const sixteen = (firstId, init) => [...hold(0, 6, firstId, init), ...hold(1, 6, firstId + 6, init), ...hold(2, 4, firstId + 12, init)];
  const held = (n) => until(`${n} requests held at the mock Canvas`, () => mock.held() === n);
  const refused = async (r, status, why) => {
    assert.equal(r.status, status, why);
    assert.equal(r.headers.get("retry-after"), "5", why);
    const body = await r.json();
    assert.equal(body.jsonrpc, "2.0", why);
    assert.ok(body.error?.message, why);
  };
  const allHeld = async (responses) => {
    for (const r of await Promise.all(responses)) {
      assert.equal(r.status, 200);
      assert.ok((await r.text()).includes("Held course"));
    }
  };
  const first = hold(0, 6, 100);
  await held(6);
  // Without the caps these would be held too, hence the timeouts.
  await refused(await call(next.access_token, 120, { signal: AbortSignal.timeout(5000) }), 429, "a 7th request for one credential, from any of its tokens");
  const others = [...hold(1, 6, 106), ...hold(2, 4, 112)];
  await held(16);
  await refused(await call(bearerFor(3), 121, { signal: AbortSignal.timeout(5000) }), 503, "the 17th request");
  mock.release();
  await allHeld([...first, ...others]);
  assert.equal((await rpc(listTools, tokens.access_token)).status, 200, "slots released");
  ok("concurrency cap");

  // Clients that hang up: their Canvas requests are cancelled, and the slots come back once that work has settled.
  const hangUp = new AbortController();
  const abandoned = sixteen(200, { signal: hangUp.signal }).map((p) => p.then(() => "answered", (e) => e.name));
  await held(16);
  hangUp.abort();
  assert.deepEqual([...new Set(await Promise.all(abandoned))], ["AbortError"]);
  await until("the abandoned Canvas requests to close", () => mock.held() === 0);
  const resumed = sixteen(300, { signal: AbortSignal.timeout(10_000) });
  await held(16);
  mock.release();
  await allHeld(resumed);
  ok("hang-up cancels Canvas work");

  // JSON-RPC batches of 1 to 8 messages run in one slot, on one budget; bigger or empty ones are refused before anything
  // reaches Canvas.
  const batch = (n, course_id = 102) => Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "get_syllabus", arguments: { course_id } } }));
  for (const n of [2, 8]) {
    const answered = await rpc(batch(n), bearerFor(4));
    assert.equal(answered.status, 200, `a batch of ${n}`);
    const answers = await answered.json();
    assert.deepEqual(answers.map((a) => a.id).sort((a, b) => a - b), batch(n).map((m) => m.id), `${n} answers`);
    assert.ok(answers.every((a) => !a.result.isError && a.result.content[0].text.includes("Tests are")), `a batch of ${n}`);
  }
  for (const n of [9, 0]) {
    const r = await rpc(batch(n, 999), bearerFor(4), { signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 400, `a batch of ${n}`);
    assert.equal((await r.json()).error?.code, -32600, `a batch of ${n}`);
  }
  assert.equal(mock.held(), 0, "nothing reached Canvas");
  ok("batches of up to 8");

  // A body that isn't JSON: a generic 400, and nothing of it in the log (V8's parse error quotes a short body whole).
  const garbled = await rpc('{"t": LEAK9}', tokens.access_token);
  assert.equal(garbled.status, 400);
  assert.ok(!(await garbled.text()).includes("LEAK9"));
  // Bodies up to 256 kB.
  const padded = (n) => ({ ...listTools, params: { _meta: { pad: "x".repeat(n) } } });
  assert.equal((await rpc(padded(200_000), bearerFor(4))).status, 200, "200 kB");
  assert.equal((await rpc(padded(300_000), bearerFor(4))).status, 413, "300 kB");

  // The /mcp limit is per Canvas credential, not per IP: the same Canvas reached as "localhost" is another credential.
  const authreq2 = await authorize(client);
  const good2 = await login({ authreq: authreq2, canvas_url: base.replace("127.0.0.1", "localhost"), token: TOKEN, tz: "America/New_York" });
  assert.equal(good2.status, 302);
  const code2 = new URL(good2.headers.get("location")).searchParams.get("code");
  const other = await (await token({ grant_type: "authorization_code", code: code2, code_verifier: verifier, redirect_uri: CALLBACK })).json();
  assert.equal(sealer.open("access", other.access_token).cred.tz, "America/New_York");
  let sent = 0, last;
  do { last = await rpc(listTools, next.access_token); sent++; } while (last.status === 200 && sent < 200);
  assert.equal(last.status, 429, "the first credential is rate limited");
  assert.ok(sent <= 120, `limited within 120 requests (${sent})`);
  assert.equal((await rpc(listTools, tokens.access_token)).status, 429, "every token for that credential shares the limit");
  assert.equal((await rpc(listTools, other.access_token)).status, 200, "another credential from the same IP is not");
  ok("per-credential /mcp rate limit");

  // POST /login: 10 per 15 minutes per IP; cross-site posts are refused before they count.
  let limitedLogin;
  while (logins < 20) {
    limitedLogin = await login({ authreq: expired, canvas_url: base, token: TOKEN });
    if (limitedLogin.status === 429) break;
    assert.equal(limitedLogin.status, 400);
  }
  assert.equal(logins, 11, "the 11th same-origin POST /login is refused");
  assert.match(limitedLogin.headers.get("content-type"), /^text\/html/);
  assert.match(limitedLogin.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await login({ authreq }, { Origin: "https://evil.example" })).status, 403);
  // TRUST_PROXY defaults to loopback (and private ranges): behind a local proxy, the forwarded client address is the key.
  const forwarded = await login({ authreq: expired, canvas_url: base, token: TOKEN }, { Origin: ORIGIN, "X-Forwarded-For": "203.0.113.9" });
  assert.equal(forwarded.status, 400, "another client behind the proxy is not limited");
  ok("login rate limit");

  // Nothing secret in the log.
  for (const secret of [TOKEN, tokens.access_token, tokens.refresh_token, next.access_token, code, "LEAK9", authreq])
    assert.ok(!stderr.includes(secret), `log leaks ${secret.slice(0, 12)}…`);
  ok("log is clean");

  // SIGTERM (docker stop): no new connections, an open request still gets its answer, then exit 0 at once, well inside
  // the 10 s docker waits before SIGKILL.
  const open = call(bearerFor(5), 900);
  open.catch(() => {}); // awaited below; a failure must not crash the run before then
  await held(1);
  const stopped = Date.now();
  srv.kill("SIGTERM");
  await until("the server to stop accepting connections", async () => {
    try { await fetch(`${ORIGIN}/health`); return false; } catch { return true; }
  });
  mock.release();
  const answer = await open;
  assert.equal(answer.status, 200);
  assert.ok((await answer.text()).includes("Held course"), "the open request was answered");
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.ok(Date.now() - stopped < 3000, `exited ${Date.now() - stopped} ms after SIGTERM, without waiting out the grace period`);
  ok("SIGTERM");
} finally {
  console.log(`[oauth] ${checks.length} checks passed: ${checks.join(", ")}`);
  await mcp?.close().catch(() => {});
  await manyClient?.close().catch(() => {});
  await stdioClient?.close().catch(() => {});
  srv?.kill();
  mock.release();
  await mock.close();
  await many?.close();
}
