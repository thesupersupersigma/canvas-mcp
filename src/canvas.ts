// Minimal Canvas LMS REST client: auth, pagination, error handling.

export interface CanvasConfig {
  baseUrl: string; // e.g. https://yourschool.instructure.com
  token: string;
  maxPages?: number;
  fetch?: typeof fetch; // defaults to globalThis.fetch
}

export class CanvasError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | (string | number)[] | undefined>;

export class CanvasClient {
  private api: string;
  constructor(private cfg: CanvasConfig) {
    this.api = cfg.baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "") + "/api/v1";
  }

  private buildUrl(path: string, params: Params = {}): string {
    const url = new URL(path.startsWith("http") ? path : this.api + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(`${k}[]`, String(item));
      else url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async raw(url: string): Promise<Response> {
    const res = await (this.cfg.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: "application/json+canvas-string-ids, application/json" },
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 300); } catch {}
      const hint =
        res.status === 401 ? " (token invalid or expired — generate a new one in Canvas > Account > Settings)" :
        res.status === 403 ? " (you don't have permission to see this, or the teacher hid it)" :
        res.status === 404 ? " (not found — check the id; the item may be unpublished or locked)" : "";
      throw new CanvasError(res.status, `Canvas API ${res.status}${hint}: ${detail}`);
    }
    return res;
  }

  async get<T = any>(path: string, params: Params = {}): Promise<T> {
    const res = await this.raw(this.buildUrl(path, params));
    return (await res.json()) as T;
  }

  /** Follows Link: rel="next" headers until exhausted or maxPages hit. */
  async getAll<T = any>(path: string, params: Params = {}, maxPages = this.cfg.maxPages ?? 10): Promise<T[]> {
    let url: string | null = this.buildUrl(path, { per_page: 100, ...params });
    const out: T[] = [];
    for (let page = 0; url && page < maxPages; page++) {
      const res = await this.raw(url);
      const data = await res.json();
      if (Array.isArray(data)) out.push(...data);
      else return [data as T];
      url = parseNext(res.headers.get("link"));
    }
    return out;
  }

  /** Downloads a file (Canvas file URLs redirect to signed S3/CDN links). */
  async download(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    // Signed download URLs don't need the bearer token, but Canvas-hosted ones do.
    const res = await (this.cfg.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${this.cfg.token}` }, redirect: "follow" });
    if (!res.ok) throw new CanvasError(res.status, `File download failed: ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "" };
  }
}

function parseNext(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}
