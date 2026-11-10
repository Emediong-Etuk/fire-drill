/**
 * Opt-in test against a real Otari. Skipped unless FIREDRILL_LIVE=1.
 *
 *   FIREDRILL_LIVE=1 OTARI_BASE_URL=http://localhost:8000 OTARI_ADMIN_KEY=... \
 *   FIREDRILL_LIVE_ALIAS=demo npm run test:live
 *
 * FIREDRILL_LIVE_ALIAS names a routing policy on that gateway; or set
 * FIREDRILL_LIVE_LEGS=a,b,c instead.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const live = process.env.FIREDRILL_LIVE === "1";
const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

describe.skipIf(!live)("live Otari", () => {
  it("runs a drill and leaves no drill key behind", async () => {
    const base = process.env.OTARI_BASE_URL ?? "http://localhost:8000";
    const admin = process.env.OTARI_ADMIN_KEY;
    expect(admin, "set OTARI_ADMIN_KEY").toBeTruthy();
    const dir = await mkdtemp(join(tmpdir(), "firedrill-live-"));
    const samples = join(dir, "samples.jsonl");
    expect(spawnSync(process.execPath, [CLI, "init", "--samples", samples]).status).toBe(0);

    const args = [CLI, process.env.FIREDRILL_LIVE_ALIAS ?? "live", "--samples", samples, "--budget", process.env.FIREDRILL_LIVE_BUDGET ?? "0.10"];
    if (process.env.FIREDRILL_LIVE_LEGS) args.push("--legs", process.env.FIREDRILL_LIVE_LEGS);
    const run = spawnSync(process.execPath, args, { env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8", timeout: 300_000 });
    const output = run.stdout + run.stderr;
    expect([0, 1], output).toContain(run.status);
    expect(output).toContain("Drill key revoked.");
    expect(output).not.toContain(admin!);

    const res = await fetch(`${base.replace(/\/+$/, "")}/api/v1/keys?limit=1000`, { headers: { Authorization: `Bearer ${admin}` } });
    expect(res.ok).toBe(true);
    const keys = (await res.json()) as Array<{ key_name?: string | null; is_active: boolean }>;
    const leftover = keys.filter((k) => k.key_name?.startsWith("firedrill-") && k.is_active);
    expect(leftover).toEqual([]);
  }, 320_000);
});
