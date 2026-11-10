import { open } from "node:fs/promises";
import { redactDeep } from "../redact.js";
import type { Report } from "./model.js";

/** The report as JSON. Every string has already been through redaction. */
export function renderJson(report: Report): string {
  return `${JSON.stringify(redactDeep(report), null, 2)}\n`;
}

/** Write a file readable by the owner only (0600), replacing any old copy's contents. */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}
