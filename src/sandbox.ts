import type { BudgetTracker } from "./budget.js";
import { contentText } from "./contract/check.js";
import { type Credential, errorDetail, type GatewayClient, TransportError } from "./gateway/client.js";
import type { Attempt } from "./replay.js";

export interface CodeRun {
  ok: boolean;
  returnCode: number | null;
  stderr: string;
  /** Why the sandbox did not run the code, when it did not. */
  error?: string;
}

/** Used when the gateway will not say what a sandbox run costs: pessimistic on purpose. */
export const FALLBACK_SANDBOX_PRICE_USD = 0.01;

/**
 * Price of one direct sandbox run: the `otari:code_execution` row, stored per
 * million so one cent per call is 10000 (docs/tools.md, "Pricing a gateway-run tool").
 */
export async function sandboxPrice(client: GatewayClient, credential: Credential): Promise<number> {
  try {
    const res = await client.request<{ input_price_per_million?: number | null }>("/api/v1/pricing/otari:code_execution", { credential });
    const per = res.ok ? res.body?.input_price_per_million : undefined;
    return typeof per === "number" && Number.isFinite(per) && per >= 0 ? per / 1_000_000 : FALLBACK_SANDBOX_PRICE_USD;
  } catch {
    return FALLBACK_SANDBOX_PRICE_USD;
  }
}

const PYTHON_BLOCK = /```(?:python|py|python3)[ \t]*\r?\n([\s\S]*?)```/i;

/** The first fenced Python block in a response, or undefined. */
export function pythonBlock(text: string): string | undefined {
  const code = PYTHON_BLOCK.exec(text)?.[1];
  return code && code.trim() ? code : undefined;
}

/**
 * `--run-code`: run the first Python block of each answer in Otari's sandbox
 * with POST /api/v1/code/execute (no model involved). The code goes to the
 * gateway's sandbox unchanged. It is never run on this machine.
 */
export async function runSandboxChecks(opts: {
  client: GatewayClient;
  credential: Credential;
  attempts: Attempt[];
  budget: BudgetTracker;
  concurrency: number;
  signal?: AbortSignal;
}): Promise<number> {
  const jobs = opts.attempts.filter((a) => a.status === 200 && pythonBlock(contentText(a.body)));
  if (jobs.length === 0) return 0;
  const price = await sandboxPrice(opts.client, opts.credential);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const a = jobs[next++]!;
      if (opts.signal?.aborted) return;
      const token = opts.budget.reserve(price);
      if (token === null) {
        a.codeRun = { ok: false, returnCode: null, stderr: "", error: "not run: client-side budget reached" };
        continue;
      }
      try {
        const res = await opts.client.request<{ return_code?: number; stderr?: string }>("/api/v1/code/execute", {
          method: "POST",
          credential: opts.credential,
          body: { code: pythonBlock(contentText(a.body)), timeout_seconds: 10 },
          timeoutMs: 30_000,
          signal: opts.signal,
          knownCostUsd: price,
          note: `leg ${a.leg.index} sample ${a.sample.index}`,
        });
        if (!res.ok) {
          opts.budget.settle(token, 0);
          a.codeRun = { ok: false, returnCode: null, stderr: "", error: `sandbox refused: ${errorDetail(res)}` };
        } else {
          // Every run that reached the sandbox is billed at the per-call price.
          opts.budget.settleTool(token, price);
          const rc = typeof res.body?.return_code === "number" ? res.body.return_code : null;
          const stderr = typeof res.body?.stderr === "string" ? res.body.stderr : "";
          a.codeRun = { ok: rc === 0, returnCode: rc, stderr };
        }
      } catch (err) {
        // It may have reached the sandbox and been billed: count it.
        opts.budget.settleTool(token, price);
        if (!(err instanceof TransportError)) throw err;
        a.codeRun = { ok: false, returnCode: null, stderr: "", error: `sandbox unreachable: ${err.message}` };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, worker));
  return jobs.length;
}

/** The last line of a traceback is the one that says what broke. */
export function lastErrorLine(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
