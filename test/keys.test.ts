import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrillError } from "../src/errors.js";
import { GatewayClient } from "../src/gateway/client.js";
import { DrillKey, drillKeyTtlMinutes } from "../src/gateway/keys.js";
import { FakeGateway } from "./support/fake-gateway.js";

const ADMIN = "admin-key-for-tests-0001";
let gw: FakeGateway;
let client: GatewayClient;

beforeEach(async () => {
  gw = new FakeGateway({ adminKey: ADMIN, userKey: "tk-user-key-for-tests-0001" });
  client = new GatewayClient(await gw.start());
  client.setKey("admin", ADMIN);
});
afterEach(() => gw.stop());

describe("DrillKey", () => {
  it("mints a key with its own user, budget, allow-list and expiry, then revokes all three", async () => {
    const key = new DrillKey(client);
    await key.mint({ runId: "r1", models: ["good:a", "badjson:b"], budgetUsd: 0.25, ttlMinutes: 10 });
    const minted = gw.liveKeys();
    expect(minted).toHaveLength(1);
    expect(minted[0]!.allowedModels).toEqual(["good:a", "badjson:b"]);
    expect(minted[0]!.userId).toBe("firedrill-r1");
    const expiresIn = new Date(minted[0]!.expiresAt!).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(9 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(10 * 60_000);
    expect([...gw.budgets.values()][0]!.max).toBe(0.25);
    expect(client.hasKey("drill")).toBe(true);

    const result = await key.revoke();
    expect(result).toEqual({ revoked: true, lines: [] });
    expect(gw.keys.size).toBe(0);
    expect(gw.budgets.size).toBe(0);
    expect(gw.users.get("firedrill-r1")?.deleted).toBe(true);
    expect(client.hasKey("drill")).toBe(false);
    // Idempotent: a second revoke sends nothing new.
    const before = gw.calls.length;
    await key.revoke();
    expect(gw.calls.length).toBe(before);
  });

  it("cleans up the budget and user when minting the key fails", async () => {
    const key = new DrillKey(client);
    // The budget and user succeed; the key itself is refused.
    const orig = client.request.bind(client);
    client.request = (async (path: string, opts: Parameters<GatewayClient["request"]>[1]) => {
      if (path === "/api/v1/keys" && opts.method === "POST") {
        return { status: 400, ok: false, headers: new Headers(), body: { detail: "API key models exceed user" }, text: "", latencyMs: 1 };
      }
      return orig(path, opts);
    }) as GatewayClient["request"];
    await expect(key.mint({ runId: "r2", models: ["good:a"], budgetUsd: 0.1, ttlMinutes: 10 })).rejects.toThrow(DrillError);
    expect(gw.budgets.size).toBe(0);
    expect(gw.users.get("firedrill-r2")?.deleted).toBe(true);
  });

  it("names the fix when the admin key is wrong", async () => {
    client.setKey("admin", "not-the-admin-key");
    const err = await new DrillKey(client).mint({ runId: "r3", models: ["good:a"], budgetUsd: 0.1, ttlMinutes: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(DrillError);
    expect((err as DrillError).fix).toMatch(/OTARI_ADMIN_KEY/);
  });
});

describe("drillKeyTtlMinutes", () => {
  it("is at least 10 minutes and at most 60", () => {
    expect(drillKeyTtlMinutes(9, 3, 60_000)).toBe(11);
    expect(drillKeyTtlMinutes(1, 3, 1000)).toBe(10);
    expect(drillKeyTtlMinutes(10_000, 3, 60_000)).toBe(60);
  });
});
