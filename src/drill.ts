import { GatewayClient } from "./gateway/client.js";
import { resolveLegs } from "./gateway/policy.js";
import { checkHealth, checkTools } from "./gateway/tools.js";
import { colors, type Output } from "./io.js";
import type { DrillOptions } from "./options.js";

/** Run one drill and return the process exit code. */
export async function runDrill(opts: DrillOptions, output: Output): Promise<number> {
  const c = colors(output.color);
  const client = new GatewayClient(opts.gateway);
  client.setKey("user", opts.key);
  client.setKey("admin", opts.adminKey);

  // 1. Preflight.
  await checkHealth(client);
  const tools = await checkTools(client, opts.key ? "user" : "admin");

  // 2. Resolve legs.
  const resolved = await resolveLegs(client, {
    alias: opts.alias,
    legsFlag: opts.legs,
    configPath: opts.config,
    workspaceId: opts.workspace,
  });

  output.err(c.dim(`Gateway ${client.baseUrl} is healthy. Code execution ${tools.codeExecution ? "available" : "unavailable"}.\n`));
  output.out(`Legs for "${opts.alias}" (from ${resolved.source}):\n`);
  for (const leg of resolved.legs) output.out(`  ${leg.index}. ${leg.role.padEnd(12)} ${leg.model}\n`);
  return 0;
}
