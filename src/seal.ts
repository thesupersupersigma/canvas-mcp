// Stateless tokens: AES-256-GCM sealed JSON, token = base64url(iv[12] ‖ ciphertext ‖ tag[16]).
// The purpose is bound as GCM additional data, so one kind of token can't stand in for another.
import { createCipheriv, createDecipheriv, createSecretKey, hkdfSync, KeyObject, randomBytes } from "node:crypto";

export type Purpose = "client" | "authreq" | "code" | "access" | "refresh";

const IV = 12, TAG = 16;
const now = () => Math.floor(Date.now() / 1000);

export class Sealer {
  readonly #key: KeyObject;

  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length < 32) throw new Error("CANVAS_MCP_KEY must be at least 32 characters");
    this.#key = createSecretKey(Buffer.from(hkdfSync("sha256", secret, "", "canvas-mcp seal v1", 32)));
  }

  /** Adds `exp` (unix seconds) when ttlSeconds is given; it overrides any `exp` in the payload. */
  seal(purpose: Purpose, payload: Record<string, unknown>, ttlSeconds?: number): string {
    const body = ttlSeconds === undefined ? payload : { ...payload, exp: now() + ttlSeconds };
    const iv = randomBytes(IV);
    const c = createCipheriv("aes-256-gcm", this.#key, iv, { authTagLength: TAG });
    c.setAAD(Buffer.from(purpose));
    const ct = Buffer.concat([c.update(JSON.stringify(body), "utf8"), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url");
  }

  /** The payload, or null for anything malformed, forged, of another purpose, or expired. Never throws. */
  open<T = any>(purpose: Purpose, token: string): T | null {
    try {
      if (typeof token !== "string") return null;
      const raw = Buffer.from(token, "base64url");
      // Node's decoder skips junk characters; accept only the canonical encoding.
      if (raw.length <= IV + TAG || raw.toString("base64url") !== token) return null;
      const d = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, IV), { authTagLength: TAG });
      d.setAAD(Buffer.from(purpose));
      d.setAuthTag(raw.subarray(-TAG));
      const p = JSON.parse(Buffer.concat([d.update(raw.subarray(IV, -TAG)), d.final()]).toString("utf8"));
      if (!p || typeof p !== "object" || Array.isArray(p)) return null;
      if ("exp" in p && !(typeof p.exp === "number" && p.exp > now())) return null;
      return p as T;
    } catch {
      return null;
    }
  }
}
