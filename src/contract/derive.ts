import type { ChatRequest } from "../samples.js";

export interface ToolSpec {
  name: string;
  /** JSON Schema of the arguments; undefined accepts any object. */
  parameters?: Record<string, unknown>;
}

/**
 * What a response must satisfy, read from the request alone.
 * No user-written tests: the request already says what the app expects.
 */
export interface Contract {
  /** `response_format: json_schema` */
  jsonSchema?: { name?: string; schema: Record<string, unknown> };
  /** `response_format: json_object` */
  jsonObject?: boolean;
  /** Function tools offered to the model. */
  tools?: ToolSpec[];
  /** `tool_choice` forces a call ("required" or a named function). */
  toolRequired?: boolean;
  /** Name of the function `tool_choice` forces, if any. */
  forcedTool?: string;
  /** Plain text expected when nothing above applies. */
  text: boolean;
}

export function deriveContract(body: ChatRequest): Contract {
  const contract: Contract = { text: false };
  const rf = body.response_format as { type?: string; json_schema?: { name?: string; schema?: Record<string, unknown> } } | undefined;
  if (rf?.type === "json_schema") {
    contract.jsonSchema = { name: rf.json_schema?.name, schema: rf.json_schema?.schema ?? {} };
  } else if (rf?.type === "json_object") {
    contract.jsonObject = true;
  }

  const tools = Array.isArray(body.tools) ? (body.tools as Array<{ type?: string; function?: { name?: string; parameters?: Record<string, unknown> } }>) : [];
  const fns = tools.filter((t) => t.type === "function" && t.function?.name);
  if (fns.length) {
    contract.tools = fns.map((t) => ({ name: t.function!.name!, parameters: t.function!.parameters }));
    const choice = body.tool_choice as string | { type?: string; function?: { name?: string } } | undefined;
    if (choice === "required") contract.toolRequired = true;
    else if (choice && typeof choice === "object" && choice.function?.name) {
      contract.toolRequired = true;
      contract.forcedTool = choice.function.name;
    }
  }

  contract.text = !contract.jsonSchema && !contract.jsonObject;
  return contract;
}

/** Short label of a contract, for the report. */
export function describeContract(c: Contract): string {
  const parts: string[] = [];
  if (c.jsonSchema) parts.push(`json_schema${c.jsonSchema.name ? ` "${c.jsonSchema.name}"` : ""}`);
  if (c.jsonObject) parts.push("json_object");
  if (c.tools) parts.push(`tools (${c.tools.map((t) => t.name).join(", ")})`);
  if (!parts.length) parts.push("text");
  return parts.join(" + ");
}
