import { describe, expect, it } from "vitest";
import { formatTrace, shortPath, TRACE_HEADER } from "../src/trace.js";

describe("trace lines", () => {
  it("are aligned, under 100 characters and name the credential, never its value", () => {
    const line = formatTrace({ step: 7, method: "POST", path: "/api/v1/chat/completions", status: 200, latencyMs: 1234, costUsd: 0.000026, credential: "drill", note: "leg 1 sample 3" });
    expect(line).toBe("[07] POST   /chat/completions                200       1.2s  $0.000026 drill key  leg 1 sample 3");
    expect(line.length).toBeLessThan(100);
    expect(TRACE_HEADER.length).toBeLessThan(100);
    const del = formatTrace({ step: 12, method: "DELETE", path: "/api/v1/keys/9c118126-2347-4ada-9d21-acc1afe10925", status: 204, latencyMs: 9, costUsd: null, credential: "admin" });
    expect(del).toBe("[12] DELETE /keys/9c118126…                  204        9ms  -         admin key");
    // Columns line up.
    expect(line.indexOf("200")).toBe(del.indexOf("204"));
    expect(line.indexOf("drill key")).toBe(del.indexOf("admin key"));
  });

  it("shortens long paths", () => {
    expect(shortPath("/api/v1/workspaces/9d80b3a0-db55-4a5d-9665-ca837aaaaaaa/web-search")).toBe("/workspaces/9d80b3a0…/web-search");
  });
});
