import pc from "picocolors";
import { scrub } from "./redact.js";

/** Where output goes. Every write is scrubbed of registered secrets. */
export interface Output {
  out(text: string): void;
  err(text: string): void;
  color: boolean;
}

export function processOutput(color: boolean): Output {
  return {
    out: (t) => process.stdout.write(scrub(t)),
    err: (t) => process.stderr.write(scrub(t)),
    color,
  };
}

export function colors(enabled: boolean) {
  const id = (s: string) => s;
  return enabled
    ? { red: pc.red, green: pc.green, yellow: pc.yellow, dim: pc.dim, bold: pc.bold, cyan: pc.cyan }
    : { red: id, green: id, yellow: id, dim: id, bold: id, cyan: id };
}
