import { CREDENTIAL_LABEL, type TraceEvent } from "./gateway/client.js";
import { fmtMoney } from "./report/model.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PATH_WIDTH = 32;

/**
 * Shorten a path to fit its column: drop the common /api/v1 prefix (the
 * header says so) and keep the first 8 characters of each UUID.
 */
export function shortPath(path: string): string {
  const p = path.replace(/^\/api\/v1(?=\/)/, "").replace(UUID, (u) => `${u.slice(0, 8)}…`);
  return p.length > PATH_WIDTH ? `${p.slice(0, PATH_WIDTH - 1)}…` : p;
}

export const TRACE_HEADER = `${"step".padEnd(5)}${"method".padEnd(7)}${"path (under /api/v1)".padEnd(PATH_WIDTH + 1)}${"status".padEnd(7)}${"latency".padStart(7)}  ${"cost".padEnd(10)}signed by`;

/**
 * One line per gateway call, under 100 characters:
 *   [07] POST   /api/v1/chat/completions             200    1.2s  $0.000026  drill key  leg 1
 * Never includes a key value: only which kind of credential signed the call.
 */
export function formatTrace(e: TraceEvent): string {
  const step = `[${String(e.step).padStart(2, "0")}]`.padEnd(5);
  const latency = e.latencyMs < 1000 ? `${e.latencyMs}ms` : `${(e.latencyMs / 1000).toFixed(1)}s`;
  const cost = e.costUsd === null ? "-" : `$${fmtMoney(e.costUsd)}`;
  const line =
    `${step}${e.method.padEnd(7)}${shortPath(e.path).padEnd(PATH_WIDTH + 1)}${String(e.status).padEnd(7)}` +
    `${latency.padStart(7)}  ${cost.padEnd(10)}${CREDENTIAL_LABEL[e.credential]}${e.note ? `  ${e.note}` : ""}`;
  return line.length > 99 ? `${line.slice(0, 98)}…` : line;
}
