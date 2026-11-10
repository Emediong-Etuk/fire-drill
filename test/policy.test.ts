import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DrillError } from "../src/errors.js";
import { normalizeGatewayUrl } from "../src/gateway/client.js";
import { choosePolicy, legsFromConfigFile, legsFromFlag, legsFromSpec } from "../src/gateway/policy.js";

describe("legsFromSpec", () => {
  it("orders a failover policy: primary, then on_failure", () => {
    const legs = legsFromSpec({
      select: [{ default: "openai:gpt-5-mini" }],
      on_failure: ["anthropic:claude-haiku-4-5", "groq:llama-3.1-8b"],
    });
    expect(legs).toEqual([
      { index: 1, role: "primary", model: "openai:gpt-5-mini" },
      { index: 2, role: "failover 1", model: "anthropic:claude-haiku-4-5" },
      { index: 3, role: "failover 2", model: "groq:llama-3.1-8b" },
    ]);
  });

  it("labels budget conditions as tier-down and other conditions as conditional", () => {
    const legs = legsFromSpec({
      select: [
        { when: { budget_used_pct: { gte: 80 } }, target: "openai:gpt-5-nano" },
        { when: { user_id: "alice" }, target: "openai:gpt-5" },
        { default: "openai:gpt-5-mini" },
      ],
      on_failure: ["anthropic:claude-haiku-4-5"],
    });
    expect(legs.map((l) => [l.role, l.model])).toEqual([
      ["primary", "openai:gpt-5-mini"],
      ["tier-down 1", "openai:gpt-5-nano"],
      ["conditional 1", "openai:gpt-5"],
      ["failover 1", "anthropic:claude-haiku-4-5"],
    ]);
  });

  it("includes weighted router candidates and drops duplicates", () => {
    const legs = legsFromSpec({
      select: [
        { router: "weighted", candidates: ["openai:gpt-5", "anthropic:claude-sonnet-4-6"] },
        { default: "openai:gpt-5" },
      ],
      on_failure: ["gemini:gemini-2.5-flash", "openai:gpt-5"],
    });
    expect(legs.map((l) => [l.role, l.model])).toEqual([
      ["primary", "openai:gpt-5"],
      ["weighted 1", "anthropic:claude-sonnet-4-6"],
      ["failover 1", "gemini:gemini-2.5-flash"],
    ]);
  });

  it("labels priority routers", () => {
    const legs = legsFromSpec({
      select: [{ router: "priority", candidates: ["vertex:gemini-2.5-flash", "together:llama-3.3-70b"] }, { default: "together:llama-3.3-70b" }],
    });
    expect(legs.map((l) => l.role)).toEqual(["primary", "priority 1"]);
  });
});

describe("legsFromFlag", () => {
  it("makes the first leg primary and the rest failovers", () => {
    expect(legsFromFlag(" a:x , b:y,a:x ")).toEqual([
      { index: 1, role: "primary", model: "a:x" },
      { index: 2, role: "failover 1", model: "b:y" },
    ]);
  });

  it("rejects an empty list with a fix", () => {
    expect(() => legsFromFlag(" , ")).toThrow(DrillError);
  });
});

describe("legsFromConfigFile", () => {
  it("reads routing.policies.<alias> from config.yml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "firedrill-"));
    const path = join(dir, "config.yml");
    await writeFile(
      path,
      ["routing:", "  policies:", "    fast:", "      select:", "        - default: openai:gpt-5-mini", "      on_failure:", "        - anthropic:claude-haiku-4-5", ""].join("\n"),
    );
    const legs = await legsFromConfigFile(path, "fast");
    expect(legs.map((l) => l.model)).toEqual(["openai:gpt-5-mini", "anthropic:claude-haiku-4-5"]);
    await expect(legsFromConfigFile(path, "slow")).rejects.toThrow(/has no routing policy named "slow" \(it has: fast\)/);
  });
});

describe("choosePolicy", () => {
  const spec = { select: [{ default: "a:b" }] };
  it("prefers config.yml over stored policies of the same name", () => {
    const chosen = choosePolicy(
      [
        { name: "fast", spec, source: "stored", workspace_id: "w1" },
        { name: "fast", spec, source: "config" },
      ],
      "fast",
    );
    expect(chosen?.source).toBe("config");
  });

  it("asks for --workspace when a stored name is ambiguous", () => {
    let caught: unknown;
    try {
      choosePolicy(
        [
          { name: "fast", spec, source: "stored", workspace_id: "w1" },
          { name: "fast", spec, source: "stored", workspace_id: "w2" },
        ],
        "fast",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DrillError);
    expect((caught as DrillError).fix).toMatch(/--workspace with one of: w1, w2/);
  });

  it("ignores user-scoped policies", () => {
    expect(choosePolicy([{ name: "fast", spec, source: "stored", user_id: "u" }], "fast")).toBeUndefined();
  });
});

describe("normalizeGatewayUrl", () => {
  it("accepts the host, /api or /api/v1", () => {
    expect(normalizeGatewayUrl("http://localhost:8000")).toBe("http://localhost:8000");
    expect(normalizeGatewayUrl("http://localhost:8000/api/")).toBe("http://localhost:8000");
    expect(normalizeGatewayUrl("https://api.otari.ai/api/v1")).toBe("https://api.otari.ai");
  });
  it("rejects other schemes", () => {
    expect(() => normalizeGatewayUrl("ftp://x")).toThrow();
  });
});
