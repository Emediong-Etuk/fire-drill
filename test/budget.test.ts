import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/budget.js";

describe("BudgetTracker", () => {
  it("refuses a reservation that would pass the cap", () => {
    const b = new BudgetTracker(0.05, { initialEstimateUsd: 0.02 });
    const t1 = b.reserve();
    const t2 = b.reserve();
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(b.reserve()).toBeNull(); // 0.06 > 0.05 with two in flight
    b.settle(t1!, 0.001);
    b.settle(t2!, 0.001);
    expect(b.spentUsd).toBeCloseTo(0.002);
    // The next estimate is the dearest seen (0.001) x 1.5.
    expect(b.estimate()).toBeCloseTo(0.0015);
  });

  it("counts an unknown cost at the estimate so it never undercounts", () => {
    const b = new BudgetTracker(1, { initialEstimateUsd: 0.1 });
    const t = b.reserve()!;
    b.settle(t, null);
    expect(b.spentUsd).toBeCloseTo(0.1);
  });

  it("stops before the cap as costs are learned", () => {
    const b = new BudgetTracker(0.01, { initialEstimateUsd: 0.001 });
    let sent = 0;
    for (;;) {
      const t = b.reserve();
      if (t === null) break;
      b.settle(t, 0.002);
      sent++;
    }
    expect(b.spentUsd).toBeLessThanOrEqual(0.01);
    expect(sent).toBe(4);
  });

  it("frees a released reservation", () => {
    const b = new BudgetTracker(0.01, { initialEstimateUsd: 0.01 });
    const t = b.reserve()!;
    expect(b.reserve()).toBeNull();
    b.release(t);
    expect(b.reserve()).not.toBeNull();
    expect(b.spentUsd).toBe(0);
  });
});
