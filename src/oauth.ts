// Stateless OAuth 2.1 authorization server for the multi-user mode. Every client, login request, code and token is a
// sealed (encrypted, authenticated) blob, so the server stores nothing but the ids of codes already used.
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CanvasCred } from "./login.js";
import { errorPage, loginPage, pageHeaders } from "./pages.js";
import type { Sealer } from "./seal.js";

/** Token lifetimes in seconds. Clients never expire. */
export const AUTHREQ_TTL = 600, CODE_TTL = 60, ACCESS_TTL = 3600, REFRESH_TTL = 90 * 24 * 3600;

/** Who may receive a login: claude.ai, and loopback on any port for Claude Code / Desktop. */
export const DEFAULT_REDIRECT_ORIGINS = ["https://claude.ai", "https://claude.com", "http://localhost", "http://127.0.0.1"];

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/** Exact origin match, except that an http://localhost or http://127.0.0.1 entry allows any port on that host. */
export function redirectAllowed(uri: string, origins: string[]): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  const loopback = u.protocol === "http:" && LOOPBACK.has(u.hostname);
  return origins.some((o) => o === u.origin || (loopback && o === `http://${u.hostname}`));
}

/** CANVAS_MCP_REDIRECT_HOSTS: comma-separated origins (scheme://host[:port]); unset or blank means the default. */
export function parseRedirectOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return DEFAULT_REDIRECT_ORIGINS;
  const origins = raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  for (const o of origins) {
    let ok = false;
    try {
      const u = new URL(o);
      pageHeaders(o); // throws unless the login page's CSP form-action can name it
      ok = (u.protocol === "https:" || u.protocol === "http:") && u.origin === o;
    } catch {}
    if (!ok) throw new Error(`CANVAS_MCP_REDIRECT_HOSTS: "${o}" is not an origin like https://claude.ai`);
  }
  if (!origins.length) throw new Error("CANVAS_MCP_REDIRECT_HOSTS lists no origins");
  return origins;
}

type ClientInfo = Omit<OAuthClientInformationFull, "client_id">;
interface AuthReq { client_id: string; redirect_uri: string; code_challenge: string; state?: string; scopes?: string[] }
interface Code { jti: string; client_id: string; redirect_uri: string; code_challenge: string; cred: CanvasCred; exp: number }
interface Grant { client_id: string; cred: CanvasCred; exp: number }

export class StatelessProvider implements OAuthServerProvider {
  readonly #sealer: Sealer;
  readonly #origins: string[];
  readonly #usedCodes = new Map<string, number>(); // jti → exp

  constructor(o: { sealer: Sealer; redirectOrigins: string[] }) {
    this.#sealer = o.sealer;
    this.#origins = o.redirectOrigins;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => {
        const info = this.#sealer.open<ClientInfo>("client", clientId);
        return info ? { ...info, client_id: clientId } : undefined;
      },
      registerClient: (client) => {
        const bad = client.redirect_uris.find((u) => !redirectAllowed(u, this.#origins));
        if (bad !== undefined) throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad}`);
        const { client_id: _, ...info } = client as OAuthClientInformationFull;
        return { ...info, client_id: this.#sealer.seal("client", info) };
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // The SDK matched the redirect URI to the client's; check it against today's allowlist too (it also relaxes loopback ports).
    if (!redirectAllowed(params.redirectUri, this.#origins)) {
      res.status(400).set(pageHeaders()).type("html").send(errorPage("This app isn't allowed to use this login page."));
      return;
    }
    const req: AuthReq = { client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge, state: params.state, scopes: params.scopes };
    const authreq = this.#sealer.seal("authreq", { ...req }, AUTHREQ_TTL);
    const to = new URL(params.redirectUri);
    res.status(200).set(pageHeaders(to.origin)).type("html").send(loginPage({ authreq, redirectHost: to.host }));
  }

  /** Where the login form's POST goes back to, or null when the sealed authorization request is invalid or expired. */
  openAuthReq(authreq: string): { redirectUri: string } | null {
    const req = this.#sealer.open<AuthReq>("authreq", authreq);
    return req ? { redirectUri: req.redirect_uri } : null;
  }

  /** The client's redirect URI with a fresh single-use code (and state), or null when authreq is invalid or expired. */
  completeLogin(authreq: string, cred: CanvasCred): string | null {
    const req = this.#sealer.open<AuthReq>("authreq", authreq);
    if (!req) return null;
    const code = this.#sealer.seal("code", {
      jti: randomUUID(), client_id: req.client_id, redirect_uri: req.redirect_uri, code_challenge: req.code_challenge, cred,
    }, CODE_TTL);
    const to = new URL(req.redirect_uri);
    to.searchParams.set("code", code);
    if (req.state !== undefined) to.searchParams.set("state", req.state);
    return to.href;
  }

  #openCode(client: OAuthClientInformationFull, code: string): Code {
    const c = this.#sealer.open<Code>("code", code);
    if (!c || c.client_id !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.#openCode(client, code).code_challenge;
  }

  // The SDK checks PKCE (challengeForAuthorizationCode) before this, so a wrong verifier never uses up the code.
  // The resource parameter is ignored: tokens are sealed with this server's key and work nowhere else.
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.#openCode(client, code);
    if (redirectUri !== undefined && redirectUri !== c.redirect_uri) throw new InvalidGrantError("redirect_uri does not match");
    if (this.#usedCodes.has(c.jti)) throw new InvalidGrantError("Authorization code already used");
    const now = Date.now() / 1000;
    for (const [jti, exp] of this.#usedCodes) if (exp <= now) this.#usedCodes.delete(jti);
    this.#usedCodes.set(c.jti, c.exp);
    return this.#tokens(client.client_id, c.cred);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const g = this.#sealer.open<Grant>("refresh", refreshToken);
    if (!g || g.client_id !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
    return this.#tokens(client.client_id, g.cred);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const g = this.#sealer.open<Grant>("access", token);
    if (!g) throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: g.client_id, scopes: [], expiresAt: g.exp, extra: { cred: g.cred } };
  }

  /** Nothing to revoke server-side; a student cuts access off by deleting the Canvas token. */
  async revokeToken(): Promise<void> {}

  #tokens(client_id: string, cred: CanvasCred): OAuthTokens {
    return {
      access_token: this.#sealer.seal("access", { client_id, cred }, ACCESS_TTL),
      refresh_token: this.#sealer.seal("refresh", { client_id, cred }, REFRESH_TTL),
      token_type: "bearer",
      expires_in: ACCESS_TTL,
    };
  }
}
