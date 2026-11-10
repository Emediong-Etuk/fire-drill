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

/** Visible width, ignoring ANSI colour codes. */
function visible(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padColored(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - visible(s)));
}

export function renderTable(report: Report, color: boolean): string {
  const c = colors(color);
  const lines: string[] = [];
  lines.push("");
  lines.push(c.bold(`Fire Drill: "${report.alias}"  ${report.samples} sample${report.samples === 1 ? "" : "s"} x ${report.legs.length} legs x ${report.runs} run${report.runs === 1 ? "" : "s"}`));
  lines.push("");
  const header = `${pad("#", 2)} ${pad("Role", 11)} ${pad("Model", 30)} ${pad("Pass", 9)} ${pad("Failures", 16)} ${pad("p50", 7, true)} ${pad("$/req", 9, true)} ${pad("$/1k", 8, true)}`;
  lines.push(c.dim(header));
  for (const l of report.legs) {
    const ok = l.passRate >= report.threshold;
    const passText = `${l.passed}/${l.total} ${Math.round(l.passRate)}%`;
    const pass = ok ? c.green(pad(passText, 9)) : c.red(pad(passText, 9));
    const fails = Object.entries(l.failuresByType)
      .map(([t, n]) => `${TYPE_SHORT[t] ?? t} ${n}`)
      .join(", ");
    lines.push(
      [
        pad(String(l.index), 2),
        " ",
        pad(l.role, 11),
        " ",
        pad(l.model, 30),
        " ",
        padColored(pass, 9),
        " ",
        pad(fails || "-", 16),
        " ",
        pad(fmtLatency(l.medianLatencyMs), 7, true),
        " ",
        pad(l.costPerRequestUsd === null ? "n/a" : `$${fmtMoney(l.costPerRequestUsd)}`, 9, true),
        " ",
        pad(l.projectedPer1kUsd === null ? "n/a" : `$${fmtMoney(l.projectedPer1kUsd)}`, 8, true),
      ].join(""),
    );
  }

  if (report.failures.length) {
    lines.push("");
    lines.push(c.bold("Failures"));
    const shown = report.failures.filter((f) => f.contract !== "skipped").slice(0, 20);
    for (const f of shown) {
      const run = report.runs > 1 ? ` run ${f.run}` : "";
      lines.push(`  leg ${f.leg}  sample ${f.sample}${run}  ${c.yellow(TYPE_SHORT[f.contract] ?? f.contract)}  ${f.message}`);
      if (f.excerpt) lines.push(c.dim(`      "${f.excerpt}"`));
    }
    const skipped = report.failures.filter((f) => f.contract === "skipped").length;
    const hidden = report.failures.length - shown.length - skipped;
    if (hidden > 0) lines.push(c.dim(`  … ${hidden} more (use --json for all)`));
    if (skipped > 0) lines.push(c.dim(`  ${skipped} request${skipped === 1 ? "" : "s"} not sent: ${report.stopped ?? "stopped early"}`));
  }

  if (report.warnings.length) {
    lines.push("");
    for (const w of report.warnings) lines.push(c.yellow(`! ${w}`));
  }

  lines.push("");
  const spend = `Spent $${fmtMoney(report.spentUsd)} of $${report.budgetUsd.toFixed(2)}` +
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
