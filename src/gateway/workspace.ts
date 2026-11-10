import { DrillError } from "../errors.js";
import { errorDetail, type GatewayClient } from "./client.js";

/** The fields of WorkspaceWebSearchConfigPublic that PUT accepts back. */
interface WebSearchConfig {
  configured?: boolean;
  enabled?: boolean;
  max_results?: number | null;
  purpose_hint?: string | null;
  allowed_domains?: string[] | null;
  blocked_domains?: string[] | null;
  provider_options?: Record<string, unknown> | null;
  search_executor?: string | null;
  fetch_executor?: string | null;
}

const WRITABLE = ["max_results", "purpose_hint", "allowed_domains", "blocked_domains", "provider_options", "search_executor", "fetch_executor"] as const;

/**
 * `--lock-down`: switch off otari_web_search, otari_web_fetch and direct search
 * for the drill key's workspace, and put the previous policy back afterwards.
 *
 *   GET    /api/v1/workspaces/{id}/web-search   remember what was there
 *   PUT    ... {enabled: false, ...unchanged}   for the drill
 *   PUT    ... <previous values>                after, if a policy was stored
 *   DELETE ...                                  after, if none was (back to the default)
 */
export class WebLockDown {
  private readonly client: GatewayClient;
  private readonly workspaceId: string;
  private previous?: WebSearchConfig;
  private changed = false;
  private restoring?: Promise<string | undefined>;

  constructor(client: GatewayClient, workspaceId: string) {
    this.client = client;
    this.workspaceId = workspaceId;
  }

  private get path(): string {
    return `/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}/web-search`;
  }

  /** Returns true when web access was on and is now off. */
  async apply(): Promise<boolean> {
    const res = await this.client.request<WebSearchConfig>(this.path, { credential: "admin" });
    if (!res.ok || !res.body) {
      throw new DrillError(`Could not read the workspace web policy (${errorDetail(res)}).`, "Run without --lock-down, or check the admin key.");
    }
    this.previous = res.body;
    if (res.body.enabled === false) return false;
    const body: Record<string, unknown> = { enabled: false };
    for (const k of WRITABLE) if (res.body[k] !== undefined) body[k] = res.body[k];
    const put = await this.client.request(this.path, { method: "PUT", credential: "admin", body });
    if (!put.ok) throw new DrillError(`Could not switch web access off for the drill (${errorDetail(put)}).`, "Run without --lock-down.");
    this.changed = true;
    return true;
  }

  /** Put back what was there. Returns an error line, or undefined on success. Safe to call twice. */
  restore(): Promise<string | undefined> {
    this.restoring ??= this.doRestore();
    return this.restoring;
  }

  private async doRestore(): Promise<string | undefined> {
    if (!this.changed || !this.previous) return undefined;
    const prev = this.previous;
    try {
      if (prev.configured) {
        const body: Record<string, unknown> = { enabled: prev.enabled ?? true };
        for (const k of WRITABLE) if (prev[k] !== undefined) body[k] = prev[k];
        const res = await this.client.request(this.path, { method: "PUT", credential: "admin", body, timeoutMs: 10_000 });
        if (!res.ok) return `Could not restore the workspace web policy (${errorDetail(res)}). Turn it back on under Tools, Web search.`;
      } else {
        const res = await this.client.request(this.path, { method: "DELETE", credential: "admin", timeoutMs: 10_000 });
        if (!res.ok && res.status !== 404) return `Could not restore the workspace web policy (${errorDetail(res)}). Turn it back on under Tools, Web search.`;
      }
      return undefined;
    } catch (err) {
      return `Could not restore the workspace web policy (${err instanceof Error ? err.message : String(err)}). Turn it back on under Tools, Web search.`;
    }
  }
}
