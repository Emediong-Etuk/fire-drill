import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCli, runInit } from "../src/app.js";
import type { Output } from "../src/io.js";
import type { RawFlags } from "../src/options.js";
import { clearSecrets } from "../src/redact.js";
import { lastErrorLine, pythonBlock } from "../src/sandbox.js";
import { FakeGateway, type FakeGatewayOptions } from "./support/fake-gateway.js";

const ADMIN = "admin-key-stretch-0123456";
let dir: string;
let samples: string;
let gw: FakeGateway | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "firedrill-stretch-"));
  samples = join(dir, "samples.jsonl");
  await runInit(samples, false, { out: () => {}, err: () => {}, color: false });
});
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  clearSecrets();
});

async function drill(flags: RawFlags, opts: Partial<FakeGatewayOptions> = {}) {
  gw = new FakeGateway({ adminKey: ADMIN, userKey: "tk-unused-user-key-000000", ...opts });
  const url = await gw.start();
  let out = "";
  let err = "";
  const output: Output = { out: (t) => (out += t), err: (t) => (err += t), color: false };
  const code = await runCli("fast", { gateway: url, adminKey: ADMIN, samples, ...flags }, {}, output);
  return { code, out, err };
}

describe("--run-code", () => {
  it("runs each answer's Python block in the gateway sandbox and fails the leg whose code raises", async () => {
    const { code, out } = await drill({ legs: "good:a,badcode:b", runCode: true });
    expect(code).toBe(1);
    const runs = gw!.calls.filter((c) => c.path === "/api/v1/code/execute");
    expect(runs).toHaveLength(2); // one text sample per leg has a Python block
    expect(new Set(runs.map((c) => c.auth))).toEqual(new Set(["drill"]));
    expect((runs.find((c) => String((c.body as { code: string }).code).includes("undefined_name"))?.body as { timeout_seconds: number }).timeout_seconds).toBe(10);
    expect(out).toMatch(/2 {2}failover 1 {2}badcode:b\s+2\/3 67%\s+code 1/);
    expect(out).toContain("leg 2  sample 3  code  Python block exits 1: NameError: name 'undefined_name' is not defined");
    expect(out).toContain("Leg 2 fails 1/3 sandbox runs. Remove it or replace it with a model that passes.");
  });

  it("is never sent without the flag", async () => {
    await drill({ legs: "good:a,badcode:b" });
    expect(gw!.calls.some((c) => c.path === "/api/v1/code/execute")).toBe(false);
  });
});

describe("--json and --out", () => {
  it("prints the report as JSON on stdout and writes a 0600 copy", async () => {
    const outFile = join(dir, "report.json");
    const { code, out, err } = await drill({ legs: "good:a,badjson:b", json: true, out: outFile });
    expect(code).toBe(1);
    const report = JSON.parse(out);
    expect(report.version).toBe(1);
    expect(report.legs.map((l: { model: string; passed: number }) => [l.model, l.passed])).toEqual([["good:a", 3], ["badjson:b", 1]]);
    expect(report.failures[0]).toMatchObject({ leg: 2, sample: 1, contract: "json_schema", message: "output is not valid JSON" });
    expect(report.drillKey.revoked).toBe(true);
    expect(report.exitCode).toBe(1);
    expect(err).toContain('Drilling "fast"');
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(report);
    expect((await stat(outFile)).mode & 0o777).toBe(0o600);
  });
});

describe("--lock-down", () => {
  it("switches web access off for the drill and restores the default afterwards", async () => {
    const { code, out } = await drill({ legs: "good:a", lockDown: true }, { webSearchEnabled: true });
    expect(code).toBe(0);
    const web = gw!.calls.filter((c) => c.path.endsWith("/web-search")).map((c) => `${c.method}${c.method === "PUT" ? ` enabled=${(c.body as { enabled: boolean }).enabled}` : ""}`);
    expect(web).toEqual(["GET", "PUT enabled=false", "DELETE"]);
    // The replays ran while web access was off.
    const firstReplay = gw!.calls.findIndex((c) => c.path === "/api/v1/chat/completions");
    const put = gw!.calls.findIndex((c) => c.method === "PUT");
    const restore = gw!.calls.findIndex((c) => c.method === "DELETE" && c.path.endsWith("/web-search"));
    expect(put).toBeLessThan(firstReplay);
    expect(restore).toBeGreaterThan(firstReplay);
    expect(gw!.webSearch.enabled).toBe(true);
    expect(out).toContain("switched off for the drill (--lock-down) and switched back on afterwards");
  });

  it("changes nothing when web access is already off", async () => {
    await drill({ legs: "good:a", lockDown: true }, { webSearchEnabled: false });
    expect(gw!.calls.filter((c) => c.path.endsWith("/web-search")).map((c) => c.method)).toEqual(["GET"]);
  });

  it("is refused without the admin key", async () => {
    const { code, err } = await drill({ legs: "good:a", lockDown: true, adminKey: undefined, key: "tk-unused-user-key-000000", useExistingKey: true });
    expect(code).toBe(2);
    expect(err).toContain("--lock-down changes the workspace web policy, which needs the admin key.");
  });
});

describe("sandbox helpers", () => {
  it("finds the first fenced Python block only", () => {
    expect(pythonBlock("a\n```python\nprint(1)\n```\n```python\nprint(2)\n```")).toBe("print(1)\n");
    expect(pythonBlock("```js\nconsole.log(1)\n```")).toBeUndefined();
    expect(pythonBlock("```py\n   \n```")).toBeUndefined();
  });
  it("reads the last line of a traceback", () => {
    expect(lastErrorLine("Traceback (most recent call last):\n  File x\nValueError: bad\n")).toBe("ValueError: bad");
  });
});
