import { describe, expect, it } from "vitest";
import { exitCodeFor, type LegReport, median, recommend } from "../src/report/model.js";

function leg(index: number, passed: number, total: number, byType: LegReport["failuresByType"] = {}, per1k: number | null = 1): LegReport {
  return {
    index,
    role: index === 1 ? "primary" : `failover ${index - 1}`,
    model: `p:m${index}`,
    total,
    passed,
    passRate: (passed / total) * 100,
    failuresByType: byType,
    errorCodes: {},
    medianLatencyMs: 100,
    costPerRequestUsd: per1k === null ? null : per1k / 1000,
    projectedPer1kUsd: per1k,
    totalCostUsd: 0,
  };
}

describe("recommend", () => {
  it("tells the user to move a failing leg below a passing one", () => {
    const legs = [leg(1, 5, 5), leg(2, 5, 5), leg(3, 1, 5, { json_schema: 4, http: 1 }), leg(4, 5, 5)];
    expect(recommend(legs, 100)).toBe("Leg 3 fails 4/5 schema checks. Move it below leg 4 or remove it.");
  });

  it("tells the user to remove a failing last leg", () => {
    const legs = [leg(1, 3, 3), leg(2, 0, 3, { json_schema: 3 })];
    expect(recommend(legs, 100)).toBe("Leg 2 fails 3/3 schema checks. Remove it or replace it with a model that passes.");
  });

  it("flags a failing primary", () => {
    expect(recommend([leg(1, 2, 3, { http: 1 }), leg(2, 3, 3)], 100)).toMatch(/^Leg 1 fails 1\/3 requests \(HTTP errors\)\. It is the primary/);
  });

  it("names the cheapest leg when everything passes", () => {
    expect(recommend([leg(1, 3, 3, {}, 2), leg(2, 3, 3, {}, 0.5)], 100)).toBe(
      "All 2 legs pass every check. Cheapest is leg 2 (p:m2) at $0.50 per 1,000 requests.",
    );
  });

  it("respects --fail-under", () => {
    const legs = [leg(1, 5, 5), leg(2, 4, 5, { text: 1 })];
    expect(exitCodeFor(legs, 100)).toBe(1);
    expect(exitCodeFor(legs, 80)).toBe(0);
  });
});

describe("median", () => {
  it("handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("recommend with requests that were not sent", () => {
  it("never blames a leg for requests the budget stopped", () => {
    const legs = [leg(1, 5, 5), leg(2, 3, 5, { skipped: 2 }), leg(3, 0, 5, { skipped: 5 })];
    expect(recommend(legs, 100)).toBe("The drill stopped before every request was sent. Raise --budget or lower --runs and run it again.");
  });

  it("ranks on real failures and says the drill was incomplete", () => {
    const legs = [leg(1, 5, 5), leg(2, 4, 5, { tool_call: 1 }), leg(3, 0, 5, { skipped: 5 })];
    expect(recommend(legs, 100)).toBe(
      "Leg 2 fails 1/5 tool-call checks. Remove it, or move it below the legs that pass. Some requests were not sent, so raise --budget for a full drill.",
    );
  });
});
