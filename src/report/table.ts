import { colors } from "../io.js";
import { fmtMoney, type Report } from "./model.js";

const TYPE_SHORT: Record<string, string> = {
  json_schema: "schema",
  json_object: "json",
  tool_call: "tool",
  text: "text",
  http: "http",
  served_model: "served",
  code_exec: "code",
  skipped: "skipped",
};

function fmtLatency(ms: number | null): string {
  if (ms === null) return "-";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function pad(s: string, n: number, right = false): string {
  const t = s.length > n ? `${s.slice(0, n - 1)}…` : s;
  return right ? t.padStart(n) : t.padEnd(n);
}

/** Shorten in the middle, keeping the distinctive end of a model name. */
function middle(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  // "openrouter:mistralai/mistral-small" -> "openrouter:…/mistral-small"
  const m = /^([^:]+:)[^/]+(\/.+)$/.exec(s);
  if (m && m[1]!.length + 1 + m[2]!.length <= n) return `${m[1]}…${m[2]}`.padEnd(n);
  const head = Math.ceil((n - 1) * 0.4);
  return `${s.slice(0, head)}…${s.slice(s.length - (n - 1 - head))}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Visible width, ignoring ANSI colour codes. */
function visible(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padColored(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - visible(s)));
}

/** "1-3, 5" for [1, 2, 3, 5]. */
export function ranges(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) i++;
    out.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`);
  }
  return out.join(", ");
}

const W = { idx: 2, role: 11, model: 44, pass: 10, fails: 16, p50: 6, req: 9, k: 8 };

export function renderTable(report: Report, color: boolean): string {
  const c = colors(color);
  const lines: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  lines.push("");
  lines.push(c.bold(`Fire Drill: "${report.alias}"  ${plural(report.samples, "sample")} x ${plural(report.legs.length, "leg")} x ${plural(report.runs, "run")}`));
  lines.push("");
  const header = [
    pad("#", W.idx),
    pad("Role", W.role),
    pad("Model", W.model),
    pad("Pass", W.pass),
    pad("Failures", W.fails),
    pad("p50", W.p50, true),
    pad("$/req", W.req, true),
    pad("$/1k", W.k, true),
  ].join(" ");
  lines.push(c.dim(header));
  for (const l of report.legs) {
    const ok = l.passRate >= report.threshold;
    const passText = `${l.passed}/${l.total} ${Math.round(l.passRate)}%`;
    const pass = ok ? c.green(pad(passText, W.pass)) : c.red(pad(passText, W.pass));
    const fails = Object.entries(l.failuresByType)
      .map(([t, n]) => `${TYPE_SHORT[t] ?? t} ${n}`)
      .join(", ");
    lines.push(
      [
        pad(String(l.index), W.idx),
        pad(l.role, W.role),
        middle(l.model, W.model),
        padColored(pass, W.pass),
        pad(fails || "-", W.fails),
        pad(fmtLatency(l.medianLatencyMs), W.p50, true),
        pad(l.costPerRequestUsd === null ? "n/a" : `$${fmtMoney(l.costPerRequestUsd)}`, W.req, true),
        pad(l.projectedPer1kUsd === null ? "n/a" : `$${fmtMoney(l.projectedPer1kUsd)}`, W.k, true),
      ].join(" "),
    );
  }

  const real = report.failures.filter((f) => f.contract !== "skipped");
  if (real.length) {
    lines.push("");
    lines.push(c.bold("Failures"));
    // One line per leg, check and message, listing the samples it hit.
    const groups = new Map<string, { leg: number; contract: string; message: string; samples: number[]; hits: number; excerpt?: string }>();
    for (const f of real) {
      const key = `${f.leg}|${f.contract}|${f.message}`;
      const g = groups.get(key) ?? { leg: f.leg, contract: f.contract, message: f.message, samples: [], hits: 0, excerpt: f.excerpt };
      g.samples.push(f.sample);
      g.hits++;
      groups.set(key, g);
    }
    const all = [...groups.values()];
    const shown = all.slice(0, 12);
    for (const g of shown) {
      const uniq = new Set(g.samples).size;
      const where = `${uniq === 1 ? "sample" : "samples"} ${ranges(g.samples)}${g.hits > uniq ? ` (${g.hits}x)` : ""}`;
      const prefix = `  leg ${g.leg}  ${where}  `;
      const tag = TYPE_SHORT[g.contract] ?? g.contract;
      lines.push(`${prefix}${c.yellow(tag)}  ${clip(g.message, Math.max(30, 98 - prefix.length - tag.length - 2))}`);
      if (g.excerpt) lines.push(c.dim(`      "${clip(g.excerpt, 88)}"`));
    }
    if (all.length > shown.length) lines.push(c.dim(`  … ${all.length - shown.length} more (use --json for all)`));
  }
  const skipped = report.failures.filter((f) => f.contract === "skipped").length;
  if (skipped > 0) lines.push(c.dim(`  ${plural(skipped, "request")} not sent: ${report.stopped ?? "stopped early"}`));

  if (report.warnings.length) {
    lines.push("");
    for (const w of report.warnings) lines.push(c.yellow(`! ${w}`));
  }

  lines.push("");
  const spend =
    `Spent $${fmtMoney(report.spentUsd)} of $${fmtMoney(report.budgetUsd)}` +
    (report.gatewaySpentUsd !== null ? ` (gateway recorded $${fmtMoney(report.gatewaySpentUsd)})` : "");
  const key =
    report.drillKey.mode === "minted"
      ? report.drillKey.revoked
        ? "Drill key revoked."
        : c.red("Drill key NOT revoked: see the cleanup lines above.")
      : "Ran on your existing key (no drill key).";
  lines.push(c.dim(`${spend}. ${key} ${(report.durationMs / 1000).toFixed(1)}s.`));
  lines.push(report.exitCode === 0 ? c.green(report.recommendation) : c.red(report.recommendation));
  lines.push("");
  return lines.join("\n");
}
