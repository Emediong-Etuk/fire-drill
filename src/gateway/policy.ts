import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { DrillError } from "../errors.js";
import { errorDetail, type GatewayClient } from "./client.js";

export interface Leg {
  /** 1-based position in the drill. */
  index: number;
  /** primary, failover n, tier-down n, conditional n, weighted n, priority n. */
  role: string;
  /** Concrete selector sent as `model`, e.g. `openai:gpt-5-mini`. */
  model: string;
}

export interface ResolvedLegs {
  legs: Leg[];
  source: "api" | "flag" | "config";
  /** Workspace a stored policy lives in, so the drill key can be minted there. */
  workspaceId?: string;
}

/** The parts of an Otari `PolicySpec` (src/gateway/models/routing.py:343) Fire Drill reads. */
interface SelectEntry {
  when?: Record<string, unknown> | null;
  target?: string | null;
  default?: string | null;
  router?: string | null;
  candidates?: string[] | null;
}
interface PolicySpec {
  select?: SelectEntry[];
  on_failure?: string[];
}

interface PolicyResponse {
  name: string;
  spec: PolicySpec;
  source: string;
  workspace_id?: string | null;
  user_id?: string | null;
}

const BUDGET_CONDITIONS = new Set(["budget_used_pct", "budget_remaining_usd"]);

/**
 * Turn a policy spec into ordered legs with roles.
 *
 * Order: the default (primary), router pool members, conditional targets in
 * the order written, then on_failure. A selector keeps its first role.
 */
export function legsFromSpec(spec: PolicySpec): Leg[] {
  const out: Array<{ role: string; model: string }> = [];
  const seen = new Set<string>();
  const add = (role: string, model: string | null | undefined) => {
    if (!model || seen.has(model)) return;
    seen.add(model);
    out.push({ role, model });
  };

  const select = spec.select ?? [];
  const def = select.find((e) => e.default)?.default;
  add("primary", def);

  let routed = 0;
  for (const entry of select) {
    if (!entry.router) continue;
    const kind = entry.router.trim().toLowerCase() === "priority" ? "priority" : "weighted";
    for (const c of entry.candidates ?? []) {
      if (c === def) continue;
      routed += 1;
      add(`${kind} ${routed}`, c);
    }
  }

  let tier = 0;
  let cond = 0;
  for (const entry of select) {
    if (!entry.target) continue;
    const keys = Object.keys(entry.when ?? {});
    const isBudget = keys.length > 0 && keys.every((k) => BUDGET_CONDITIONS.has(k));
    if (isBudget) add(`tier-down ${++tier}`, entry.target);
    else add(`conditional ${++cond}`, entry.target);
  }

  (spec.on_failure ?? []).forEach((sel, i) => add(`failover ${i + 1}`, sel));
  return out.map((l, i) => ({ index: i + 1, ...l }));
}

/** `--legs a,b,c`: the first is the primary, the rest fail over in order. */
export function legsFromFlag(raw: string): Leg[] {
  const models = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unique = [...new Set(models)];
  if (unique.length === 0) {
    throw new DrillError("--legs is empty.", 'Pass concrete selectors, for example --legs "openai:gpt-5-mini,anthropic:claude-haiku-4-5".');
  }
  return unique.map((model, i) => ({ index: i + 1, role: i === 0 ? "primary" : `failover ${i}`, model }));
}

/** Read `routing.policies.<alias>` from an Otari config.yml. */
export async function legsFromConfigFile(path: string, alias: string): Promise<Leg[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new DrillError(`Could not read the Otari config file "${path}".`, "Check the path passed to --config.");
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new DrillError(
      `"${path}" is not valid YAML (${err instanceof Error ? err.message.split("\n")[0] : "parse error"}).`,
      "Fix the file, or pass the legs directly with --legs.",
    );
  }
  const policies = (doc as { routing?: { policies?: Record<string, PolicySpec> } } | null)?.routing?.policies ?? {};
  const spec = policies[alias];
  if (!spec) {
    const names = Object.keys(policies);
    throw new DrillError(
      `"${path}" has no routing policy named "${alias}"${names.length ? ` (it has: ${names.join(", ")})` : ""}.`,
      names.length ? `Run firedrill with one of those names.` : "Add the policy under routing.policies, or pass --legs.",
    );
  }
  return legsFromSpec(spec);
}

/** Pick the policy the drill should use when several share a name. */
export function choosePolicy(all: PolicyResponse[], alias: string, workspaceId?: string): PolicyResponse | undefined {
  const named = all.filter((p) => p.name === alias && !p.user_id);
  // A config.yml policy wins over a stored workspace-wide one of the same name
  // (src/gateway/api/routes/routing.py:387-393).
  const fromConfig = named.find((p) => p.source === "config");
  if (fromConfig) return fromConfig;
  if (workspaceId) return named.find((p) => p.workspace_id === workspaceId);
  if (named.length > 1) {
    throw new DrillError(
      `Routing policy "${alias}" exists in ${named.length} workspaces.`,
      `Pass --workspace with one of: ${named.map((p) => p.workspace_id).join(", ")}.`,
    );
  }
  return named[0];
}

/** Read the policy over the API (master key only: routes/routing.py:55). */
export async function legsFromApi(client: GatewayClient, alias: string, workspaceId?: string): Promise<ResolvedLegs> {
  const res = await client.request<PolicyResponse[]>("/api/v1/routing/policies", {
    credential: "admin",
    query: { workspace_id: workspaceId },
  });
  if (res.status === 401 || res.status === 403) {
    throw new DrillError(
      `The admin key was refused when reading routing policies (${errorDetail(res)}).`,
      "Set OTARI_ADMIN_KEY to the gateway's master key (OTARI_MASTER_KEY in Otari's .env).",
    );
  }
  if (!res.ok || !Array.isArray(res.body)) {
    throw new DrillError(`Reading routing policies failed (${errorDetail(res)}).`, "Pass the legs directly with --legs a,b,c.");
  }
  const policy = choosePolicy(res.body, alias, workspaceId);
  if (!policy) {
    const names = [...new Set(res.body.map((p) => p.name))];
    throw new DrillError(
      `The gateway has no routing policy named "${alias}"${names.length ? ` (it has: ${names.join(", ")})` : ""}.`,
      names.length ? "Run firedrill with one of those names, or pass --legs." : "Create the policy in Otari, or pass --legs a,b,c.",
    );
  }
  return {
    legs: legsFromSpec(policy.spec),
    source: "api",
    workspaceId: policy.workspace_id ?? workspaceId ?? undefined,
  };
}

export interface ResolveOptions {
  alias: string;
  legsFlag?: string;
  configPath?: string;
  workspaceId?: string;
}

/** Resolve legs: --legs, then the API (admin key), then --config. */
export async function resolveLegs(client: GatewayClient, opts: ResolveOptions): Promise<ResolvedLegs> {
  let resolved: ResolvedLegs;
  if (opts.legsFlag) {
    resolved = { legs: legsFromFlag(opts.legsFlag), source: "flag", workspaceId: opts.workspaceId };
  } else if (client.hasKey("admin")) {
    resolved = await legsFromApi(client, opts.alias, opts.workspaceId);
  } else if (opts.configPath) {
    resolved = { legs: await legsFromConfigFile(opts.configPath, opts.alias), source: "config", workspaceId: opts.workspaceId };
  } else {
    throw new DrillError(
      `Can't read routing policy "${opts.alias}": that needs the admin key, and none was given.`,
      "export OTARI_ADMIN_KEY=<master key>, or pass --legs a,b,c, or --config path/to/otari/config.yml.",
    );
  }
  if (resolved.legs.length === 0) {
    throw new DrillError(`Routing policy "${opts.alias}" resolved to no models.`, "Check the policy's select and on_failure entries.");
  }
  if (resolved.legs.length === 1) {
    resolved.legs[0]!.role = "primary";
  }
  for (const leg of resolved.legs) {
    if (!leg.model.includes(":") && !leg.model.includes("/")) {
      throw new DrillError(
        `Leg "${leg.model}" is not a concrete model selector.`,
        'Use provider:model, for example "openai:gpt-5-mini".',
      );
    }
  }
  return resolved;
}
