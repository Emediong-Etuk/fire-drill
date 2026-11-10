/**
 * Client-side budget: the second of the two budget checks (the first is the
 * gateway's own budget on the drill key).
 *
 * Every request reserves an estimate before it is sent. The estimate is the
 * dearest request seen so far, times a margin, so with requests in flight the
 * running total plus all reservations never passes the cap.
 */
export class BudgetTracker {
  readonly capUsd: number;
  private spent = 0;
  private reserved = 0;
  private maxSeen = 0;
  private nextId = 0;
  private readonly open = new Map<number, number>();
  /** Estimate for the very first request, before any cost is known. */
  private readonly initialEstimate: number;
  private readonly margin: number;

  constructor(capUsd: number, opts: { initialEstimateUsd?: number; margin?: number } = {}) {
    this.capUsd = capUsd;
    this.initialEstimate = opts.initialEstimateUsd ?? Math.min(0.01, capUsd / 20);
    this.margin = opts.margin ?? 1.5;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get reservedUsd(): number {
    return this.reserved;
  }

  estimate(): number {
    return this.maxSeen > 0 ? this.maxSeen * this.margin : this.initialEstimate;
  }

  /**
   * Reserve room for one request. Returns a token, or null when it would pass
   * the cap. `knownCost` replaces the estimate when the price is known up front.
   */
  reserve(knownCost?: number): number | null {
    const est = knownCost ?? this.estimate();
    if (this.spent + this.reserved + est > this.capUsd + 1e-12) return null;
    const id = ++this.nextId;
    this.open.set(id, est);
    this.reserved += est;
    return id;
  }

  /**
   * Settle a reservation with the cost the gateway reported. An unknown cost
   * (an unpriced model, or a missing field) keeps the reservation as spent,
   * so the total never undercounts.
   */
  settle(token: number, costUsd: number | null): void {
    const est = this.open.get(token);
    if (est === undefined) return;
    this.open.delete(token);
    this.reserved -= est;
    const actual = costUsd ?? est;
    this.spent += actual;
    if (costUsd !== null && costUsd > this.maxSeen) this.maxSeen = costUsd;
  }

  /** Settle without letting this cost raise the per-request estimate (a tool call, not a completion). */
  settleTool(token: number, costUsd: number): void {
    const est = this.open.get(token);
    if (est === undefined) return;
    this.open.delete(token);
    this.reserved -= est;
    this.spent += costUsd;
  }

  /** Release a reservation for a request that was never sent. */
  release(token: number): void {
    const est = this.open.get(token);
    if (est === undefined) return;
    this.open.delete(token);
    this.reserved -= est;
  }
}
