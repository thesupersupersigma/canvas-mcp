# Multi-user OAuth Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve canvas-mcp as an open, multi-user claude.ai custom connector at `<PUBLIC_URL>/mcp`, where each student logs in with their own Canvas URL + token via OAuth, with nothing stored server-side.

**Architecture:** An Express app mounts the MCP SDK's `mcpAuthRouter` with a stateless `OAuthServerProvider` whose client ids, auth codes, access and refresh tokens are AES-256-GCM sealed blobs. `/mcp` verifies the bearer token, builds a per-request `CanvasClient` whose `fetch` is wrapped by a network guard that refuses non-public addresses, and runs the existing tools over a stateless Streamable HTTP transport.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥ 20, `@modelcontextprotocol/sdk` 1.31, `express` 5, `undici`, `node:crypto`, tests as plain `node` scripts with `node:assert/strict` against `dist/`.

**Spec:** `docs/superpowers/specs/2026-10-07-multi-user-connector-design.md`

## Global Constraints

- stdio, `--check`, and single-user `--http` + `MCP_SECRET` behave exactly as before.
- `--http` with `PUBLIC_URL` → multi-user; with `MCP_SECRET` → single-user; both set → exit with an error.
- `CANVAS_MCP_KEY` ≥ 32 chars; key derived with HKDF-SHA256; token format `base64url(iv[12] ‖ ciphertext ‖ tag[16])`, purpose bound as GCM AAD.
- Lifetimes: `authreq` 600 s, `code` 60 s single use, `access` 3600 s, `refresh` 90 days (7 776 000 s), `client` no expiry.
- Redirect allowlist default: `https://claude.ai`, `https://claude.com`, loopback `http://localhost:*` / `http://127.0.0.1:*`; override `CANVAS_MCP_REDIRECT_HOSTS` (comma-separated origins).
- Rate limits: `POST /login` 10 per 15 min per IP; `/mcp` 120 per minute keyed by hash of the Canvas credential.
- `TRUST_PROXY` default `loopback, linklocal, uniquelocal`.
- Never log tokens, request bodies, or Authorization headers.
- No personal names, schools, domains, or locations anywhere; placeholders `canvas.example.com`, `yourschool.instructure.com`; example time zone `America/New_York`.
- Commit directly to `master`.

## Review Focus

1. Canvas URL typed loosely (`yourschool.instructure.com`, `https://yourschool.instructure.com/courses/12`, trailing slash, `/api/v1`) → normalized to the origin, not rejected. Pinned in Task 4.
2. Token pasted with surrounding spaces/newline → trimmed before use. Pinned in Task 4.
3. Browser sends no or a bogus time zone (JS off) → `UTC`, not a crash. Pinned in Task 4.
4. Login form submitted after the 10-minute `authreq` expired → a readable "start again from Claude" page (400), not a stack trace. Pinned in Task 5.
5. `PUBLIC_URL` given with a trailing slash → metadata and resource URLs have no `//`. Pinned in Task 5.

---

### Task 1: Split `index.ts`, injectable fetch, neutral time zone

**Files:**
- Create: `src/server.ts`, `src/http.ts`
- Modify: `src/index.ts`, `src/canvas.ts`, `test/mock-test.mjs`, `README.md`, `.env.example`, `package.json`

**Interfaces:**
- Produces:
  - `src/server.ts`: `export const VERSION = "1.0.0"`; `export function buildServer(canvas: CanvasClient, opts: ToolOptions): McpServer` (instructions text moved verbatim).
  - `src/http.ts`: `export function startSecretHttp(o: { secret: string; port: number; host: string; baseUrl: string; make: () => McpServer }): void` (today's `http()` body moved; validation of secret length stays in `index.ts`).
  - `src/canvas.ts`: `CanvasConfig.fetch?: typeof fetch`, used by `raw()` and `download()` (default `globalThis.fetch`).

- [ ] **Step 1:** Move code as above; `index.ts` keeps arg parsing, `check()`, `stdio()`, and dispatch. Canvas URL/token presence checks move inside the stdio/check/single-user paths (multi-user won't need them).
- [ ] **Step 2:** Replace `America/Indianapolis` with `America/New_York` in README, `.env.example`, `test/mock-test.mjs`.
- [ ] **Step 3:** Make `mock-test.mjs` assert instead of only printing: `assert.equal(wrong.status, 404)`, `assert.equal(health, 200)`, every stdio tool call except `read_file 902` and `get_page nope` has `!isError`, and `list_courses` text contains `APUSH` and `AP Bio`.
- [ ] **Step 4:** `package.json` `test` → `npm run build && node test/unit-test.mjs && node test/mock-test.mjs && node test/oauth-test.mjs` (the two new files get created in later tasks; until then run `npm run build && node test/mock-test.mjs`).
- [ ] **Step 5:** Run `npm run build && node test/mock-test.mjs` → exits 0.
- [ ] **Step 6:** Commit `refactor: split server setup and secret-URL HTTP mode out of index.ts`.

### Task 2: Sealed tokens (`src/seal.ts`)

**Files:** Create `src/seal.ts`, `test/unit-test.mjs`

**Interfaces:**
- Produces: `export type Purpose = "client" | "authreq" | "code" | "access" | "refresh"`; `export class Sealer { constructor(secret: string); seal(purpose: Purpose, payload: Record<string, unknown>, ttlSeconds?: number): string; open<T = any>(purpose: Purpose, token: string): T | null }`. `seal` adds `exp` when `ttlSeconds` is given; `open` returns `null` on bad base64, tamper, wrong purpose, or `exp` ≤ now. Constructor throws `Error("CANVAS_MCP_KEY must be at least 32 characters")` when short.

- [ ] **Step 1: Write failing tests** in `test/unit-test.mjs` (imports `../dist/seal.js`):
  - round trip: `open("access", seal("access", {a:1}, 60)).a === 1`
  - wrong purpose: `open("refresh", seal("access", …))` → `null`
  - tamper: flip one char in the middle → `null`
  - expired: `seal("access", {}, -1)` → `open` → `null`
  - other key: `new Sealer("b".repeat(32)).open(...)` of a token from `"a".repeat(32)` → `null`
  - garbage input `"!!"` → `null`; short key → throws
- [ ] **Step 2:** `npm run build; node test/unit-test.mjs` → fails (module missing).
- [ ] **Step 3:** Implement with `hkdfSync("sha256", secret, "", "canvas-mcp seal v1", 32)`, `randomBytes(12)`, `createCipheriv("aes-256-gcm")`, `setAAD(Buffer.from(purpose))`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat: add sealed stateless tokens`.

### Task 3: Network guard (`src/netguard.ts`)

**Files:** Create `src/netguard.ts`; modify `test/unit-test.mjs`, `package.json` (add `undici`)

**Interfaces:**
- Produces: `export function isPublicAddress(ip: string): boolean`; `export function createGuardedFetch(o?: { allowPrivate?: boolean }): typeof fetch`; `export class NetGuardError extends Error`.
- Behavior: rejects non-`https:` (unless `allowPrivate`); IP-literal hosts checked with `isPublicAddress`; DNS results checked inside an `undici` `Agent({ connect: { lookup } })`; `redirect: "manual"` loop ≤ 5 hops, each hop re-checked, `Authorization` header dropped when the origin changes. Uses `undici`'s `fetch` with that agent. With `allowPrivate` it returns plain `globalThis.fetch`.
- Blocked: `0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, ::, ::1, fc00::/7, fe80::/10, ff00::/8`, and IPv4-mapped `::ffff:x` of blocked v4.

- [ ] **Step 1: Failing tests:** `isPublicAddress` false for `127.0.0.1, 10.1.2.3, 172.20.0.1, 192.168.1.1, 169.254.169.254, 100.64.0.1, ::1, fd00::1, fe80::1, ::ffff:127.0.0.1, 0.0.0.0`; true for `8.8.8.8, 1.1.1.1, 2606:4700::1111`. Guarded fetch rejects (`NetGuardError`) `http://example.com`, `https://127.0.0.1/`, `https://[::1]/`, `https://localhost/`.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3:** `npm i undici`; implement with `node:net` `isIP` + numeric range checks.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat: add outbound network guard for multi-user mode`.

### Task 4: Login helpers and pages (`src/login.ts`, `src/pages.ts`)

**Files:** Create `src/login.ts`, `src/pages.ts`; modify `test/unit-test.mjs`

**Interfaces:**
- Produces (`login.ts`):
  - `export interface CanvasCred { url: string; token: string; tz: string }`
  - `export function normalizeCanvasUrl(input: string, allowHttp?: boolean): string | null` → origin only (`https://host`), adds `https://` when no scheme, rejects other schemes / empty / with credentials.
  - `export function normalizeTimeZone(tz: unknown): string` → valid IANA name or `"UTC"`.
  - `export async function verifyCanvasLogin(cred: CanvasCred, f: typeof fetch): Promise<string | null>` → `null` on success, else a user-facing error: 401 → "Canvas rejected that token…", network/guard error → "Couldn't reach a Canvas server at that address.", non-JSON / no `id` → "That doesn't look like a Canvas server."
- Produces (`pages.ts`): `export function escapeHtml(s: string): string`; `export function landingPage(publicUrl: string): string`; `export function loginPage(p: { authreq: string; redirectHost: string; error?: string; canvasUrl?: string }): string`; `export function errorPage(message: string): string`; `export const PAGE_HEADERS: Record<string, string>` (CSP with the tz script's `sha256-…` hash, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`).
- Login form posts to `/login` with fields `authreq`, `canvas_url`, `token`, `tz`. Copy: token steps (Canvas → Account → Settings → Approved Integrations → + New Access Token), warning that the token is full-power, the operator is trusted with it, and deleting it in Canvas revokes access.

- [ ] **Step 1: Failing tests:** `normalizeCanvasUrl("yourschool.instructure.com")`, `("https://yourschool.instructure.com/courses/12")`, `("HTTPS://YourSchool.instructure.com/api/v1/")` all → `"https://yourschool.instructure.com"`; `("http://x.com")` → `null`, `("http://x.com", true)` → `"http://x.com"`; `("javascript:alert(1)")`, `("")`, `("https://u:p@x.com")` → `null`. `normalizeTimeZone("America/New_York")` → same; `(undefined)`, `("Not/AZone")` → `"UTC"`. `escapeHtml('<a href="x">&\'')` → `&lt;a href=&quot;x&quot;&gt;&amp;&#39;`. `loginPage({…, error: "<b>"})` contains `&lt;b&gt;` and not `<b>`.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3:** Implement. Token trimming happens in the `/login` handler (Task 5).
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat: add login page and Canvas login validation`.

### Task 5: OAuth provider, public app, CLI wiring (`src/oauth.ts`, `src/public.ts`)

**Files:** Create `src/oauth.ts`, `src/public.ts`, `test/oauth-test.mjs`; modify `src/index.ts`, `package.json` (add `express`, dev `@types/express`)

**Interfaces:**
- Consumes: `Sealer` (Task 2), `createGuardedFetch` (Task 3), `CanvasCred`, `normalize*`, `verifyCanvasLogin`, pages (Task 4), `buildServer` (Task 1).
- Produces (`oauth.ts`):
  - `export function redirectAllowed(uri: string, origins: string[]): boolean` — exact origin match for https entries; any port for loopback `http://localhost` / `http://127.0.0.1`.
  - `export class StatelessProvider implements OAuthServerProvider` with `constructor(o: { sealer: Sealer; redirectOrigins: string[] })`, the SDK methods, plus `completeLogin(authreq: string, cred: CanvasCred): string | null` (returns redirect URL with `code` and `state`, or `null` if `authreq` invalid/expired) and `openAuthReq(authreq: string): { redirectUri: string } | null`.
  - `registerClient` throws the SDK's `InvalidClientMetadataError` when any redirect URI is not allowed; returns info with `client_id = seal("client", info-without-client_id)`.
  - Used code `jti`s kept in a `Map<string, number>` (jti → exp), pruned on each insert.
  - `verifyAccessToken` throws the SDK's `InvalidTokenError` on `null`; returns `{ token, clientId, scopes: [], expiresAt, extra: { cred } }`.
- Produces (`public.ts`): `export function createPublicApp(o: { publicUrl: string; key: string; redirectOrigins: string[]; trustProxy: string; allowPrivateNetwork: boolean; maxChars: number }): Express` and `export function startPublicHttp(app: Express, port: number, host: string): void`.
  - `mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl), resourceServerUrl: new URL("/mcp", publicUrl), clientRegistrationOptions: { clientSecretExpirySeconds: 0 } })`.
  - `POST /mcp`: `requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) })` → rate limit → `buildServer(new CanvasClient({ baseUrl: cred.url, token: cred.token, fetch: guardedFetch }), { timeZone: cred.tz, maxChars })` on a stateless JSON transport (`express.json({ limit: "1mb" })`). `GET`/`DELETE /mcp` → 405.
- `index.ts`: `--http` + `PUBLIC_URL` (trailing slashes stripped) + `CANVAS_MCP_KEY` → public mode; both `PUBLIC_URL` and `MCP_SECRET` → `die("Set either PUBLIC_URL (multi-user) or MCP_SECRET (single-user), not both")`. `CANVAS_MCP_ALLOW_PRIVATE_NETWORK=1` logs `WARNING: private network access enabled — testing only`.

- [ ] **Step 1: Failing tests** in `test/oauth-test.mjs`: start the mock Canvas from `mock-test.mjs` (extract its routes/server into `test/mock-canvas.mjs` exporting `startMockCanvas(port): Promise<{ base, token, close }>`), spawn `dist/index.js --http --port 4557` with `PUBLIC_URL=http://127.0.0.1:4557/`, `CANVAS_MCP_KEY="k".repeat(32)`, `CANVAS_MCP_ALLOW_PRIVATE_NETWORK=1`. Assert:
  - `GET /.well-known/oauth-authorization-server` → 200, `authorization_endpoint === "http://127.0.0.1:4557/authorize"` (no `//`); protected-resource metadata `resource` ends in `/mcp`.
  - `POST /mcp` without bearer → 401 with `WWW-Authenticate` containing `resource_metadata`.
  - register with `redirect_uris: ["https://evil.example/cb"]` → 400; with `["https://claude.ai/api/mcp/auth_callback"]` → 201.
  - `GET /authorize?…&code_challenge=<S256>` → 200 HTML containing `name="authreq"`.
  - `POST /login` with wrong token → 200 page containing "Canvas rejected that token"; with `"  " + token + "\n"` and `tz` missing → 302 to `https://claude.ai/api/mcp/auth_callback?code=…&state=xyz`.
  - `POST /login` with an `authreq` sealed with ttl −1 (via `dist/seal.js`) → 400 page containing "start again".
  - `POST /token` with wrong verifier → 400; with right verifier → 200 with `access_token`, `refresh_token`, `expires_in: 3600`; same code again → 400.
  - MCP client (`StreamableHTTPClientTransport` with `requestInit.headers.Authorization`) → `listTools` returns the same tool names as stdio mode; `list_courses` text contains `APUSH`.
  - refresh grant → new access token that also works; the refresh token as bearer → 401; access token sealed with ttl −1 → 401; access token with one char flipped → 401.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3:** `npm i express && npm i -D @types/express`; implement `oauth.ts`, `public.ts`, CLI wiring. `/login` handler: `express.urlencoded({ limit: "10kb" })`, per-IP rate limit, `openAuthReq` → `errorPage("This login link expired. Start again from Claude.")` 400 on null; normalize URL (error "Enter your school's Canvas address…"), trim token, `normalizeTimeZone`, `verifyCanvasLogin` with the guarded fetch; on error re-render `loginPage` with the error and the entered URL; on success `res.redirect(302, completeLogin(...))`.
- [ ] **Step 4:** `npm test` → all three test files pass.
- [ ] **Step 5:** Commit `feat: multi-user OAuth connector mode`.

### Task 6: Docs

**Files:** Modify `README.md`, `.env.example`, `--help` text in `src/index.ts`

- [ ] **Step 1:** README "Option D: Host it for everyone (multi-user)": what students see; Coolify steps (Dockerfile resource, env `PUBLIC_URL`, `CANVAS_MCP_KEY` from `openssl rand -hex 32`, port 7341, `/health`); public HTTPS via Cloudflare Tunnel (domain DNS must be on Cloudflare) or another reverse proxy; security notes (operator trust, key rotation logs everyone out, students revoke by deleting their Canvas token); new env vars table. Add env vars (commented) to `.env.example` and `--help`.
- [ ] **Step 2:** `grep -rniE "indianapolis|thesuper" --exclude-dir=node_modules --exclude-dir=.git .` → no matches.
- [ ] **Step 3:** `npm test` → passes. Commit `docs: multi-user hosting guide`, push `master`.
