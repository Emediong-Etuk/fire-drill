import { DrillError } from "../errors.js";
import { type Credential, CREDENTIAL_LABEL, errorDetail, type GatewayClient, TransportError } from "./client.js";

export interface ToolStatus {
  id: string;
  available: boolean;
  reason?: string | null;
}

export interface ToolsSummary {
  tools: ToolStatus[];
  codeExecution: boolean;
  webSearch: boolean;
  webFetch: boolean;
  /** Which credential answered: an API key reflects its workspace policy. */
  answeredBy: Credential;
}

const START_HINT = "Start Otari (docker compose up -d in your Otari checkout), or pass --gateway <url> / set OTARI_BASE_URL.";

/** GET /api/v1/health. Throws a DrillError naming the fix when the gateway is down. */
export async function checkHealth(client: GatewayClient): Promise<void> {
  let res;
  try {
    res = await client.request<{ status?: string }>("/api/v1/health", { credential: "none", timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof TransportError) {
      throw new DrillError(`Can't reach Otari at ${client.baseUrl} (${err.message.split(": ").pop()}).`, START_HINT);
    }
    throw err;
  }
  if (res.status === 404) {
    throw new DrillError(`${client.baseUrl} answered 404 for /api/v1/health, so it is not an Otari gateway.`, START_HINT);
  }
  if (!res.ok) {
    throw new DrillError(`Otari at ${client.baseUrl} is not healthy (${errorDetail(res)}).`, "Check the gateway logs: docker compose logs otari.");
  }
}

/** GET /api/v1/tools. Also proves the key authenticates. */
export async function checkTools(client: GatewayClient, credential: Credential): Promise<ToolsSummary> {
  const res = await client.request<{ data?: ToolStatus[] }>("/api/v1/tools", { credential });
  if (res.status === 401 || res.status === 403) {
    const fix =
      credential === "user"
        ? "export OTARI_API_KEY=<an API key from the Otari dashboard or POST /api/v1/keys>."
        : credential === "admin"
          ? "export OTARI_ADMIN_KEY=<the gateway's master key, OTARI_MASTER_KEY in Otari's .env>."
          : "Re-run the drill; the drill key may have expired.";
    throw new DrillError(`The ${CREDENTIAL_LABEL[credential]} was refused (${errorDetail(res)}).`, fix);
  }
  if (!res.ok) {
    throw new DrillError(`GET /api/v1/tools failed (${errorDetail(res)}).`, "Check the gateway logs: docker compose logs otari.");
  }
  const tools = Array.isArray(res.body?.data) ? res.body.data : [];
  const avail = (id: string) => tools.some((t) => t.id === id && t.available);
  return {
    tools,
    codeExecution: avail("otari_code_execution"),
    webSearch: avail("otari_web_search"),
    webFetch: avail("otari_web_fetch"),
    answeredBy: credential,
  };
}
