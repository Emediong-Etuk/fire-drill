/**
 * A fake Otari for tests: the subset of routes Fire Drill calls, with the
 * same paths, credentials and response shapes as Otari 1726b58.
 *
 * Legs behave by provider prefix:
 *   good:*     answers every contract correctly
 *   badjson:*  answers in prose, so JSON and schema checks fail
 *   broken:*   answers 500 every time
 *   slow:*     waits `slowMs` before answering like good:*
 *   badcode:*  like good:*, but its text answers carry Python that raises
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Call {
  method: string;
  path: string;
  auth: "none" | "admin" | "user" | "drill" | "unknown";
  body?: unknown;
}

interface Key {
  id: string;
  secret: string;
  userId: string;
  allowedModels: string[] | null;
  expiresAt: string | null;
  active: boolean;
  workspaceId: string;
}

export interface FakeGatewayOptions {
  adminKey: string;
  userKey: string;
  policies?: Array<{ name: string; spec: unknown; source?: string; workspace_id?: string | null }>;
  costUsd?: number;
  slowMs?: number;
  webSearchEnabled?: boolean;
  /** Echo the bearer token in 500 error bodies, to test that it is scrubbed. */
  echoKeyInErrors?: boolean;
  /** Refuse GET /api/v1/tools for drill keys: a failure after the key is minted. */
  rejectDrillTools?: boolean;
}

const WORKSPACE = "11111111-2222-3333-4444-555555555555";

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; minimum?: number };

/** A minimal instance of a JSON Schema: enough for the fake's "good" answers. */
export function instanceOf(schema: Schema | undefined): unknown {
  if (!schema) return {};
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = instanceOf(v);
      return out;
    }
    case "array":
      return [instanceOf(schema.items)];
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    case "string":
      return "Leeds";
    default:
      return {};
  }
}

export class FakeGateway {
  readonly calls: Call[] = [];
  /** Every drill-key secret ever minted, for leak checks. */
  readonly mintedSecrets: string[] = [];
  readonly keys = new Map<string, Key>();
  readonly users = new Map<string, { budgetId: string | null; deleted: boolean }>();
  readonly budgets = new Map<string, { max: number; spent: number }>();
  webSearch: { configured: boolean; enabled: boolean };
  private server?: Server;
  private readonly opts: FakeGatewayOptions;
  url = "";

  constructor(opts: FakeGatewayOptions) {
    this.opts = opts;
    this.webSearch = { configured: false, enabled: opts.webSearchEnabled ?? false };
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ detail: String(err) }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  /** Keys minted and not yet deleted or deactivated. */
  liveKeys(): Key[] {
    return [...this.keys.values()].filter((k) => k.active);
  }

  private authOf(req: IncomingMessage): { label: Call["auth"]; key?: Key; token?: string } {
    const raw = req.headers.authorization ?? "";
    const token = raw.replace(/^Bearer\s+/i, "");
    if (!token) return { label: "none" };
    if (token === this.opts.adminKey) return { label: "admin", token };
    if (token === this.opts.userKey) return { label: "user", token };
    const key = [...this.keys.values()].find((k) => k.secret === token);
    return key ? { label: "drill", key, token } : { label: "unknown", token };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    const auth = this.authOf(req);
    this.calls.push({ method, path, auth: auth.label, body });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const needAdmin = () => {
      if (auth.label !== "admin") {
        send(401, { detail: "Invalid master key" });
        return false;
      }
      return true;
    };
    const apiKey = (): Key | "user" | undefined => {
      if (auth.label === "user") return "user";
      if (auth.label === "drill" && auth.key && auth.key.active) {
        if (auth.key.expiresAt && new Date(auth.key.expiresAt) < new Date()) return undefined;
        return auth.key;
      }
      return undefined;
    };

    if (method === "GET" && path === "/api/v1/health") return send(200, { status: "healthy" });

    if (method === "GET" && path === "/api/v1/tools") {
      if (auth.label === "none" || auth.label === "unknown" || (auth.label === "drill" && !apiKey())) return send(401, { detail: "Invalid API key" });
      if (auth.label === "drill" && this.opts.rejectDrillTools) return send(500, { detail: `tools exploded for ${auth.token}` });
      const web = this.webSearch.enabled;
      return send(200, {
        object: "list",
        data: [
          { id: "otari_code_execution", available: true, reason: null },
          { id: "otari_web_search", available: web, reason: web ? null : "workspace_disabled" },
          { id: "otari_web_fetch", available: web, reason: web ? null : "workspace_disabled" },
        ],
      });
    }

    if (method === "GET" && path === "/api/v1/routing/policies") {
      if (!needAdmin()) return;
      return send(200, (this.opts.policies ?? []).map((p) => ({ source: "stored", workspace_id: WORKSPACE, user_id: null, ...p })));
    }

    if (method === "POST" && path === "/api/v1/budgets") {
      if (!needAdmin()) return;
      const id = randomUUID();
      this.budgets.set(id, { max: body.max_budget, spent: 0 });
      return send(200, { budget_id: id, max_budget: body.max_budget, name: body.name });
    }
    let m = path.match(/^\/api\/v1\/budgets\/([^/]+)$/);
    if (m && method === "DELETE") {
      if (!needAdmin()) return;
      if (!this.budgets.delete(m[1]!)) return send(404, { detail: "Budget not found" });
      return send(204, undefined);
    }

    if (method === "POST" && path === "/api/v1/users") {
      if (!needAdmin()) return;
      this.users.set(body.user_id, { budgetId: body.budget_id ?? null, deleted: false });
      return send(200, { user_id: body.user_id, budget_id: body.budget_id ?? null });
    }
    m = path.match(/^\/api\/v1\/users\/([^/]+)$/);
    if (m && method === "DELETE") {
      if (!needAdmin()) return;
      const u = this.users.get(decodeURIComponent(m[1]!));
      if (!u || u.deleted) return send(404, { detail: "User not found" });
      u.deleted = true;
      for (const k of this.keys.values()) if (k.userId === decodeURIComponent(m[1]!)) k.active = false;
      return send(204, undefined);
    }

    if (method === "POST" && path === "/api/v1/keys") {
      if (!needAdmin()) return;
      const key: Key = {
        id: randomUUID(),
        secret: `tk-${randomBytes(16).toString("hex")}`,
        userId: body.user_id ?? "default",
        allowedModels: body.allowed_models ?? null,
        expiresAt: body.expires_at ?? null,
        active: true,
        workspaceId: body.workspace_id ?? WORKSPACE,
      };
      this.keys.set(key.id, key);
      this.mintedSecrets.push(key.secret);
      return send(200, { id: key.id, key: key.secret, key_name: body.key_name, user_id: key.userId, expires_at: key.expiresAt, allowed_models: key.allowedModels, is_active: true });
    }
    m = path.match(/^\/api\/v1\/keys\/([^/]+)$/);
    if (m) {
      if (!needAdmin()) return;
      const key = this.keys.get(m[1]!);
      if (!key) return send(404, { detail: "API key not found" });
      if (method === "GET") return send(200, { id: key.id, workspace_id: key.workspaceId, is_active: key.active, allowed_models: key.allowedModels });
      if (method === "DELETE") {
        this.keys.delete(key.id);
        return send(204, undefined);
      }
    }

    if (method === "POST" && path === "/api/v1/chat/completions") {
      const k = apiKey();
      if (!k) return send(401, { detail: "Invalid API key" });
      const model = String(body.model);
      if (k !== "user" && k.allowedModels && !k.allowedModels.includes(model)) {
        return send(403, { detail: `Model ${model} is not allowed`, code: "model_not_allowed" }, { "Otari-Error-Code": "model_not_allowed" });
      }
      const budget = k !== "user" ? this.budgets.get(this.users.get(k.userId)?.budgetId ?? "") : undefined;
      const cost = this.opts.costUsd ?? 0.0004;
      if (budget && budget.spent + cost > budget.max + 1e-12) {
        return send(403, { detail: "User has exceeded budget limit", code: "budget_exceeded" }, { "Otari-Error-Code": "budget_exceeded" });
      }
      const [provider, ...rest] = model.split(":");
      const served = rest.join(":");
      const requestId = randomUUID();
      const headers = { "Otari-Provider": provider!, "Otari-Model": served, "Otari-Request-ID": requestId, "Otari-Attempt-Count": "1", "Otari-Fallback": "false" };
      if (provider === "broken") {
        const detail = this.opts.echoKeyInErrors ? `upstream rejected token ${auth.token}` : "Provider error";
        return send(500, { detail, code: "provider_error" }, { ...headers, "Otari-Error-Code": "provider_error" });
      }
      if (provider === "slow") await new Promise((r) => setTimeout(r, this.opts.slowMs ?? 5000));
      if (budget) budget.spent += cost;
      const message = this.answer(provider!, body);
      return send(
        200,
        {
          id: `chatcmpl-${requestId.slice(0, 8)}`,
          object: "chat.completion",
          model,
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost_usd: cost.toFixed(6), pricing_source: "defaults" },
        },
        headers,
      );
    }

    if (method === "GET" && path === "/api/v1/key/budget") {
      const k = apiKey();
      if (!k || k === "user") return send(401, { detail: "Invalid API key" });
      const budget = this.budgets.get(this.users.get(k.userId)?.budgetId ?? "");
      return send(200, {
        budgets_enforced: true,
        remaining_usd: budget ? budget.max - budget.spent : null,
        limits: budget ? [{ scope: "user", limit_usd: budget.max, used_usd: budget.spent, remaining_usd: budget.max - budget.spent }] : [],
      });
    }

    if (method === "POST" && path === "/api/v1/code/execute") {
      const k = apiKey();
      if (!k) return send(401, { detail: "Invalid API key" });
      const code = String(body.code ?? "");
      const failing = code.includes("raise") || code.includes("undefined_name");
      return send(200, {
        object: "code_execution.result",
        stdout: failing ? "" : "ok\n",
        stderr: failing ? "Traceback (most recent call last):\nNameError: name 'undefined_name' is not defined\n" : "",
        return_code: failing ? 1 : 0,
        files: [],
      });
    }

    m = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/web-search$/);
    if (m) {
      if (!needAdmin()) return;
      const view = () => ({ workspace_id: m![1], configured: this.webSearch.configured, default_enabled: true, enabled: this.webSearch.enabled, max_results: null, allowed_domains: null, blocked_domains: null });
      if (method === "GET") return send(200, view());
      if (method === "PUT") {
        this.webSearch = { configured: true, enabled: Boolean(body.enabled) };
        return send(200, view());
      }
      if (method === "DELETE") {
        this.webSearch = { configured: false, enabled: this.opts.webSearchEnabled ?? true };
        return send(204, undefined);
      }
    }

    send(404, { detail: `No route ${method} ${path}` });
  }

  private answer(provider: string, body: { response_format?: { type?: string; json_schema?: { schema?: Schema } }; tools?: Array<{ function: { name: string; parameters?: Schema } }> }) {
    if (provider === "badjson") {
      return { role: "assistant", content: "Sure! Here is what you asked for: three blue mugs and a teapot, going to Leeds." };
    }
    if (body.tools?.length) {
      const tool = body.tools[0]!.function;
      return {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify(instanceOf(tool.parameters)) } }],
      };
    }
    if (body.response_format?.type === "json_schema") {
      return { role: "assistant", content: JSON.stringify(instanceOf(body.response_format.json_schema?.schema)) };
    }
    if (body.response_format?.type === "json_object") return { role: "assistant", content: '{"ok": true}' };
    if (provider === "badcode") return { role: "assistant", content: "Try this:\n\n```python\nprint(undefined_name)\n```" };
    return { role: "assistant", content: "Open the sign-in page and choose 'Forgot password'.\n\n```python\nprint('ok')\n```" };
  }
}
