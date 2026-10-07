# Multi-user claude.ai connector (OAuth) — design

## Goal

Let any student add one public URL (`https://canvas.example.com/mcp`) as a custom
connector in claude.ai, log in with their own Canvas URL + access token, and use
all existing read-only tools — with no secret in the URL and nothing stored on
the server.

Existing modes stay as they are: stdio (Claude Desktop / Claude Code), `--check`,
and single-user `--http` with `/mcp/<MCP_SECRET>`.

## Decisions

| Question | Decision |
|---|---|
| Hosting | Self-hosted Docker (e.g. Coolify) behind a public HTTPS hostname |
| Auth | OAuth 2.1 as an MCP authorization server (SDK `mcpAuthRouter`) |
| Schools | Any Canvas instance; student enters URL + token |
| Sign-up | Open to anyone (no invite code) |
| Storage | Stateless: all credentials live inside encrypted tokens held by the client |

## Student flow

1. `GET /` — short landing page: "Add `<PUBLIC_URL>/mcp` in claude.ai → Settings → Connectors."
2. claude.ai discovers OAuth metadata, registers itself (dynamic client registration),
   and opens `/authorize` in the browser.
3. `/authorize` renders the login page: Canvas URL, access token, step-by-step
   "how to make a token", and a plain warning: Canvas tokens are full-power, the
   server operator is trusted with it, and deleting the token in Canvas
   (Account → Settings → Approved Integrations) cuts access off immediately.
   A hidden field is filled with the browser's IANA time zone.
4. `POST /login` validates the URL, calls `GET /api/v1/users/self` with the token,
   and on success redirects to the client's `redirect_uri` with `code` + `state`.
   On failure it re-renders the form with a specific error (bad URL, 401, not reachable).
5. claude.ai exchanges the code (PKCE S256) at `/token` and calls `/mcp` with the bearer token.

## Sealed tokens (`src/seal.ts`)

- AES-256-GCM. Key = HKDF-SHA256(`CANVAS_MCP_KEY`), where `CANVAS_MCP_KEY` must be ≥ 32 chars
  (`openssl rand -hex 32`).
- Format: `base64url(iv[12] ‖ ciphertext ‖ tag[16])`. The token's *purpose* is bound as
  GCM additional data, so a token of one kind can never be used as another.
- Payload is JSON with `exp` (unix seconds) where applicable; `open()` rejects
  tampered, wrong-purpose, or expired tokens.

| Purpose | Contents | Lifetime |
|---|---|---|
| `client` (= `client_id`) | full registered client info (redirect URIs, secret if any) | no expiry |
| `authreq` (hidden form field) | client_id, redirect_uri, code_challenge, state, scopes, resource | 10 min |
| `code` | random `jti`, client_id, redirect_uri, code_challenge, Canvas credential | 60 s, single use |
| `access` | client_id, Canvas credential | 1 h |
| `refresh` | client_id, Canvas credential | 90 days, new one issued on every refresh |

Canvas credential = `{ url, token, tz }`.

The only in-memory state is a set of used code `jti`s, pruned after expiry, so a
code works once. A restart clears it, which is harmless because codes live 60 s.

Rotating `CANVAS_MCP_KEY` invalidates every token (logs everyone out). There is no
per-user revocation; a student revokes by deleting their Canvas token.

## OAuth provider (`src/oauth.ts`)

Implements the SDK's `OAuthServerProvider`:

- `clientsStore.registerClient` — rejects any `redirect_uri` outside the allowlist,
  returns the client info with `client_id` = sealed client.
- `clientsStore.getClient` — opens the sealed `client_id`.
- `authorize` — renders the login page with a sealed `authreq`.
- `challengeForAuthorizationCode` / `exchangeAuthorizationCode` — open the code, check
  client + redirect URI match and single use, return `{ access_token, refresh_token,
  token_type: "bearer", expires_in: 3600 }`.
- `exchangeRefreshToken` — open the refresh token, check client, issue a new pair.
- `verifyAccessToken` — open the access token, return `AuthInfo` with the credential in `extra`.

Redirect URI allowlist (default; overridable with `CANVAS_MCP_REDIRECT_HOSTS`, comma-separated):
`https://claude.ai`, `https://claude.com`, and `http://localhost:*` / `http://127.0.0.1:*`
(loopback, for Claude Code / Desktop). This stops a third-party app from using the
login page to phish students' tokens.

## Network guard (`src/netguard.ts`)

All outbound Canvas traffic in multi-user mode goes through a guarded `fetch`:

- Only `https:` URLs; redirects are followed manually (max 5) and every hop is re-checked.
- Hostnames that are IP literals must be public; DNS results are checked at connect time
  through an `undici` `Agent` with a custom `lookup`, so DNS rebinding cannot reach
  private space.
- Rejected ranges: loopback, private (RFC 1918), link-local, CGNAT (100.64/10),
  unique-local / link-local IPv6, unspecified, multicast, reserved, IPv4-mapped forms of these.
- Test-only escape hatch: `CANVAS_MCP_ALLOW_PRIVATE_NETWORK=1` (allows http + private addresses
  so the mock Canvas on 127.0.0.1 works). Never set in production; the server logs a warning.

`CanvasClient` gets an optional `fetch` in its config; single-user and stdio modes keep
the global `fetch`.

## HTTP app (`src/public.ts`)

Express app, started by `--http` when `PUBLIC_URL` is set:

| Route | Purpose |
|---|---|
| `GET /health` | `ok` |
| `GET /` | landing page |
| `mcpAuthRouter` | `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`, `/authorize`, `/token`, `/register`, `/revoke` (no-op) |
| `POST /login` | login form submit |
| `POST /mcp` | `requireBearerAuth` → per-request `CanvasClient` from `req.auth.extra` → stateless `StreamableHTTPServerTransport` (same as today) |
| `GET/DELETE /mcp` | 405 |

- Rate limits: SDK defaults on OAuth endpoints; `POST /login` 10 per 15 min per IP;
  `/mcp` 120 per minute per student, keyed by a hash of the Canvas credential
  (claude.ai traffic all comes from Anthropic's IPs, so per-IP would be wrong).
- In-flight `/mcp` work: at most 16 requests in all and 4 per Canvas credential (same hash);
  beyond that 503 (server) or 429 (credential) with `Retry-After: 5`. A slot is held until the
  response has closed and the request's tool calls and Canvas fetches have settled; closing the
  response aborts those fetches. JSON-RPC batches are refused (400), so one slot is one tool call.
  Remaining risk: anyone can log in against a fake Canvas that answers slowly, and 4 such logins
  (slowed only by the `/login` limit) keep every slot busy, so other students get 503 meanwhile.
- `trust proxy` from `TRUST_PROXY` (default `loopback, linklocal, uniquelocal`).
- Security headers on HTML pages: CSP (`default-src 'none'`, inline style, script by hash,
  `form-action 'self'` plus, on the login page, the origin of the client's redirect URI,
  `frame-ancestors 'none'`), `Referrer-Policy: same-origin` (not `no-referrer`: under it the login
  form's own POST carries `Origin: null`, which any page can send). `POST /login` is refused
  (403) unless it comes from the login page itself: `Sec-Fetch-Site: same-origin`, or, from a
  browser that sends no `Sec-Fetch-Site`, `Origin` equal to the server's own origin.
- All reflected values HTML-escaped. Body size limits (login 10 kB, MCP 1 MB).
- Logging: errors only, never tokens, request bodies, or Authorization headers.

## Configuration

| Env | Mode | Meaning |
|---|---|---|
| `PUBLIC_URL` | multi-user | public base URL, e.g. `https://canvas.example.com` |
| `CANVAS_MCP_KEY` | multi-user | ≥ 32 chars; encrypts all tokens |
| `CANVAS_MCP_REDIRECT_HOSTS` | multi-user | optional redirect allowlist override |
| `TRUST_PROXY` | multi-user | optional Express `trust proxy` value |
| `MCP_SECRET`, `CANVAS_BASE_URL`, `CANVAS_API_TOKEN` | single-user | unchanged |

`--http` with `PUBLIC_URL` → multi-user; with `MCP_SECRET` → single-user; both → error.
Canvas URL/token are no longer required at startup in multi-user mode.

## Code layout

- `src/index.ts` — CLI parsing and mode dispatch only.
- `src/server.ts` — `buildServer(canvas, opts)` (instructions, tools, prompts), shared by all modes.
- `src/http.ts` — today's single-user secret-path server, moved unchanged.
- `src/public.ts`, `src/oauth.ts`, `src/seal.ts`, `src/netguard.ts`, `src/pages.ts` (HTML) — new.
- `package.json` — add `express` and `undici` as direct dependencies, `@types/express` as dev.

## Testing (`test/mock-test.mjs`, extended)

Against the existing mock Canvas, with the private-network escape hatch:

- Full flow: metadata discovery → register → `/authorize` form → `POST /login` → code →
  `/token` with PKCE → `tools/list` and a real tool call with the bearer token → refresh.
- Rejections: wrong Canvas token (form error), reused code, wrong PKCE verifier, tampered
  access token, expired token, refresh token used as access token, non-allowlisted
  redirect URI at registration, missing bearer → 401 with `WWW-Authenticate`.
- Netguard unit checks (without the escape hatch): `http:` refused, `127.0.0.1`,
  `10.x`, `169.254.169.254`, `[::1]`, `::ffff:127.0.0.1` refused, a hostname resolving to
  loopback (`localhost`) refused.
- Existing stdio and single-user HTTP tests keep passing.

## Docs

README: new "Option D: host it for everyone (multi-user)" section with Coolify steps,
env vars, and the Cloudflare Tunnel note (public HTTPS needed; tunnel requires the
domain's DNS on Cloudflare). Replace the location-specific example time zone with
`America/New_York` in README, `.env.example`, and the tests. No personal names, schools, or domains anywhere — placeholders only.

## Out of scope

Per-user revocation, a database, admin dashboard, Canvas-native OAuth (needs a
developer key from each school's admin), invite codes.
