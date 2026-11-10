import { randomBytes } from "node:crypto";
import { BudgetTracker } from "./budget.js";
import { GatewayClient } from "./gateway/client.js";
import { resolveLegs } from "./gateway/policy.js";
import { checkHealth, checkTools } from "./gateway/tools.js";
import { colors, type Output } from "./io.js";
import type { DrillOptions } from "./options.js";
import { replay } from "./replay.js";
import { evaluate, exitCodeFor, recommend, type Report, summarizeLegs } from "./report/model.js";
import { renderTable } from "./report/table.js";
import { loadSamples } from "./samples.js";

export function newRunId(): string {
  return `fd-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
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

  // 1. Preflight.
  await checkHealth(client);
  const tools = await checkTools(client, opts.key ? "user" : "admin");
  if (tools.webSearch || tools.webFetch) {
    warnings.push("Web search or fetch is enabled for this workspace. Replays never attach web tools, but your app's real requests may.");
  }

  // 2. Resolve legs.
  const resolved = await resolveLegs(client, {
    alias: opts.alias,
    legsFlag: opts.legs,
    configPath: opts.config,
    workspaceId: opts.workspace,
  });
  const legs = resolved.legs;

  // 4. Load samples.
  const samples = await loadSamples(opts.samples);
  for (const s of samples) for (const n of s.notes) warnings.push(`Sample ${s.index}: ${n}.`);

  output.err(c.dim(`Drilling "${opts.alias}": ${legs.map((l) => `${l.index}. ${l.model}`).join("  ")}\n`));

  // 6. Replay.
  const budget = new BudgetTracker(opts.budget);
  const attempts = await replay({
    client,
    credential: "user",
    legs,
    samples,
    runs: opts.runs,
    budget,
    concurrency: opts.concurrency,
    timeoutMs: opts.timeoutMs,
    runId,
  });

  // 8. Report.
  const { legs: legReports, failures } = summarizeLegs(legs, evaluate(legs, attempts));
  const skipped = attempts.find((a) => a.status === "SKIPPED");
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
    gatewaySpentUsd: null,
    stopped: skipped?.skipReason,
    legs: legReports,
    failures,
    recommendation: recommend(legReports, opts.failUnder),
    warnings,
    drillKey: { mode: "existing", revoked: null, cleanup: [] },
    exitCode: exitCodeFor(legReports, opts.failUnder),
  };
  output.out(renderTable(report, output.color));
  return report.exitCode;
}
