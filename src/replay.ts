import type { BudgetTracker } from "./budget.js";
import { costFromBody, type Credential, errorCode, errorDetail, type GatewayClient, TransportError } from "./gateway/client.js";
import type { Leg } from "./gateway/policy.js";
import type { Sample } from "./samples.js";

export interface Attempt {
  leg: Leg;
  sample: Sample;
  run: number;
  status: number | "ERR" | "SKIPPED";
  latencyMs: number;
  costUsd: number | null;
  requestId?: string | null;
  servedProvider?: string | null;
  servedModel?: string | null;
  body?: unknown;
  error?: string;
  errorCode?: string;
  skipReason?: string;
  retried: boolean;
}

export interface ReplayOptions {
  client: GatewayClient;
  credential: Credential;
  legs: Leg[];
  samples: Sample[];
  runs: number;
  budget: BudgetTracker;
  concurrency: number;
  timeoutMs: number;
  signal?: AbortSignal;
  runId: string;
  /** Called after each attempt, for progress output. */
  onAttempt?: (a: Attempt) => void;
  /** Wait before a retry; injectable so tests do not sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

function retryDelay(headers: Headers | undefined): number {
  const ra = Number(headers?.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 10_000);
  return 1000 + Math.floor(Math.random() * 500);
}

/** Run jobs with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Send every sample down every leg. The primary leg runs first so other legs
 * can be compared with what it did. Stops early, marking the rest skipped, when
 * the client-side budget has no room, the gateway refuses on budget, or the
 * signal aborts.
 */
export async function replay(opts: ReplayOptions): Promise<Attempt[]> {
  const sleep = opts.sleep ?? defaultSleep;
  const attempts: Attempt[] = [];
  let stopReason: string | undefined;

  const jobsFor = (legs: Leg[]) =>
    legs.flatMap((leg) => opts.samples.flatMap((sample) => Array.from({ length: opts.runs }, (_, r) => ({ leg, sample, run: r + 1 }))));

  const skip = (job: { leg: Leg; sample: Sample; run: number }, reason: string): Attempt => ({
    ...job,
    status: "SKIPPED",
    latencyMs: 0,
    costUsd: null,
    skipReason: reason,
    retried: false,
  });

  const runOne = async (job: { leg: Leg; sample: Sample; run: number }) => {
    if (opts.signal?.aborted) stopReason ??= "interrupted";
    if (stopReason) {
      attempts.push(skip(job, stopReason));
      return;
    }
    const token = opts.budget.reserve();
    if (token === null) {
      stopReason = `client-side budget of $${opts.budget.capUsd.toFixed(2)} reached`;
      attempts.push(skip(job, stopReason));
      return;
    }
    const metadata = {
      ...((job.sample.body.metadata as Record<string, string> | undefined) ?? {}),
      firedrill_run: opts.runId,
      firedrill_leg: String(job.leg.index),
      firedrill_sample: String(job.sample.index),
    };
    const body = { ...job.sample.body, model: job.leg.model, stream: false, metadata };
    let retried = false;
    let attempt: Attempt | undefined;
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      try {
        const res = await opts.client.request("/api/v1/chat/completions", {
          method: "POST",
          credential: opts.credential,
          body,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
          note: `leg ${job.leg.index} sample ${job.sample.index}${opts.runs > 1 ? ` run ${job.run}` : ""}`,
        });
        attempt = {
          ...job,
          status: res.status,
          latencyMs: res.latencyMs,
          costUsd: res.ok ? costFromBody(res.body) : null,
          requestId: res.headers.get("otari-request-id"),
          servedProvider: res.headers.get("otari-provider"),
          servedModel: res.headers.get("otari-model"),
          body: res.ok ? res.body : undefined,
          error: res.ok ? undefined : errorDetail(res),
          errorCode: res.ok ? undefined : errorCode(res),
          retried,
        };
        if ((res.status === 429 || res.status >= 500) && tryNo === 0 && !opts.signal?.aborted) {
          retried = true;
          await sleep(retryDelay(res.headers), opts.signal);
          continue;
        }
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        const aborted = Boolean(opts.signal?.aborted);
        attempt = {
          ...job,
          status: "ERR",
          latencyMs: 0,
          costUsd: null,
          error: aborted ? "interrupted" : err.message,
          retried,
        };
        if (!err.timedOut && !aborted && tryNo === 0) {
          retried = true;
          await sleep(retryDelay(undefined), opts.signal);
          continue;
        }
      }
      break;
    }
    const a = attempt!;
    // A refused request is not billed (its hold is refunded); a served one
    // with no reported cost counts at the estimate.
    opts.budget.settle(token, a.status === 200 ? a.costUsd : 0);
    if (a.errorCode === "budget_exceeded") stopReason = "the gateway refused on the drill key's budget";
    attempts.push(a);
    opts.onAttempt?.(a);
  };

  const [primary, ...others] = opts.legs;
  if (primary) await pool(jobsFor([primary]), opts.concurrency, runOne);
  await pool(jobsFor(others), opts.concurrency, runOne);
  return attempts;
}
