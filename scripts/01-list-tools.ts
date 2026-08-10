/**
 * scripts/01-list-tools.ts — CHECKPOINT 1: can we reach the servers at all?
 *
 *     npm run mcp:list
 *
 * No AI involved. If this fails, nothing later can work — and you'd otherwise
 * spend the afternoon blaming the model for a transport bug.
 *
 * Note this talks to the LOCAL /api/jar by default, so `npm run dev` must be
 * running in another terminal.
 */

import { McpConnection } from "../lib/mcp-client";
import { getServerConfigs } from "../lib/servers";

async function main() {
  const configs = getServerConfigs();

  for (const config of configs) {
    console.log("\n======================================================================");
    console.log(`  ${config.label}`);
    console.log(`  ${config.url}`);
    console.log("======================================================================\n");

    try {
      const conn = new McpConnection(config);
      const info = await conn.connect();
      console.log(`  handshake ok -> ${info.name} v${info.version}`);

      const tools = await conn.listTools();
      const excluded = new Set(config.excludeTools ?? []);

      console.log(`  ${tools.length} tool(s) offered:\n`);
      for (const tool of tools) {
        const props = Object.keys(tool.inputSchema?.properties ?? {});
        const required = new Set(tool.inputSchema?.required ?? []);
        const args = props.map((p) => (required.has(p) ? `${p}*` : p)).join(", ");
        const hidden = excluded.has(tool.name) ? "   [HIDDEN BY THIS HOST]" : "";
        console.log(`    - ${tool.name}${hidden}`);
        console.log(`        args: ${args || "(none)"}`);
      }

      if (excluded.size > 0) {
        console.log(
          `\n  ^ this host hides ${[...excluded].join(", ")} — see lib/servers.ts.`,
        );
      }
    } catch (error) {
      console.log(`  FAILED  ${(error as Error).message}`);
      console.log(
        `\n  If this is the local jar server: is \`npm run dev\` running?`,
      );
    }
  }

  console.log("");
}

main();
