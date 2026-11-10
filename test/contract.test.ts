import { describe, expect, it } from "vitest";
import { baselineOf, checkResponse, expectedServed, isRefusal, type Observed } from "../src/contract/check.js";
import { deriveContract, describeContract } from "../src/contract/derive.js";
import { STARTER_SAMPLES } from "../src/init.js";
import type { ChatRequest } from "../src/samples.js";

const [schemaReq, toolReq, textReq] = STARTER_SAMPLES as ChatRequest[];

function chat(content: string | null, extra: Record<string, unknown> = {}, finish = "stop") {
  return { choices: [{ index: 0, message: { role: "assistant", content, ...extra }, finish_reason: finish }] };
}

function obs(body: unknown, leg = "openai:gpt-5-mini", status: number | "ERR" = 200): Observed {
  const [p, m] = leg.split(":");
  return { status, leg, servedProvider: p, servedModel: m, body };
}

const noBaseline = { calledTool: false, refused: false };

describe("deriveContract", () => {
  it("reads json_schema, tools and plain text from the starter samples", () => {
    expect(describeContract(deriveContract(schemaReq!))).toBe('json_schema "order"');
    expect(describeContract(deriveContract(toolReq!))).toBe("tools (get_weather)");
    expect(describeContract(deriveContract(textReq!))).toBe("text");
  });

  it("reads json_object and a forced tool_choice", () => {
    expect(deriveContract({ messages: [], response_format: { type: "json_object" } }).jsonObject).toBe(true);
    const c = deriveContract({ ...toolReq!, tool_choice: { type: "function", function: { name: "get_weather" } } });
    expect(c.toolRequired).toBe(true);
    expect(c.forcedTool).toBe("get_weather");
  });
});

describe("checkResponse: json_schema", () => {
  const contract = deriveContract(schemaReq!);
  it("passes valid output", () => {
    const good = JSON.stringify({ items: [{ product: "blue mug", quantity: 3 }], city: "Leeds" });
    expect(checkResponse(obs(chat(good)), contract, noBaseline, true)).toEqual([]);
  });
  it("fails output that is not JSON", () => {
    const [f] = checkResponse(obs(chat("Sure! Here is your order: 3 mugs.")), contract, noBaseline, false);
    expect(f?.type).toBe("json_schema");
    expect(f?.message).toBe("output is not valid JSON");
    expect(f?.excerpt).toContain("Sure!");
  });
  it("names a code fence", () => {
    const [f] = checkResponse(obs(chat('```json\n{"city":"Leeds"}\n```')), contract, noBaseline, false);
    expect(f?.message).toMatch(/code fence/);
  });
  it("fails JSON that breaks the schema, naming the field", () => {
    const [f] = checkResponse(obs(chat(JSON.stringify({ items: [{ product: "mug", quantity: 0 }] }))), contract, noBaseline, false);
    expect(f?.type).toBe("json_schema");
    expect(f?.message).toMatch(/must have required property 'city'|quantity/);
  });
  it("fails a truncated answer", () => {
    const fs = checkResponse(obs(chat('{"items": [', {}, "length")), contract, noBaseline, false);
    expect(fs.map((f) => f.type)).toEqual(["json_schema", "text"]);
  });
});

describe("checkResponse: json_object", () => {
  const contract = deriveContract({ messages: [], response_format: { type: "json_object" } });
  it("needs an object", () => {
    expect(checkResponse(obs(chat('{"a":1}')), contract, noBaseline, false)).toEqual([]);
    expect(checkResponse(obs(chat("[1,2]")), contract, noBaseline, false)[0]?.message).toMatch(/not an object/);
  });
});

describe("checkResponse: tools", () => {
  const contract = deriveContract(toolReq!);
  const call = (name: string, args: string) => chat(null, { tool_calls: [{ id: "c1", type: "function", function: { name, arguments: args } }] });

  it("passes a valid tool call", () => {
    expect(checkResponse(obs(call("get_weather", '{"city":"Lagos","unit":"celsius"}')), contract, noBaseline, true)).toEqual([]);
  });
  it("fails arguments that break the parameter schema", () => {
    const [f] = checkResponse(obs(call("get_weather", '{"city":"Lagos","unit":"kelvin"}')), contract, noBaseline, false);
    expect(f?.type).toBe("tool_call");
    expect(f?.message).toMatch(/do not match its schema/);
  });
  it("fails a call to an unknown tool", () => {
    expect(checkResponse(obs(call("get_time", "{}")), contract, noBaseline, false)[0]?.message).toMatch(/not in the request's tools/);
  });
  it("fails arguments that are not JSON", () => {
    expect(checkResponse(obs(call("get_weather", "{city: Lagos")), contract, noBaseline, false)[0]?.message).toMatch(/not valid JSON/);
  });
  it("fails a text answer when the primary called a tool", () => {
    const [f] = checkResponse(obs(chat("It is sunny.")), contract, { calledTool: true, refused: false }, false);
    expect(f?.message).toMatch(/primary leg called a tool/);
  });
  it("accepts a text answer when the primary also answered in text", () => {
    expect(checkResponse(obs(chat("Which city?")), contract, noBaseline, false)).toEqual([]);
  });
});

describe("checkResponse: text", () => {
  const contract = deriveContract(textReq!);
  it("fails empty answers and refusals the primary did not make", () => {
    expect(checkResponse(obs(chat("  ")), contract, noBaseline, false)[0]?.message).toBe("answer is empty");
    expect(checkResponse(obs(chat("I'm sorry, but I can't help with that.")), contract, noBaseline, false)[0]?.message).toMatch(/refused/);
    expect(checkResponse(obs(chat("I'm sorry, but I can't help with that.")), contract, { calledTool: false, refused: true }, false)).toEqual([]);
  });
});

describe("checkResponse: always", () => {
  const contract = deriveContract(textReq!);
  it("fails a non-200 status with the gateway's detail", () => {
    expect(checkResponse({ status: 502, leg: "a:b", error: "502 upstream failed" }, contract, noBaseline, false)).toEqual([
      { type: "http", message: "502 upstream failed" },
    ]);
  });
  it("fails when another model served the request", () => {
    const o = { ...obs(chat("hi")), servedProvider: "anthropic", servedModel: "claude-haiku-4-5" };
    expect(checkResponse(o, contract, noBaseline, false)[0]).toEqual({
      type: "served_model",
      message: "asked for openai:gpt-5-mini, served by anthropic:claude-haiku-4-5",
    });
  });
});

describe("helpers", () => {
  it("parses expected served models", () => {
    expect(expectedServed("openai:gpt-5-mini")).toEqual({ instance: "openai", model: "gpt-5-mini", loose: false });
    expect(expectedServed("nebius:deepseek/deepseek-v4")).toEqual({ instance: "nebius", model: "deepseek-v4", loose: true });
  });
  it("detects refusals and baselines", () => {
    expect(isRefusal(chat(null, { refusal: "No." }))).toBe(true);
    expect(isRefusal(chat("Unfortunately I cannot assist with this request."))).toBe(true);
    expect(isRefusal(chat("Sorry for the wait! Here is the answer."))).toBe(false);
    expect(baselineOf(undefined)).toEqual(noBaseline);
  });
});
