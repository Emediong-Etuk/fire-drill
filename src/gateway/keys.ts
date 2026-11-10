import { DrillError } from "../errors.js";
import { registerSecret } from "../redact.js";
import { errorDetail, type GatewayClient, type GatewayResponse } from "./client.js";

export interface MintOptions {
  runId: string;
  models: string[];
  budgetUsd: number;
  ttlMinutes: number;
  workspaceId?: string;
}

export interface CleanupResult {
  revoked: boolean;
  lines: string[];
}

const ADMIN_FIX = "Set OTARI_ADMIN_KEY to the gateway's master key (OTARI_MASTER_KEY in Otari's .env), or pass --use-existing-key.";

/**
 * A short-lived key for one drill, with its own user and budget so it shares
 * nothing with real traffic. All calls use the master key:
 *
 *   POST /api/v1/budgets   {name, max_budget}
 *   POST /api/v1/users     {user_id, budget_id, allowed_models}
 *   POST /api/v1/keys      {key_name, user_id, allowed_models, expires_at, workspace_id}
 *
 * Revoked in reverse: DELETE the key, DELETE the user (which also deactivates
 * any key of that user, src/gateway/api/routes/users.py:449), DELETE the budget.
 */
export class DrillKey {
  private readonly client: GatewayClient;
  budgetId?: string;
  userId?: string;
  keyId?: string;
  expiresAt?: string;
  private cleanup?: Promise<CleanupResult>;

  constructor(client: GatewayClient) {
    this.client = client;
  }

  get minted(): boolean {
    return Boolean(this.keyId);
  }

  async mint(opts: MintOptions): Promise<void> {
    const name = `firedrill-${opts.runId}`;
    const refused = (res: GatewayResponse, what: string) => {
      if (res.status === 401 || res.status === 403) return new DrillError(`The admin key was refused while ${what} (${errorDetail(res)}).`, ADMIN_FIX);
      return new DrillError(`Otari refused ${what} (${errorDetail(res)}).`, "Check the legs are models this gateway serves, or pass --use-existing-key.");
    };
    try {
      const budget = await this.client.request<{ budget_id?: string }>("/api/v1/budgets", {
        method: "POST",
        credential: "admin",
        body: { name, max_budget: opts.budgetUsd },
      });
      if (!budget.ok || !budget.body?.budget_id) throw refused(budget, "creating the drill budget");
      this.budgetId = budget.body.budget_id;

      const user = await this.client.request("/api/v1/users", {
        method: "POST",
        credential: "admin",
        body: { user_id: name, alias: `Fire Drill ${opts.runId}`, budget_id: this.budgetId, allowed_models: opts.models, metadata: { firedrill_run: opts.runId } },
      });
      if (!user.ok) throw refused(user, "creating the drill user");
      this.userId = name;

      this.expiresAt = new Date(Date.now() + opts.ttlMinutes * 60_000).toISOString();
      const key = await this.client.request<{ id?: string; key?: string }>("/api/v1/keys", {
        method: "POST",
        credential: "admin",
        body: {
          key_name: name,
          user_id: name,
          allowed_models: opts.models,
          expires_at: this.expiresAt,
          workspace_id: opts.workspaceId,
          metadata: { firedrill_run: opts.runId },
        },
      });
      if (!key.ok || !key.body?.id || !key.body.key) throw refused(key, "minting the drill key");
      // Registered before it is stored anywhere, so no later output can carry it.
      registerSecret(key.body.key);
      this.keyId = key.body.id;
      this.client.setKey("drill", key.body.key);
    } catch (err) {
      await this.revoke();
      throw err;
    }
  }

  /** The drill key's workspace (GET /api/v1/keys/{id}, master key). */
  async workspaceId(): Promise<string | undefined> {
    if (!this.keyId) return undefined;
    const res = await this.client.request<{ workspace_id?: string }>(`/api/v1/keys/${this.keyId}`, { credential: "admin" });
    return res.ok ? res.body?.workspace_id : undefined;
  }

  /** Delete everything mint created. Safe to call more than once and concurrently. */
  revoke(): Promise<CleanupResult> {
    this.cleanup ??= this.doRevoke();
    return this.cleanup;
  }

  private async doRevoke(): Promise<CleanupResult> {
    const lines: string[] = [];
    let keyGone = !this.keyId;
    const del = async (path: string, what: string): Promise<boolean> => {
      for (let tryNo = 0; tryNo < 3; tryNo++) {
        try {
          const res = await this.client.request(path, { method: "DELETE", credential: "admin", timeoutMs: 10_000 });
          if (res.ok || res.status === 404) return true;
          if (tryNo === 2) lines.push(`Could not delete ${what} (${errorDetail(res)}).`);
        } catch (err) {
          if (tryNo === 2) lines.push(`Could not delete ${what} (${err instanceof Error ? err.message : String(err)}).`);
        }
        await new Promise((r) => setTimeout(r, 300 * (tryNo + 1)));
      }
      return false;
    };
    if (this.keyId) keyGone = await del(`/api/v1/keys/${encodeURIComponent(this.keyId)}`, `drill key ${this.keyId}`);
    if (this.userId) {
      const userGone = await del(`/api/v1/users/${encodeURIComponent(this.userId)}`, `drill user ${this.userId}`);
      // Deleting the user deactivates its keys, so the key is unusable either way.
      if (userGone) keyGone = true;
    }
    if (this.budgetId) await del(`/api/v1/budgets/${encodeURIComponent(this.budgetId)}`, `drill budget ${this.budgetId}`);
    this.client.setKey("drill", undefined);
    if (!keyGone && this.keyId) {
      lines.push(`Revoke it by hand: curl -X DELETE ${this.client.baseUrl}/api/v1/keys/${this.keyId} -H "Authorization: Bearer $OTARI_ADMIN_KEY". It also expires at ${this.expiresAt}.`);
    }
    return { revoked: keyGone, lines };
  }
}

/** Expiry long enough for the drill, short enough to be harmless if cleanup fails. */
export function drillKeyTtlMinutes(requests: number, concurrency: number, timeoutMs: number): number {
  const worstCaseMinutes = Math.ceil((requests / Math.max(1, concurrency)) * (timeoutMs / 1000) * 2 / 60);
  return Math.min(60, Math.max(10, worstCaseMinutes + 5));
}
