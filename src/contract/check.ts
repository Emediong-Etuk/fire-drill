import { Ajv, type ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";
import { excerpt } from "../redact.js";
import type { Contract } from "./derive.js";

// ajv-formats ships CommonJS; under NodeNext its default export is the module object.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (a: Ajv) => Ajv;

export type FailureType =
  | "http"
  | "served_model"
  | "json_schema"
  | "json_object"
  | "tool_call"
  | "text"
  | "code_exec"
  | "skipped";

export interface Failure {
  type: FailureType;
  message: string;
  excerpt?: string;
  /** Otari's error code, for HTTP failures. */
  code?: string;
}

/** One response as the checker needs it. */
export interface Observed {
  status: number | "ERR";
  /** Gateway or transport error, when the call failed. */
  error?: string;
  errorCode?: string;
  leg: string;
  servedProvider?: string | null;
  servedModel?: string | null;
  body?: unknown;
}

/** What the primary leg did for the same sample, for cross-leg checks. */
export interface PrimaryBaseline {
  calledTool: boolean;
  refused: boolean;
}

interface ChatMessage {
  content?: unknown;
  refusal?: unknown;
  tool_calls?: Array<{ type?: string; function?: { name?: string; arguments?: unknown } }>;
}

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
const validators = new WeakMap<object, ValidateFunction | Error>();

function validatorFor(schema: Record<string, unknown>): ValidateFunction | Error {
  let v = validators.get(schema);
  if (!v) {
    try {
      v = ajv.compile(schema);
    } catch (err) {
      v = err instanceof Error ? err : new Error(String(err));
    }
    validators.set(schema, v);
  }
  return v;
}

function schemaErrors(v: ValidateFunction): string {
  return (v.errors ?? [])
    .slice(0, 2)
    .map((e) => {
      const at = e.instancePath ? e.instancePath.slice(1).replace(/\//g, ".") : "";
      if (e.keyword === "required") return `missing "${at ? `${at}.` : ""}${String(e.params.missingProperty)}"`;
      if (e.keyword === "additionalProperties") return `unexpected "${at ? `${at}.` : ""}${String(e.params.additionalProperty)}"`;
      if (e.keyword === "enum") return `"${at}" must be one of ${(e.params.allowedValues as unknown[]).map((x) => JSON.stringify(x)).join(", ")}`;
      return `${at ? `"${at}" ` : ""}${e.message ?? "is invalid"}`;
    })
    .join("; ");
}

function firstChoice(body: unknown): { message?: ChatMessage; finish_reason?: string } | undefined {
  const choices = (body as { choices?: unknown })?.choices;
  return Array.isArray(choices) ? choices[0] : undefined;
}

export function contentText(body: unknown): string {
  const content = firstChoice(body)?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  }
  return "";
}

export function toolCalls(body: unknown): Array<{ name: string; arguments: string }> {
  const calls = firstChoice(body)?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .filter((c) => c?.function?.name)
    .map((c) => ({
      name: String(c.function!.name),
      arguments: typeof c.function!.arguments === "string" ? c.function!.arguments : JSON.stringify(c.function!.arguments ?? {}),
    }));
}

const REFUSAL_RE =
  /^(?:i'?m sorry|i am sorry|sorry|unfortunately)[^.!?]{0,80}\b(?:can(?:no|')t|unable|won'?t|not able)\b|\bi (?:can(?:no|')t|won'?t) (?:help|assist|comply|do that|provide)|\bi'?m (?:not able|unable) to (?:help|assist|comply)/i;

export function isRefusal(body: unknown): boolean {
  const msg = firstChoice(body)?.message;
  if (msg && typeof msg.refusal === "string" && msg.refusal.trim()) return true;
  return REFUSAL_RE.test(contentText(body).trim().slice(0, 240));
}

export function baselineOf(observed: Observed | undefined): PrimaryBaseline {
  if (!observed || observed.status !== 200) return { calledTool: false, refused: false };
  return { calledTool: toolCalls(observed.body).length > 0, refused: isRefusal(observed.body) };
}

/** `instance:model` → the pair Otari reports in Otari-Provider / Otari-Model. */
export function expectedServed(leg: string): { instance?: string; model: string; loose: boolean } {
  const colon = leg.indexOf(":");
  if (colon === -1) return { model: leg.split("/").pop() ?? leg, loose: true };
  const instance = leg.slice(0, colon);
  const model = leg.slice(colon + 1);
  // `provider:vendor/model` lets Otari pick the provider's own spelling of the model.
  return model.includes("/") ? { instance, model: model.split("/").pop() ?? model, loose: true } : { instance, model, loose: false };
}

function servedMatches(o: Observed): Failure | undefined {
  if (!o.servedModel && !o.servedProvider) return undefined; // Older gateway: nothing to compare.
  const exp = expectedServed(o.leg);
  const provider = o.servedProvider ?? "";
  const model = o.servedModel ?? "";
  const providerOk = !exp.instance || provider === exp.instance;
  const modelOk = exp.loose ? model === exp.model || model.endsWith(exp.model) || model.endsWith(`/${exp.model}`) : model === exp.model;
  if (providerOk && modelOk) return undefined;
  return { type: "served_model", message: `asked for ${o.leg}, served by ${provider || "?"}:${model || "?"}` };
}

function checkJsonSchema(text: string, contract: NonNullable<Contract["jsonSchema"]>): Failure | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const fenced = /^\s*```/.test(text);
    return {
      type: "json_schema",
      message: fenced ? "output is wrapped in a code fence, not bare JSON" : "output is not valid JSON",
      excerpt: excerpt(text),
    };
  }
  const v = validatorFor(contract.schema);
  if (v instanceof Error) return { type: "json_schema", message: `the request's schema does not compile: ${v.message}` };
  if (!v(parsed)) return { type: "json_schema", message: `output breaks the schema: ${schemaErrors(v)}`, excerpt: excerpt(text) };
  return undefined;
}

function checkJsonObject(text: string): Failure | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return undefined;
    return { type: "json_object", message: "output is JSON but not an object", excerpt: excerpt(text) };
  } catch {
    return { type: "json_object", message: "output is not valid JSON", excerpt: excerpt(text) };
  }
}

function checkToolCalls(o: Observed, contract: Contract, baseline: PrimaryBaseline, isPrimary: boolean): Failure | undefined {
  const calls = toolCalls(o.body);
  const tools = contract.tools ?? [];
  if (calls.length === 0) {
    if (contract.toolRequired) return { type: "tool_call", message: "tool_choice requires a tool call, and none was made", excerpt: excerpt(contentText(o.body)) };
    if (!isPrimary && baseline.calledTool) return { type: "tool_call", message: "the primary leg called a tool here; this leg answered in text", excerpt: excerpt(contentText(o.body)) };
    return undefined;
  }
  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.name);
    if (!tool) return { type: "tool_call", message: `called "${call.name}", which is not in the request's tools` };
    if (contract.forcedTool && call.name !== contract.forcedTool) return { type: "tool_call", message: `tool_choice forces "${contract.forcedTool}", called "${call.name}"` };
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return { type: "tool_call", message: `arguments for "${call.name}" are not valid JSON`, excerpt: excerpt(call.arguments) };
    }
    if (tool.parameters) {
      const v = validatorFor(tool.parameters);
      if (v instanceof Error) return { type: "tool_call", message: `the "${call.name}" parameter schema does not compile: ${v.message}` };
      if (!v(args)) return { type: "tool_call", message: `"${call.name}" arguments break its schema: ${schemaErrors(v)}`, excerpt: excerpt(call.arguments) };
    }
  }
  return undefined;
}

function checkText(o: Observed, baseline: PrimaryBaseline, isPrimary: boolean): Failure | undefined {
  const choice = firstChoice(o.body);
  const text = contentText(o.body);
  if (choice?.finish_reason === "length") return { type: "text", message: "answer was cut off (finish_reason: length)", excerpt: excerpt(text) };
  if (!text.trim()) return { type: "text", message: "answer is empty" };
  if (!isPrimary && !baseline.refused && isRefusal(o.body)) return { type: "text", message: "refused where the primary leg answered", excerpt: excerpt(text) };
  return undefined;
}

/**
 * Check one response against its contract. Returns every failure found;
 * an empty list is a pass.
 */
export function checkResponse(o: Observed, contract: Contract, baseline: PrimaryBaseline, isPrimary: boolean): Failure[] {
  if (o.status !== 200) {
    const f: Failure = { type: "http", message: o.error ?? `HTTP ${o.status}` };
    if (o.errorCode) f.code = o.errorCode;
    return [f];
  }
  const failures: Failure[] = [];
  const served = servedMatches(o);
  if (served) failures.push(served);
  if (!firstChoice(o.body)) {
    failures.push({ type: "http", message: "response has no choices" });
    return failures;
  }

  const calls = toolCalls(o.body);
  if (contract.tools) {
    const f = checkToolCalls(o, contract, baseline, isPrimary);
    if (f) failures.push(f);
  }
  // A tool call is the answer; the format and text checks apply to text answers.
  if (calls.length === 0) {
    const text = contentText(o.body);
    if (contract.jsonSchema) {
      const f = checkJsonSchema(text, contract.jsonSchema);
      if (f) failures.push(f);
    } else if (contract.jsonObject) {
      const f = checkJsonObject(text);
      if (f) failures.push(f);
    }
    if (!contract.tools || !failures.some((f) => f.type === "tool_call")) {
      const f = checkText(o, baseline, isPrimary);
      // JSON contracts already cover empty output; keep truncation and refusal.
      if (f && (contract.text || f.message.startsWith("answer was cut off"))) failures.push(f);
    }
  }
  return failures;
}
