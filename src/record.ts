import { appendFile, open } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { normalizeGatewayUrl } from "./gateway/client.js";
import type { Output } from "./io.js";
import { sanitizeSample } from "./samples.js";

/** Request headers not forwarded: hop-by-hop, or recomputed by fetch. */
const DROP_REQUEST = new Set(["host", "connection", "content-length", "accept-encoding", "keep-alive", "transfer-encoding", "upgrade"]);
/** Response headers not copied back: fetch has already decoded the body. */
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

export interface Recorder {
  url: string;
  recorded(): number;
  close(): Promise<void>;
}

/**
 * `--record [port]`: a pass-through on 127.0.0.1 that forwards every request to
 * the gateway unchanged (with the app's own key) and appends each chat
 * completion sent to `alias` to the samples file, sanitized and redacted.
 * It never stores the Authorization header or the response.
 */
export async function startRecorder(opts: { gateway: string; alias: string; samplesPath: string; port: number; output: Output }): Promise<Recorder> {
  const gateway = normalizeGatewayUrl(opts.gateway);
  // Create the file 0600 up front; appends keep that mode.
  await (await open(opts.samplesPath, "a", 0o600)).close();
  let count = 0;
  let writing = Promise.resolve();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || DROP_REQUEST.has(k.toLowerCase())) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const target = new URL(req.url ?? "/", `${gateway}/`);
    let upstream: Response;
    try {
      upstream = await fetch(`${gateway}${target.pathname}${target.search}`, {
        method: req.method,
        headers,
        body: body.length && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
        redirect: "manual",
      });
    } catch {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: `firedrill recorder could not reach ${gateway}` }));
      return;
    }

    if (req.method === "POST" && target.pathname === "/api/v1/chat/completions" && upstream.ok) {
      try {
        const parsed = JSON.parse(body.toString("utf8")) as { model?: unknown };
        if (parsed.model === opts.alias) {
          const sample = sanitizeSample(parsed, count + 1);
          count++;
          writing = writing.then(() => appendFile(opts.samplesPath, `${JSON.stringify(sample.body)}\n`, { mode: 0o600 }));
          opts.output.err(`recorded request ${count}${sample.notes.length ? ` (${sample.notes.join("; ")})` : ""}\n`);
        }
      } catch {
        // Not a JSON chat body: forwarded, not recorded.
      }
    }

    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k)) out[k] = v;
    });
    res.writeHead(upstream.status, out);
    if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res);
    else res.end();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    recorded: () => count,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await writing;
    },
  };
}
