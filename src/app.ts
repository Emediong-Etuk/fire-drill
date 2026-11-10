import { Command } from "commander";
import { runDrill } from "./drill.js";
import { describeError, DrillError, scrubError } from "./errors.js";
import { processOutput } from "./io.js";
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
    .option("--legs <a,b,c>", "use these legs instead of reading the policy")
    .option("--config <file>", "read the policy from an Otari config.yml when it can't be read over the API")
    .option("--workspace <id>", "workspace whose policy and providers the drill uses")
    .option("--use-existing-key", "run on --key instead of minting a drill key (client-side budget only)")
    .showHelpAfterError()
    .action(async (alias: string, flags: RawFlags) => {
      onExit(await runCli(alias, flags));
    });
  return cmd;
}

export async function runCli(alias: string, flags: RawFlags, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // Register keys as secrets before anything can print them.
  registerSecret(flags.key ?? env.OTARI_API_KEY);
  registerSecret(flags.adminKey ?? env.OTARI_ADMIN_KEY);
  const output = processOutput(flags.color !== false && !env.NO_COLOR && Boolean(process.stdout.isTTY));
  try {
    const opts = buildOptions(alias, flags, env);
    return await runDrill(opts, output);
  } catch (err) {
    scrubError(err);
    output.err(`firedrill: ${describeError(err)}\n`);
    if (!(err instanceof DrillError) && env.FIREDRILL_DEBUG && err instanceof Error && err.stack) output.err(`${err.stack}\n`);
    return EXIT.couldNotRun;
  }
}

export async function main(argv: string[]): Promise<void> {
  let code: number = EXIT.couldNotRun;
  process.on("uncaughtException", (err) => {
    scrubError(err);
    process.stderr.write(`firedrill: ${describeError(err)}\n`);
    process.exit(EXIT.couldNotRun);
  });
  await program((c) => (code = c)).parseAsync(argv);
  process.exitCode = code;
}
