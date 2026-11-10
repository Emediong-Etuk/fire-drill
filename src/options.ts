import { z } from "zod";
import { DrillError } from "./errors.js";

/** Validated settings for one drill. Built from flags, then environment, then defaults. */
export const DrillOptionsSchema = z.object({
  alias: z.string().min(1),
  gateway: z.string().url(),
  key: z.string().min(1).optional(),
  adminKey: z.string().min(1).optional(),
  samples: z.string().min(1),
  budget: z.number().positive().max(1000),
  runs: z.number().int().min(1).max(20),
  legs: z.string().optional(),
  config: z.string().optional(),
  workspace: z.string().uuid().optional(),
  runCode: z.boolean(),
  json: z.boolean(),
  trace: z.boolean(),
  failUnder: z.number().min(0).max(100),
  useExistingKey: z.boolean(),
  lockDown: z.boolean(),
  out: z.string().optional(),
  concurrency: z.number().int().min(1).max(16),
  timeoutMs: z.number().int().min(1000).max(600_000),
  color: z.boolean(),
});

export type DrillOptions = z.infer<typeof DrillOptionsSchema>;

export interface RawFlags {
  gateway?: string;
  key?: string;
  adminKey?: string;
  samples?: string;
  budget?: string;
  runs?: string;
  legs?: string;
  config?: string;
  workspace?: string;
  runCode?: boolean;
  json?: boolean;
  trace?: boolean;
  failUnder?: string;
  useExistingKey?: boolean;
  lockDown?: boolean;
  out?: string;
  concurrency?: string;
  timeout?: string;
  color?: boolean;
}

function num(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new DrillError(`${flag} must be a number, got "${raw}".`, `Pass a number, for example ${flag} ${fallback}.`);
  return n;
}

export function buildOptions(alias: string, flags: RawFlags, env: NodeJS.ProcessEnv): DrillOptions {
  const candidate = {
    alias,
    gateway: flags.gateway ?? env.OTARI_BASE_URL ?? "http://localhost:8000",
    key: flags.key ?? (env.OTARI_API_KEY || undefined),
    adminKey: flags.adminKey ?? (env.OTARI_ADMIN_KEY || undefined),
    samples: flags.samples ?? "samples.jsonl",
    budget: num("--budget", flags.budget, 0.5),
    runs: num("--runs", flags.runs, 1),
    legs: flags.legs,
    config: flags.config,
    workspace: flags.workspace,
    runCode: Boolean(flags.runCode),
    json: Boolean(flags.json),
    trace: Boolean(flags.trace),
    failUnder: num("--fail-under", flags.failUnder, 100),
    useExistingKey: Boolean(flags.useExistingKey),
    lockDown: Boolean(flags.lockDown),
    out: flags.out,
    concurrency: num("--concurrency", flags.concurrency, 3),
    timeoutMs: num("--timeout", flags.timeout, 60) * 1000,
    color: flags.color !== false && !env.NO_COLOR,
  };
  const parsed = DrillOptionsSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = String(issue.path[0] ?? "option");
    const flag = `--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    // Never echo the received value: it may be a key.
    throw new DrillError(`${flag} is invalid: ${issue.message}.`, `Run firedrill --help for the accepted values of ${flag}.`);
  }
  const opts = parsed.data;
  if (opts.useExistingKey && !opts.key) {
    throw new DrillError("--use-existing-key needs an API key.", "export OTARI_API_KEY=<your API key>, or pass --key.");
  }
  if (!opts.adminKey && !opts.useExistingKey) {
    throw new DrillError(
      "No admin key, so Fire Drill can't mint a budget-capped drill key for this run.",
      "export OTARI_ADMIN_KEY=<the gateway's master key>, or pass --use-existing-key to run on OTARI_API_KEY with a client-side budget only.",
    );
  }
  if (opts.lockDown && !opts.adminKey) {
    throw new DrillError("--lock-down changes the workspace web policy, which needs the admin key.", "export OTARI_ADMIN_KEY=<the gateway's master key>.");
  }
  return opts;
}
