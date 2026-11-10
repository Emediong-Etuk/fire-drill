import { readFile } from "node:fs/promises";
import { z } from "zod";
import { DrillError } from "./errors.js";
import { redactDeep } from "./redact.js";

/** A chat-completion request body, minus the fields Fire Drill controls. */
export type ChatRequest = Record<string, unknown> & {
  messages: Array<Record<string, unknown>>;
};

export interface Sample {
  /** 1-based line number in the samples file. */
  index: number;
  body: ChatRequest;
  /** What was removed or changed, for the report. */
  notes: string[];
}

const MessageSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  })
  .passthrough();

const ChatBodySchema = z
  .object({
    messages: z.array(MessageSchema).min(1),
    response_format: z
      .object({ type: z.enum(["text", "json_object", "json_schema"]) })
      .passthrough()
      .optional(),
    tools: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  })
  .passthrough();

/** Fields a replay never sends as given. */
const STRIPPED = ["model", "stream", "stream_options", "user", "n", "mcp_servers", "mcp_server_ids"] as const;

/**
 * Validate and sanitize one parsed line.
 *
 * - `model` is replaced per leg. `stream` is off so the whole answer can be checked.
 * - `user` is dropped: Otari refuses a key whose request names another user.
 * - Only `function` tools are kept: replays never attach gateway web tools,
 *   MCP servers or provider-native tools.
 * - Every string is redacted for secrets and emails before it is sent,
 *   printed or written.
 */
export function sanitizeSample(raw: unknown, index: number): Sample {
  const parsed = ChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length ? issue.path.join(".") : "the line";
    throw new DrillError(
      `Sample line ${index} is not a chat-completion request body: ${where}: ${issue.message}.`,
      'Each line needs at least {"messages": [{"role": "user", "content": "..."}]}. Run firedrill init for an example file.',
    );
  }
  const body: Record<string, unknown> = { ...parsed.data };
  const notes: string[] = [];
  for (const field of STRIPPED) {
    if (field in body) {
      if (field !== "model") notes.push(`removed "${field}"`);
      delete body[field];
    }
  }
  if (Array.isArray(body.tools)) {
    const tools = body.tools as Array<{ type: string }>;
    const kept = tools.filter((t) => t.type === "function");
    const dropped = tools.filter((t) => t.type !== "function").map((t) => t.type);
    if (dropped.length) notes.push(`removed non-function tools: ${[...new Set(dropped)].join(", ")}`);
    if (kept.length) body.tools = kept;
    else {
      delete body.tools;
      delete body.tool_choice;
    }
  }
  return { index, body: redactDeep(body) as ChatRequest, notes };
}

export function parseSamples(text: string): Sample[] {
  const samples: Sample[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new DrillError(`Sample line ${i + 1} is not valid JSON.`, "Each line of the samples file must be one JSON object (JSONL).");
    }
    samples.push(sanitizeSample(raw, i + 1));
  });
  return samples;
}

export async function loadSamples(path: string): Promise<Sample[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new DrillError(`No samples file at "${path}".`, "Run firedrill init to write a starter samples.jsonl, or pass --samples <file>.");
  }
  const samples = parseSamples(text);
  if (samples.length === 0) {
    throw new DrillError(`"${path}" has no samples.`, "Add one chat-completion request body per line, or run firedrill init --force.");
  }
  return samples;
}
