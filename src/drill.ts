import { randomBytes } from "node:crypto";
import { BudgetTracker } from "./budget.js";
import { registerCleanup, watchSignals } from "./cleanup.js";
import { DrillError } from "./errors.js";
import { type Credential, GatewayClient } from "./gateway/client.js";
import { DrillKey, drillKeyTtlMinutes } from "./gateway/keys.js";
import { resolveLegs } from "./gateway/policy.js";
import { checkHealth, checkTools } from "./gateway/tools.js";
import { colors, type Output } from "./io.js";
import type { DrillOptions } from "./options.js";
import { type Attempt, replay } from "./replay.js";
import { type DrillKeyReport, evaluate, exitCodeFor, recommend, type Report, summarizeLegs } from "./report/model.js";
import { renderJson, writePrivateFile } from "./report/json.js";
import { renderTable } from "./report/table.js";
import { runSandboxChecks } from "./sandbox.js";
import { WebLockDown } from "./gateway/workspace.js";
import { loadSamples } from "./samples.js";
import { formatTrace, TRACE_HEADER } from "./trace.js";

export function newRunId(): string {
  return `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
}

/** Spend the gateway recorded on the drill key's own budget (GET /api/v1/key/budget). */
async function gatewaySpend(client: GatewayClient): Promise<number | null> {
  try {
    const res = await client.request<{ limits?: Array<{ scope?: string; used_usd?: number | null }> }>("/api/v1/key/budget", { credential: "drill" });
    const user = res.ok ? res.body?.limits?.find((l) => l.scope === "user") : undefined;
    return typeof user?.used_usd === "number" ? user.used_usd : null;
  } catch {
    return null;
  }
}

/** Fill in costs the response body did not carry, from GET /api/v1/usage/requests/{id}. */
async function settleMissingCosts(client: GatewayClient, credential: Credential, attempts: Attempt[]): Promise<void> {
  for (const a of attempts) {
    if (a.status !== 200 || a.costUsd !== null || !a.requestId) continue;
    try {
      const res = await client.request<{ cost_usd?: string | null }>(`/api/v1/usage/requests/${encodeURIComponent(a.requestId)}`, { credential });
      const n = Number(res.body?.cost_usd);
      if (res.ok && res.body?.cost_usd != null && Number.isFinite(n)) a.costUsd = n;
    } catch {
      // A missing cost stays "n/a" in the report; the budget already counted it at the estimate.
    }
  }
}

/** Run one drill and return the process exit code. */
export async function runDrill(opts: DrillOptions, output: Output): Promise<number> {
  const c = colors(output.color);
  const started = Date.now();
  const runId = newRunId();
  const client = new GatewayClient(opts.gateway);
  client.setKey("user", opts.key);
  client.setKey("admin", opts.adminKey);
  const warnings: string[] = [];
  if (opts.trace) {
    output.err(`${c.dim(TRACE_HEADER)}\n`);
    client.onTrace((e) => output.err(`${formatTrace(e)}\n`));
  }

  // 1. Preflight.
  await checkHealth(client);
  const preflightCred: Credential = opts.key ? "user" : "admin";
  let tools = await checkTools(client, preflightCred);
  if (opts.runCode && !tools.codeExecution) {
    throw new DrillError(
      "--run-code needs Otari's code sandbox, and this gateway reports it unavailable.",
      "Start it with docker compose --profile code-exec up -d in your Otari checkout, or drop --run-code.",
    );
  }

  // 2. Resolve legs.
  const resolved = await resolveLegs(client, { alias: opts.alias, legsFlag: opts.legs, configPath: opts.config, workspaceId: opts.workspace });
  const legs = resolved.legs;

  // 4. Load samples (before minting, so a bad file costs nothing).
  const samples = await loadSamples(opts.samples);
  for (const s of samples) for (const n of s.notes) warnings.push(`Sample ${s.index}: ${n}.`);

  // 3. Mint a drill key, unless told to run on the existing one.
  const drillKey = new DrillKey(client);
  const keyReport: DrillKeyReport = { mode: opts.useExistingKey ? "existing" : "minted", revoked: null, cleanup: [] };
  const signals = watchSignals(() => output.err(c.yellow("\nStill revoking the drill key, one moment.\n")));
  let lockDown: WebLockDown | undefined;
  const unregister = registerCleanup(async () => {
    await lockDown?.restore();
    await drillKey.revoke();
  });
  let credential: Credential = "user";
  let attempts: Attempt[] | undefined;
  let gatewaySpent: number | null = null;
  const budget = new BudgetTracker(opts.budget);
  try {
    if (!opts.useExistingKey) {
      const requests = samples.length * legs.length * opts.runs;
      await drillKey.mint({
        runId,
        models: legs.map((l) => l.model),
        budgetUsd: opts.budget,
        ttlMinutes: drillKeyTtlMinutes(requests, opts.concurrency, opts.timeoutMs),
        workspaceId: resolved.workspaceId,
      });
      keyReport.id = drillKey.keyId;
      credential = "drill";
      // With the drill key, /tools answers for the workspace the replays run in.
      tools = await checkTools(client, "drill");
    } else {
      warnings.push(`Ran on your existing key: the $${opts.budget.toFixed(2)} cap was enforced client-side only.`);
    }
    if (opts.lockDown) {
      const workspaceId = (await drillKey.workspaceId()) ?? opts.workspace ?? resolved.workspaceId;
      if (!workspaceId) throw new DrillError("--lock-down needs to know the workspace.", "Pass --workspace <id>.");
      lockDown = new WebLockDown(client, workspaceId);
      const switched = await lockDown.apply();
      if (switched) {
        tools = await checkTools(client, credential);
        warnings.push("Web search and fetch were switched off for the drill (--lock-down) and switched back on afterwards.");
      }
    }
    if ((tools.webSearch || tools.webFetch) && tools.answeredBy !== "admin") {
      warnings.push(
        opts.lockDown
          ? "Web search or fetch is still enabled after --lock-down. Replays never attach web tools."
          : "Web search or fetch is enabled in this workspace. Replays never attach web tools; --lock-down switches them off for the drill.",
      );
    }

    output.err(c.dim(`Drilling "${opts.alias}" on ${client.baseUrl}: ${legs.map((l) => `${l.index}. ${l.model}`).join("  ")}\n`));

    // 6. Replay.
    attempts = await replay({
      client,
      credential,
      legs,
      samples,
      runs: opts.runs,
      budget,
      concurrency: opts.concurrency,
      timeoutMs: opts.timeoutMs,
      signal: signals.signal,
      runId,
    });
    // 7. Optional sandbox check, in Otari's sandbox only.
    if (opts.runCode && !signals.received()) {
      const ran = await runSandboxChecks({ client, credential, attempts, budget, concurrency: opts.concurrency, signal: signals.signal });
      if (ran === 0) warnings.push("--run-code: no answer contained a fenced Python block, so nothing was run.");
    }
    if (!signals.received()) {
      await settleMissingCosts(client, credential, attempts);
      if (credential === "drill") gatewaySpent = await gatewaySpend(client);
    }
  } finally {
    const restoreError = await lockDown?.restore();
    if (restoreError) {
      warnings.push(restoreError);
      output.err(c.red(`${restoreError}\n`));
    }
    if (drillKey.minted || drillKey.budgetId || drillKey.userId) {
      const result = await drillKey.revoke();
      keyReport.revoked = result.revoked;
      keyReport.cleanup = result.lines;
      for (const line of result.lines) output.err(c.red(`${line}\n`));
    }
    unregister();
    signals.dispose();
  }

  if (signals.received()) {
    const revoked = keyReport.mode === "minted" ? (keyReport.revoked ? " The drill key was revoked." : " The drill key was NOT revoked (see above).") : "";
    throw new DrillError(`Interrupted by ${signals.received()}.${revoked}`, "Run the drill again when ready.");
  }

  // 8. Report.
  const { legs: legReports, failures } = summarizeLegs(legs, evaluate(legs, attempts ?? []));
  const skipped = (attempts ?? []).find((a) => a.status === "SKIPPED");
  const report: Report = {
    version: 1,
    alias: opts.alias,
    gateway: client.baseUrl,
    runId,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    legsSource: resolved.source,
    samples: samples.length,
    runs: opts.runs,
    threshold: opts.failUnder,
    budgetUsd: opts.budget,
    spentUsd: budget.spentUsd,
    gatewaySpentUsd: gatewaySpent,
    stopped: skipped?.skipReason,
    legs: legReports,
    failures,
    recommendation: recommend(legReports, opts.failUnder),
    warnings,
    drillKey: keyReport,
    // A key left behind is a safety failure, whatever the legs did.
    exitCode: keyReport.mode === "minted" && keyReport.revoked === false ? 2 : exitCodeFor(legReports, opts.failUnder),
  };
  if (opts.out) await writePrivateFile(opts.out, renderJson(report));
  if (opts.json) output.out(renderJson(report));
  else output.out(renderTable(report, output.color));
  return report.exitCode;
}
