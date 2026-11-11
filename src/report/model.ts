import { baselineOf, checkResponse, type Failure, type FailureType } from "../contract/check.js";
import { type Contract, deriveContract } from "../contract/derive.js";
import type { Leg } from "../gateway/policy.js";
import { excerpt } from "../redact.js";
import type { Attempt } from "../replay.js";
import { lastErrorLine } from "../sandbox.js";

export interface LegReport {
  index: number;
  role: string;
  model: string;
  total: number;
  passed: number;
  /** 0-100 */
  passRate: number;
  failuresByType: Partial<Record<FailureType, number>>;
  /** Otari error codes behind this leg's HTTP failures, with counts. */
  errorCodes: Record<string, number>;
  medianLatencyMs: number | null;
  costPerRequestUsd: number | null;
  projectedPer1kUsd: number | null;
  totalCostUsd: number;
}

export interface FailureEntry {
  leg: number;
  model: string;
  sample: number;
  run: number;
  contract: FailureType;
  message: string;
  excerpt?: string;
  code?: string;
}

export interface DrillKeyReport {
  mode: "minted" | "existing";
  id?: string;
  revoked: boolean | null;
  cleanup: string[];
}

export interface Report {
  version: 1;
  alias: string;
  gateway: string;
  runId: string;
  startedAt: string;
  durationMs: number;
  legsSource: string;
  samples: number;
  runs: number;
  threshold: number;
  budgetUsd: number;
  spentUsd: number;
  gatewaySpentUsd: number | null;
  stopped?: string;
  legs: LegReport[];
  failures: FailureEntry[];
  recommendation: string;
  warnings: string[];
  drillKey: DrillKeyReport;
  exitCode: number;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Check every attempt and attach its failures. */
export function evaluate(legs: Leg[], attempts: Attempt[]): Array<{ attempt: Attempt; failures: Failure[] }> {
  const primary = legs[0];
  const contracts = new Map<number, Contract>();
  const contractFor = (a: Attempt) => {
    let c = contracts.get(a.sample.index);
    if (!c) contracts.set(a.sample.index, (c = deriveContract(a.sample.body)));
    return c;
  };
  const primaryBy = new Map<string, Attempt>();
  for (const a of attempts) if (a.leg.index === primary?.index) primaryBy.set(`${a.sample.index}:${a.run}`, a);

  return attempts.map((a) => {
    if (a.status === "SKIPPED") {
      return { attempt: a, failures: [{ type: "skipped" as const, message: `not sent: ${a.skipReason ?? "skipped"}` }] };
    }
    const p = primaryBy.get(`${a.sample.index}:${a.run}`) ?? primaryBy.get(`${a.sample.index}:1`);
    const baseline = baselineOf(p && p.status !== "SKIPPED" ? { status: p.status, leg: p.leg.model, body: p.body } : undefined);
    const failures = checkResponse(
      { status: a.status, error: a.error, errorCode: a.errorCode, leg: a.leg.model, servedModel: a.servedModel, servedProvider: a.servedProvider, body: a.body },
      contractFor(a),
      baseline,
      a.leg.index === primary?.index,
    );
    const run = a.codeRun;
    if (run && !run.ok) {
      failures.push(
        run.error
          ? { type: "code_exec", message: run.error }
          : { type: "code_exec", message: `Python block exits ${run.returnCode}: ${lastErrorLine(run.stderr) || "no stderr"}`, excerpt: excerpt(run.stderr) },
      );
    }
    return { attempt: a, failures };
  });
}

const TYPE_LABEL: Record<FailureType, string> = {
  json_schema: "schema checks",
  json_object: "JSON checks",
  tool_call: "tool-call checks",
  text: "text checks",
  http: "requests (HTTP errors)",
  served_model: "served-model checks",
  code_exec: "sandbox runs",
  skipped: "requests (not sent)",
};

export function summarizeLegs(legs: Leg[], evaluated: ReturnType<typeof evaluate>): { legs: LegReport[]; failures: FailureEntry[] } {
  const failures: FailureEntry[] = [];
  const reports = legs.map((leg) => {
    const rows = evaluated.filter((e) => e.attempt.leg.index === leg.index);
    const byType: Partial<Record<FailureType, number>> = {};
    const codes: Record<string, number> = {};
    let passed = 0;
    for (const { attempt, failures: fs } of rows) {
      if (fs.length === 0) passed++;
      for (const type of new Set(fs.map((f) => f.type))) byType[type] = (byType[type] ?? 0) + 1;
      for (const f of fs) {
        failures.push({ leg: leg.index, model: leg.model, sample: attempt.sample.index, run: attempt.run, contract: f.type, message: f.message, excerpt: f.excerpt, code: f.code });
        if (f.code) codes[f.code] = (codes[f.code] ?? 0) + 1;
      }
    }
    const sent = rows.filter((r) => r.attempt.status !== "SKIPPED" && r.attempt.status !== "ERR");
    const costs = sent.map((r) => r.attempt.costUsd).filter((c): c is number => c !== null);
    const totalCost = costs.reduce((s, c) => s + c, 0);
    const perReq = costs.length ? totalCost / costs.length : null;
    return {
      index: leg.index,
      role: leg.role,
      model: leg.model,
      total: rows.length,
      passed,
      passRate: rows.length ? Math.round((passed / rows.length) * 1000) / 10 : 0,
      failuresByType: byType,
      errorCodes: codes,
      medianLatencyMs: median(sent.map((r) => r.attempt.latencyMs)),
      costPerRequestUsd: perReq,
      projectedPer1kUsd: perReq === null ? null : perReq * 1000,
      totalCostUsd: totalCost,
    };
  });
  failures.sort((a, b) => a.leg - b.leg || a.sample - b.sample || a.run - b.run);
  return { legs: reports, failures };
}

/** One line telling the user what to change. */
export function recommend(legs: LegReport[], threshold: number, failures: FailureEntry[] = []): string {
  const failing = legs.filter((l) => l.passRate < threshold);
  if (failing.length === 0) {
    const priced = legs.filter((l) => l.projectedPer1kUsd !== null);
    const cheapest = priced.sort((a, b) => a.projectedPer1kUsd! - b.projectedPer1kUsd!)[0];
    const base = legs.length === 1 ? "The leg passes every check." : `All ${legs.length} legs pass every check.`;
    return cheapest && legs.length > 1
      ? `${base} Cheapest is leg ${cheapest.index} (${cheapest.model}) at $${fmtMoney(cheapest.projectedPer1kUsd!)} per 1,000 requests.`
      : base;
  }
  // A request that was never sent says nothing about its leg: rank on real failures only.
  const realFailures = (l: LegReport) => Object.entries(l.failuresByType).filter(([t]) => t !== "skipped") as Array<[FailureType, number]>;
  const broken = failing.filter((l) => realFailures(l).length > 0);
  if (broken.length === 0) {
    return "The drill stopped before every request was sent. Raise --budget or lower --runs and run it again.";
  }
  // Every leg refused every request it sent: the gateway or its providers are down,
  // so blaming the last leg would send the user to fix the wrong thing.
  const allDown =
    legs.length > 1 &&
    legs.every((l) => {
      const http = l.failuresByType.http ?? 0;
      return l.passed === 0 && http > 0 && http + (l.failuresByType.skipped ?? 0) === l.total;
    });
  if (allDown) {
    const first = failures.find((f) => f.contract === "http")?.message;
    return (
      `Every leg failed every request with an HTTP error, so the gateway or its providers are at fault, not one leg${first ? ` (first error: ${first})` : ""}. ` +
      "Check Otari's provider settings and network access, then run the drill again."
    );
  }
  const incomplete = legs.some((l) => (l.failuresByType.skipped ?? 0) > 0) ? " Some requests were not sent, so raise --budget for a full drill." : "";
  const worst = [...broken].sort((a, b) => a.passRate - b.passRate || b.index - a.index)[0]!;
  const [type, count] = realFailures(worst).sort((a, b) => b[1] - a[1])[0]!;
  const topCode = Object.entries(worst.errorCodes).sort((a, b) => b[1] - a[1])[0];
  const label = type === "http" && topCode ? `requests (Otari: ${topCode[0]})` : TYPE_LABEL[type];
  const what = `Leg ${worst.index} fails ${count}/${worst.total} ${label}.`;
  if (worst.index === 1) return `${what} It is the primary: fix the model choice or the request before relying on this policy.${incomplete}`;
  const passingAfter = legs.filter((l) => l.index > worst.index && l.passRate >= threshold);
  if (passingAfter.length) return `${what} Move it below leg ${passingAfter[passingAfter.length - 1]!.index} or remove it.${incomplete}`;
  if (worst.index === legs[legs.length - 1]!.index) return `${what} Remove it or replace it with a model that passes.${incomplete}`;
  return `${what} Remove it, or move it below the legs that pass.${incomplete}`;
}

export function fmtMoney(usd: number): string {
  if (usd === 0) return "0";
  if (usd >= 0.1) return usd.toFixed(2);
  if (usd >= 0.001) return usd.toFixed(4);
  return usd.toFixed(6);
}

/** Exit code for a finished drill: 1 when any leg is below the threshold. */
export function exitCodeFor(legs: LegReport[], threshold: number): 0 | 1 {
  return legs.some((l) => l.passRate < threshold) ? 1 : 0;
}
