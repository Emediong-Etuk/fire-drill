/**
 * Secret handling.
 *
 * Two layers:
 * - `registerSecret` records exact values (the keys Fire Drill was given or
 *   minted). `scrub` replaces every occurrence, anywhere, before text is
 *   printed or written.
 * - `redact` also removes anything that looks like a secret (API keys, bearer
 *   tokens, private keys, emails), for sample content and model output.
 */

const known = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) known.add(value);
}

/** Test helper: forget registered secrets. */
export function clearSecrets(): void {
  known.clear();
}

export function scrub(text: string): string {
  let out = text;
  for (const secret of known) {
    if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

interface Pattern {
  name: string;
  re: RegExp;
}

// Order matters: specific shapes first, then the generic ones.
const PATTERNS: Pattern[] = [
  {
    name: "PRIVATE_KEY",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { name: "BEARER", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: "ANTHROPIC_KEY", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: "OPENAI_KEY", re: /\bsk-(?:proj-|svcacct-|or-v1-)?[A-Za-z0-9_-]{16,}/g },
  { name: "OTARI_KEY", re: /\b(?:otk_|tk-)[A-Za-z0-9_-]{12,}/g },
  { name: "GITHUB_TOKEN", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "AWS_KEY", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "GOOGLE_KEY", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: "SLACK_TOKEN", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "STRIPE_KEY", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    name: "SECRET_ASSIGNMENT",
    re: /\b((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
  },
  { name: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

export function redact(text: string): string {
  let out = scrub(text);
  for (const { name, re } of PATTERNS) {
    if (name === "SECRET_ASSIGNMENT") {
      out = out.replace(re, (_m, prefix: string) => `${prefix}[REDACTED_SECRET]`);
    } else if (name === "BEARER") {
      out = out.replace(re, (_m, scheme: string) => `${scheme} [REDACTED_TOKEN]`);
    } else {
      out = out.replace(re, `[REDACTED_${name}]`);
    }
  }
  return out;
}

/** Redact every string inside a JSON-like value. Returns a new value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/** Shorten text for a report line, after redaction. */
export function excerpt(text: string, max = 160): string {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
