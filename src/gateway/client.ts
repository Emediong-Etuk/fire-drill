import { registerSecret, scrub } from "../redact.js";

/** Which credential signs a call. Shown in --trace; the value never is. */
export type Credential = "none" | "user" | "admin" | "drill";

export const CREDENTIAL_LABEL: Record<Credential, string> = {
  none: "no key",
  user: "user key",
  admin: "admin key",
  drill: "drill key",
};

export interface TraceEvent {
  step: number;
  method: string;
  path: string;
  status: number | "ERR";
  latencyMs: number;
  costUsd: number | null;
  credential: Credential;
  note?: string;
}

export interface GatewayResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  body: T;
  text: string;
  latencyMs: number;
}

export interface RequestOptions {
  method?: string;
  credential: Credential;
  body?: unknown;
  query?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra label for the trace line, such as the leg number. */
  note?: string;
}

/** A failure to reach the gateway at all (DNS, refused, timeout). */
export class TransportError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut: boolean) {
    super(scrub(message));
    this.name = "TransportError";
    this.timedOut = timedOut;
  }
}

/** Normalize a gateway URL so callers may pass `http://host`, `.../api` or `.../api/v1`. */
export function normalizeGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`"${raw}" must start with http:// or https://`);
  }
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/api\/v1$/, "").replace(/\/api$/, "");
  return `${url.origin}${path}`;
}

/** Read `usage.cost_usd` (a decimal string) from a completion body. */
export function costFromBody(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: { cost_usd?: unknown } }).usage;
  const raw = usage?.cost_usd;
  if (typeof raw === "string" || typeof raw === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class GatewayClient {
  readonly baseUrl: string;
  private readonly keys: Partial<Record<Credential, string>> = {};
  private step = 0;
  private readonly listeners: Array<(e: TraceEvent) => void> = [];

  constructor(baseUrl: string) {
    this.baseUrl = normalizeGatewayUrl(baseUrl);
  }

  setKey(credential: Exclude<Credential, "none">, key: string | undefined): void {
    if (!key) {
      delete this.keys[credential];
      return;
    }
    registerSecret(key);
    this.keys[credential] = key;
  }

  hasKey(credential: Credential): boolean {
    return credential === "none" || Boolean(this.keys[credential]);
  }

  onTrace(listener: (e: TraceEvent) => void): void {
    this.listeners.push(listener);
  }

  async request<T = unknown>(path: string, opts: RequestOptions): Promise<GatewayResponse<T>> {
    const method = opts.method ?? "GET";
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.credential !== "none") {
      const key = this.keys[opts.credential];
      if (!key) throw new Error(`No ${CREDENTIAL_LABEL[opts.credential]} is configured for ${method} ${path}`);
      headers.Authorization = `Bearer ${key}`;
    }
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }

    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const started = performance.now();
    let res: Response;
    try {
      // redirect: "error" keeps the key from following a redirect to another host.
      res = await fetch(url, { method, headers, body: payload, signal, redirect: "error" });
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      this.emit({ method, path: url.pathname, status: "ERR", latencyMs, costUsd: null, credential: opts.credential, note: opts.note });
      const timedOut = timeout.aborted;
      const reason = timedOut
        ? `timed out after ${opts.timeoutMs ?? 30_000} ms`
        : err instanceof Error
          ? (err.cause instanceof Error ? err.cause.message : err.message)
          : String(err);
      throw new TransportError(`${method} ${url.origin}${url.pathname} failed: ${reason}`, timedOut);
    }
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - started);
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    this.emit({
      method,
      path: url.pathname,
      status: res.status,
      latencyMs,
      costUsd: costFromBody(body),
      credential: opts.credential,
      note: opts.note,
    });
    return { status: res.status, ok: res.ok, headers: res.headers, body: body as T, text, latencyMs };
  }

  /** Steps are numbered in the order calls finish, so the trace reads top to bottom. */
  private emit(e: Omit<TraceEvent, "step">): void {
    const event = { step: ++this.step, ...e };
    for (const l of this.listeners) l(event);
  }
}

/** The `detail` an Otari error body carries, as one line with secrets removed. */
export function errorDetail(res: GatewayResponse): string {
  const body = res.body as { detail?: unknown; error?: { message?: unknown; code?: unknown } } | string | null;
  let detail = "";
  if (body && typeof body === "object") {
    if (typeof body.detail === "string") detail = body.detail;
    else if (body.detail !== undefined) detail = JSON.stringify(body.detail);
    else if (body.error && typeof body.error.message === "string") detail = body.error.message;
  } else if (typeof body === "string") {
    detail = body;
  }
  detail = scrub(detail).replace(/\s+/g, " ").trim();
  if (detail.length > 200) detail = `${detail.slice(0, 199)}…`;
  return detail ? `${res.status} ${detail}` : `${res.status}`;
}

/**
 * Otari's stable error code: the `Otari-Error-Code` header, or `code` beside
 * `detail` in the body (docs/api-reference.md, "Error codes").
 */
export function errorCode(res: GatewayResponse): string | undefined {
  const header = res.headers.get("otari-error-code");
  if (header) return header;
  const body = res.body as { error?: { code?: unknown }; code?: unknown } | null;
  if (!body || typeof body !== "object") return undefined;
  for (const candidate of [body.code, body.error?.code]) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}
