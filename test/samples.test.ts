import { describe, expect, it } from "vitest";
import { DrillError } from "../src/errors.js";
import { parseSamples, sanitizeSample } from "../src/samples.js";

describe("sanitizeSample", () => {
  it("strips model, stream, user and non-function tools, and records why", () => {
    const s = sanitizeSample(
      {
        model: "gpt-5",
        stream: true,
        user: "alice",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "otari_web_search" }, { type: "function", function: { name: "f", parameters: { type: "object" } } }],
      },
      1,
    );
    expect(s.body).toEqual({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }] });
    expect(s.notes).toEqual(['removed "stream"', 'removed "user"', "removed non-function tools: otari_web_search"]);
  });

  it("drops tool_choice when no function tool is left", () => {
    const s = sanitizeSample({ messages: [{ role: "user", content: "x" }], tools: [{ type: "web_search" }], tool_choice: "auto" }, 1);
    expect(s.body).toEqual({ messages: [{ role: "user", content: "x" }] });
  });

  it("redacts secrets and emails before anything is sent or written", () => {
    const s = sanitizeSample({ messages: [{ role: "user", content: "key sk-abcdefghijklmnopqrstuvwx, mail bob@example.com" }] }, 1);
    expect(s.body.messages[0]!.content).toBe("key [REDACTED_OPENAI_KEY], mail [REDACTED_EMAIL]");
  });

  it("rejects a body with no messages, naming the line and the fix", () => {
    const err = (() => {
      try {
        sanitizeSample({ prompt: "hi" }, 4);
      } catch (e) {
        return e as DrillError;
      }
    })();
    expect(err).toBeInstanceOf(DrillError);
    expect(err!.message).toMatch(/^Sample line 4 is not a chat-completion request body: messages/);
    expect(err!.fix).toMatch(/firedrill init/);
  });
});

describe("parseSamples", () => {
  it("skips blank and comment lines and reports bad JSON by line", () => {
    expect(parseSamples('\n# c\n{"messages":[{"role":"user","content":"a"}]}\n')).toHaveLength(1);
    expect(() => parseSamples('{"messages": [}\n')).toThrow(/Sample line 1 is not valid JSON/);
  });
});
