/**
 * End-to-end drills against a fake Otari (test/support/fake-gateway.ts).
 * In-process runs use runCli with a capturing Output; signal tests spawn the
 * built CLI (npm test builds it first).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCli, runInit } from "../src/app.js";
import type { Output } from "../src/io.js";
import type { RawFlags } from "../src/options.js";
import { clearSecrets } from "../src/redact.js";
import { FakeGateway, type FakeGatewayOptions } from "./support/fake-gateway.js";

const ADMIN = "admin-LEAKCANARY-0f9e8d7c6b5a";
const USER = "tk-LEAKCANARYuser0123456789";
const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const POLICY = { name: "fast", spec: { select: [{ default: "good:primary" }], on_failure: ["badjson:cheap", "broken:down"] } };

let samples: string;
let gw: FakeGateway | undefined;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "firedrill-it-"));
  samples = join(dir, "samples.jsonl");
  await runInit(samples, false, capture().output);
});

afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  clearSecrets();
});

function capture(): { output: Output; text: () => string; stdout: () => string } {
  let out = "";
  let err = "";
  return {
    output: { out: (t) => (out += t), err: (t) => (err += t), color: false },
    text: () => out + err,
    stdout: () => out,
  };
}

async function startGateway(opts: Partial<FakeGatewayOptions> = {}): Promise<string> {
  gw = new FakeGateway({ adminKey: ADMIN, userKey: USER, policies: [POLICY], ...opts });
  return gw.start();
}

async function drill(flags: RawFlags) {
  const cap = capture();
  const code = await runCli("fast", { samples, ...flags }, {}, cap.output);
  return { code, text: cap.text(), stdout: cap.stdout() };
}

function expectCleanedUp(g: FakeGateway) {
  expect(g.liveKeys()).toEqual([]);
  expect(g.budgets.size).toBe(0);
  for (const u of g.users.values()) expect(u.deleted).toBe(true);
  const deletes = g.calls.filter((c) => c.method === "DELETE").map((c) => c.path.split("/")[3]);
  expect(deletes).toEqual(["keys", "users", "budgets"]);
}

describe("a drill against a policy with a broken and a bad-JSON leg", () => {
  it("reports each leg, recommends a change, exits 1 and revokes the key", async () => {
    const url = await startGateway();
    const { code, stdout } = await drill({ gateway: url, adminKey: ADMIN });
    expect(code).toBe(1);
    expect(stdout).toMatch(/1 {2}primary {5}good:primary\s+3\/3 100%/);
    expect(stdout).toMatch(/2 {2}failover 1 {2}badjson:cheap\s+1\/3 33%\s+schema 1, tool 1/);
    expect(stdout).toMatch(/3 {2}failover 2 {2}broken:down\s+0\/3 0%\s+http 3/);
    expect(stdout).toContain("leg 2  sample 1  schema  output is not valid JSON");
    expect(stdout).toContain("leg 3  samples 1-3  http  500 Provider error");
    expect(stdout).toContain("Drill key revoked.");
    expect(stdout).toContain("Leg 3 fails 3/3 requests (Otari: provider_error). Remove it or replace it with a model that passes.");
    expectCleanedUp(gw!);
  });

  it("replays on the drill key only, never the admin or user key", async () => {
    const url = await startGateway();
    await drill({ gateway: url, adminKey: ADMIN });
    const completions = gw!.calls.filter((c) => c.path === "/api/v1/chat/completions");
    expect(completions).toHaveLength(9 + 3); // 3 samples x 3 legs, plus one retry per 500
    expect(new Set(completions.map((c) => c.auth))).toEqual(new Set(["drill"]));
    // The primary runs first, and no replay carries web tools or a model the leg did not name.
    expect((completions[0]!.body as { model: string }).model).toBe("good:primary");
    for (const c of completions) {
      const body = c.body as { tools?: Array<{ type: string }>; stream: boolean; metadata: Record<string, string> };
      expect(body.stream).toBe(false);
      expect((body.tools ?? []).every((t) => t.type === "function")).toBe(true);
      expect(body.metadata.firedrill_run).toMatch(/^\d{8}-[0-9a-f]{6}$/);
    }
  });
});

describe("exit codes", () => {
  it("exits 0 when every leg passes", async () => {
    const url = await startGateway({ policies: [{ name: "fast", spec: { select: [{ default: "good:a" }], on_failure: ["good:b"] } }] });
    const { code, stdout } = await drill({ gateway: url, adminKey: ADMIN });
    expect(code).toBe(0);
    expect(stdout).toContain("All 2 legs pass every check.");
    expectCleanedUp(gw!);
  });

  it("honours --fail-under", async () => {
    const url = await startGateway();
    const { code } = await drill({ gateway: url, adminKey: ADMIN, legs: "good:a,badjson:b", failUnder: "30" });
    expect(code).toBe(0);
  });

  it("exits 2 with the fix when the gateway is down", async () => {
    const { code, text } = await drill({ gateway: "http://127.0.0.1:9", adminKey: ADMIN });
    expect(code).toBe(2);
    expect(text).toMatch(/Can't reach Otari at http:\/\/127\.0\.0\.1:9 .* Fix: Start Otari/);
  });

  it("exits 2 and still revokes the key when the drill fails after minting", async () => {
    const url = await startGateway({ rejectDrillTools: true });
    const { code, text } = await drill({ gateway: url, adminKey: ADMIN });
    expect(code).toBe(2);
    expect(text).toMatch(/GET \/api\/v1\/tools failed/);
    expectCleanedUp(gw!);
  });
});

describe("budget enforcement", () => {
  it("stops when the gateway refuses on the drill key's budget, and reports what was not sent", async () => {
    const url = await startGateway({ costUsd: 0.0004 });
    const { code, stdout } = await drill({ gateway: url, adminKey: ADMIN, legs: "good:a,good:b", budget: "0.001", concurrency: "1" });
    expect(code).toBe(1);
    const served = gw!.calls.filter((c) => c.path === "/api/v1/chat/completions").length;
    expect(served).toBeLessThan(6);
    expect(stdout).toMatch(/not sent: (the gateway refused on the drill key's budget|client-side budget of \$0\.00 reached)/);
    expectCleanedUp(gw!);
  });

  it("enforces the cap client-side on an existing key", async () => {
    const url = await startGateway({ costUsd: 0.0004 });
    const { code, stdout } = await drill({ gateway: url, key: USER, useExistingKey: true, legs: "good:a,good:b", budget: "0.001", concurrency: "1" });
    expect(code).toBe(1);
    const spent = Number(/Spent \$([0-9.]+) of \$0\.00/.exec(stdout)?.[1]);
    expect(spent).toBeLessThanOrEqual(0.001);
    expect(stdout).toContain("client-side budget of $0.00 reached");
    expect(gw!.keys.size).toBe(0);
  });
});

describe("secrets", () => {
  it("never prints the user, admin or drill key, even when the gateway echoes one", async () => {
    const url = await startGateway({ echoKeyInErrors: true });
    const a = await drill({ gateway: url, adminKey: ADMIN, key: USER });
    const b = await drill({ gateway: url, adminKey: ADMIN, legs: "broken:x" });
    const child = await runChild(["fast", "--gateway", url, "--legs", "good:a,broken:b", "--samples", samples, "--trace"], { OTARI_ADMIN_KEY: ADMIN, OTARI_API_KEY: USER, FIREDRILL_DEBUG: "1" });
    const all = a.text + b.text + child.stdout + child.stderr;
    expect(gw!.mintedSecrets.length).toBeGreaterThanOrEqual(3);
    for (const secret of [ADMIN, USER, ...gw!.mintedSecrets]) expect(all).not.toContain(secret);
    expect(all).not.toContain("LEAKCANARY");
    // The echoed error is still reported, with the key replaced.
    expect(a.text).toContain("upstream rejected token [REDACTED]");
  });
});

function runChild(args: string[], env: Record<string, string>, onStdout?: (chunk: string, kill: (sig: NodeJS.Signals) => void) => void) {
  if (!existsSync(CLI)) throw new Error("dist/cli.js is missing: run npm run build (npm test does this).");
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      onStdout?.(String(d), (sig) => child.kill(sig));
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      onStdout?.(String(d), (sig) => child.kill(sig));
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.each(["SIGINT", "SIGTERM"] as const)("on %s", (sig) => {
  it("stops the drill, revokes the key and exits 2", async () => {
    const url = await startGateway({ slowMs: 20_000 });
    let sent = false;
    const waitForReplay = setInterval(() => {
      if (!sent && gw!.calls.some((c) => c.path === "/api/v1/chat/completions")) {
        sent = true;
        child.kill(sig);
      }
    }, 20);
    const child = spawn(process.execPath, [CLI, "fast", "--gateway", url, "--legs", "slow:a,slow:b", "--samples", samples], {
      env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", OTARI_ADMIN_KEY: ADMIN },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    clearInterval(waitForReplay);
    expect(sent).toBe(true);
    expect(code).toBe(2);
    expect(stderr).toContain(`Interrupted by ${sig}. The drill key was revoked.`);
    expectCleanedUp(gw!);
  }, 15_000);
});
