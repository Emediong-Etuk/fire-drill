import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Output } from "../src/io.js";
import { startRecorder } from "../src/record.js";
import { FakeGateway } from "./support/fake-gateway.js";

const USER = "tk-recorder-user-key-0123456";
let gw: FakeGateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

describe("--record", () => {
  it("forwards requests unchanged and records only chat completions sent to the alias, redacted, 0600", async () => {
    gw = new FakeGateway({ adminKey: "admin-unused-000000", userKey: USER });
    const gateway = await gw.start();
    const dir = await mkdtemp(join(tmpdir(), "firedrill-rec-"));
    const samplesPath = join(dir, "recorded.jsonl");
    let log = "";
    const output: Output = { out: (t) => (log += t), err: (t) => (log += t), color: false };
    const rec = await startRecorder({ gateway, alias: "good:chat", samplesPath, port: 0, output });

    const send = (model: string, content: string) =>
      fetch(`${rec.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${USER}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, user: "u1", stream: false, messages: [{ role: "user", content }] }),
      });
    const res = await send("good:chat", "Email me at jo@example.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("otari-model")).toBe("chat");
    expect(((await res.json()) as { choices: unknown[] }).choices).toHaveLength(1);
    expect((await send("good:other", "not recorded")).status).toBe(200);
    expect((await fetch(`${rec.url}/api/v1/tools`, { headers: { Authorization: `Bearer ${USER}` } })).status).toBe(200);
    await rec.close();

    // The app's own key reached the gateway; the recorder added nothing.
    expect(gw.calls.filter((c) => c.path === "/api/v1/chat/completions").map((c) => c.auth)).toEqual(["user", "user"]);
    const lines = (await readFile(samplesPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ messages: [{ role: "user", content: "Email me at [REDACTED_EMAIL]" }] });
    expect((await stat(samplesPath)).mode & 0o777).toBe(0o600);
    expect(rec.recorded()).toBe(1);
    expect(log).not.toContain(USER);
  });
});
