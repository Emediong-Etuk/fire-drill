import { afterEach, describe, expect, it } from "vitest";
import { clearSecrets, excerpt, redact, redactDeep, registerSecret, scrub } from "../src/redact.js";

afterEach(() => clearSecrets());

describe("redact", () => {
  it.each([
    ["OpenAI key", "use sk-proj-abcdefghijklmnopqrstuvwx now", "[REDACTED_OPENAI_KEY]"],
    ["Anthropic key", "sk-ant-api03-abcdefghijklmnop", "[REDACTED_ANTHROPIC_KEY]"],
    ["Otari key", "tk-0123456789abcdefABCDEF", "[REDACTED_OTARI_KEY]"],
    ["otari.ai key", "otk_0123456789abcdefABCDEF", "[REDACTED_OTARI_KEY]"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123", "[REDACTED_GITHUB_TOKEN]"],
    ["AWS key", "AKIAIOSFODNN7EXAMPLE", "[REDACTED_AWS_KEY]"],
    ["Google key", "AIzaSyA1234567890abcdefghijklmnopqrstu", "[REDACTED_GOOGLE_KEY]"],
    ["email", "mail jane.doe+x@example.co.uk please", "[REDACTED_EMAIL]"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "[REDACTED_JWT]"],
  ])("removes a %s", (_name, input, marker) => {
    const out = redact(input);
    expect(out).toContain(marker);
  });

  it("keeps the scheme of a bearer token but drops the token", () => {
    expect(redact("Authorization: Bearer abc.def-ghi_jkl")).toBe("Authorization: Bearer [REDACTED_TOKEN]");
  });

  it("removes a private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redact(`key:\n${pem}\nend`)).toBe("key:\n[REDACTED_PRIVATE_KEY]\nend");
  });

  it("removes the value of a secret assignment", () => {
    expect(redact('password = "hunter2hunter2"')).toBe('password = "[REDACTED_SECRET]"');
  });

  it("leaves ordinary text alone", () => {
    const text = "Summarize this invoice for ACME in two sentences.";
    expect(redact(text)).toBe(text);
  });

  it("redacts every string in a nested value", () => {
    const out = redactDeep({ messages: [{ role: "user", content: "my key is sk-abcdefghijklmnopqrstuv" }], n: 1 });
    expect(out).toEqual({ messages: [{ role: "user", content: "my key is [REDACTED_OPENAI_KEY]" }], n: 1 });
  });
});

describe("scrub", () => {
  it("removes registered secrets of any shape", () => {
    registerSecret("my-weird-master-key");
    expect(scrub("auth my-weird-master-key failed")).toBe("auth [REDACTED] failed");
  });
});

describe("excerpt", () => {
  it("flattens whitespace and truncates", () => {
    expect(excerpt("a\n\n b", 10)).toBe("a b");
    expect(excerpt("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
