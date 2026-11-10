import { Command } from "commander";
import { runCleanups } from "./cleanup.js";
import { runDrill } from "./drill.js";
import { describeError, DrillError, scrubError } from "./errors.js";
import { GatewayClient } from "./gateway/client.js";
import { checkHealth } from "./gateway/tools.js";
import { writeStarterSamples } from "./init.js";
import { startRecorder } from "./record.js";
import { type Output, processOutput } from "./io.js";
import { buildOptions, type RawFlags } from "./options.js";
import { registerSecret } from "./redact.js";

export const EXIT = { ok: 0, belowThreshold: 1, couldNotRun: 2 } as const;

function program(onExit: (code: number) => void): Command {
  const cmd = new Command("firedrill")
    .description("Rehearse your Otari fallback routes: replay requests down every leg of a routing policy.")
    .argument("<alias>", "routing policy name (the model name your app sends)")
    .option("--gateway <url>", "Otari base URL (default $OTARI_BASE_URL or http://localhost:8000)")
    .option("--key <key>", "API key (default $OTARI_API_KEY). Never printed.")
    .option("--admin-key <key>", "master key, used to read the policy and mint the drill key (default $OTARI_ADMIN_KEY)")
    .option("--samples <file>", "JSONL of chat-completion request bodies", "samples.jsonl")
    .option("--budget <usd>", "hard cap for the whole drill, in USD", "0.50")
    .option("--runs <n>", "replays per sample per leg", "1")
    .option("--legs <a,b,c>", "use these legs instead of reading the policy")
    .option("--config <file>", "read the policy from an Otari config.yml when it can't be read over the API")
    .option("--workspace <id>", "workspace whose policy and providers the drill uses")
    .option("--run-code", "run each answer's first Python block in Otari's sandbox (POST /api/v1/code/execute)")
    .option("--lock-down", "switch the workspace's web search and fetch off for the drill, then restore them")
    .option("--json", "print the report as JSON on stdout")
    .option("--out <file>", "also write the JSON report to this file (mode 0600)")
    .option("--record [port]", "instead of drilling, run a local pass-through that records requests to <alias> into --samples (default port 8787)")
    .option("--trace", "print each gateway call as it happens (never a key value)")
    .option("--fail-under <pct>", "exit 1 if any leg's pass rate is below this", "100")
    .option("--use-existing-key", "run on --key instead of minting a drill key (client-side budget only)")
    .option("--concurrency <n>", "requests in flight at once", "3")
    .option("--timeout <seconds>", "per-request timeout", "60")
    .option("--no-color", "plain output")
    // Options after "init" belong to init, not to the drill.
    .enablePositionalOptions()
    .showHelpAfterError()
    .action(async (alias: string, flags: RawFlags & { record?: boolean | string }) => {
      onExit(flags.record !== undefined ? await runRecord(alias, flags) : await runCli(alias, flags));
    });

  cmd
    .command("init")
    .description("write a starter samples.jsonl (one json_schema, one tool call, one plain text request)")
    .option("--samples <file>", "where to write it", "samples.jsonl")
    .option("--force", "overwrite an existing file")
    .action(async (flags: { samples: string; force?: boolean }) => {
      onExit(await runInit(flags.samples, Boolean(flags.force)));
    });
  return cmd;
}

export async function runInit(path: string, force: boolean, output: Output = processOutput(false)): Promise<number> {
  try {
    await writeStarterSamples(path, force);
    output.out(`Wrote 3 starter samples to ${path} (mode 0600). Next: firedrill <policy-name>\n`);
    return EXIT.ok;
  } catch (err) {
    output.err(`firedrill: ${describeError(err)}\n`);
    return EXIT.couldNotRun;
  }
}

/** `--record [port]`: run the recorder until SIGINT/SIGTERM. */
export async function runRecord(
  alias: string,
  flags: RawFlags & { record?: boolean | string },
  env: NodeJS.ProcessEnv = process.env,
  output: Output = processOutput(false),
  stop: Promise<unknown> = new Promise((r) => {
    process.once("SIGINT", r);
    process.once("SIGTERM", r);
  }),
): Promise<number> {
  try {
    const port = typeof flags.record === "string" ? Number(flags.record) : 8787;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DrillError(`--record port "${flags.record}" is not a port number.`, "Pass a port such as --record 8787.");
    const gateway = flags.gateway ?? env.OTARI_BASE_URL ?? "http://localhost:8000";
    const client = new GatewayClient(gateway);
    await checkHealth(client);
    const samplesPath = flags.samples ?? "samples.jsonl";
    const rec = await startRecorder({ gateway, alias, samplesPath, port, output }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") throw new DrillError(`Port ${port} is already in use.`, "Pass another port, for example --record 8788.");
      throw err;
    });
    output.err(
      `Recording chat completions for "${alias}" into ${samplesPath} (mode 0600), forwarding to ${client.baseUrl}.\n` +
        `Point your app's OpenAI base URL at ${rec.url}/api/v1 and use it as usual. Ctrl-C stops.\n`,
    );
    await stop;
    await rec.close();
    output.out(`Recorded ${rec.recorded()} request${rec.recorded() === 1 ? "" : "s"} to ${samplesPath}. Next: firedrill ${alias} --samples ${samplesPath}\n`);
    return EXIT.ok;
  } catch (err) {
    scrubError(err);
    output.err(`firedrill: ${describeError(err)}\n`);
    return EXIT.couldNotRun;
  }
}

export async function runCli(
  alias: string,
  flags: RawFlags,
  env: NodeJS.ProcessEnv = process.env,
  output: Output = processOutput(flags.color !== false && !env.NO_COLOR && Boolean(process.stdout.isTTY)),
): Promise<number> {
  // Register keys as secrets before anything can print them.
  registerSecret(flags.key ?? env.OTARI_API_KEY);
  registerSecret(flags.adminKey ?? env.OTARI_ADMIN_KEY);
  try {
    const opts = buildOptions(alias, flags, env);
    return await runDrill({ ...opts, color: output.color }, output);
  } catch (err) {
    scrubError(err);
    output.err(`firedrill: ${describeError(err)}\n`);
    if (!(err instanceof DrillError) && env.FIREDRILL_DEBUG && err instanceof Error && err.stack) output.err(`${err.stack}\n`);
    return EXIT.couldNotRun;
  }
}

export async function main(argv: string[]): Promise<void> {
  let code: number = EXIT.couldNotRun;
  const crash = (err: unknown) => {
    scrubError(err);
    process.stderr.write(`firedrill: ${describeError(err)}\n`);
    // Revoke the drill key before going down.
    void runCleanups().finally(() => process.exit(EXIT.couldNotRun));
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  await program((c) => (code = c)).parseAsync(argv);
  process.exitCode = code;
}
