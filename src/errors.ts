import { scrub } from "./redact.js";

/**
 * An error the user can act on: what went wrong and the exact fix.
 * Exit code 2 ("the drill could not run").
 */
export class DrillError extends Error {
  readonly fix: string;

  constructor(cause: string, fix: string) {
    super(scrub(cause));
    this.name = "DrillError";
    this.fix = scrub(fix);
  }
}

/** One readable sentence for any thrown value, with secrets removed. */
export function describeError(err: unknown): string {
  if (err instanceof DrillError) return `${err.message} Fix: ${err.fix}`;
  if (err instanceof Error) return scrub(err.message);
  return scrub(String(err));
}

/** Remove registered secrets from an error, including its stack, in place. */
export function scrubError(err: unknown): unknown {
  if (err instanceof Error) {
    err.message = scrub(err.message);
    if (err.stack) err.stack = scrub(err.stack);
  }
  return err;
}
