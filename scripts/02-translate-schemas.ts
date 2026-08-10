/**
 * scripts/02-translate-schemas.ts — CHECKPOINT 2: do the schemas convert?
 *
 *     npm run mcp:translate
 *
 * Still no AI. Proves the MCP -> Claude tool-definition translation produces
 * something the API will accept, reports name collisions across servers, and
 * — new in this project — shows which tools the approval gate will stop.
 */

import { buildToolbox } from "../lib/toolbox";
import { getServerConfigs } from "../lib/servers";
import { toClaudeTools, findCollisions } from "../lib/tool-translation";
import { classifyCall, describeRules } from "../lib/approval";

async function main() {
  const toolbox = await buildToolbox(getServerConfigs());

  console.log("\n======================================================================");
  console.log("  SERVERS");
  console.log("======================================================================\n");
  for (const server of toolbox.servers) {
    const status = server.ok ? `ok, ${server.toolCount} tools` : `FAILED: ${server.error}`;
    console.log(`  ${server.ok ? "✓" : "✗"} ${server.label.padEnd(36)} ${status}`);
    if (server.excluded?.length) {
      console.log(`      hidden by this host: ${server.excluded.join(", ")}`);
    }
  }

  const claudeTools = toClaudeTools(toolbox.tools);

  console.log("\n======================================================================");
  console.log("  TRANSLATED TOOLS");
  console.log("======================================================================\n");
  for (const tool of claudeTools) {
    console.log(`  ${tool.name}`);
  }

  console.log("\n----------------------------------------------------------------------");
  console.log("  NAME COLLISIONS ACROSS SERVERS");
  console.log("----------------------------------------------------------------------\n");
  const collisions = findCollisions(toolbox.tools);
  if (collisions.size === 0) {
    console.log("  none");
  }
  for (const [name, list] of collisions) {
    console.log(`  "${name}" is offered by ${list.length} servers:`);
    for (const entry of list) {
      console.log(`      ${entry.serverLabel.padEnd(36)} -> ${entry.namespacedName}`);
    }
    console.log("     ^ without namespacing, one of these silently shadows the other.");
  }

  console.log("\n----------------------------------------------------------------------");
  console.log("  WHAT THE APPROVAL GATE WILL STOP");
  console.log("----------------------------------------------------------------------\n");
  console.log(describeRules());
  console.log("");
  for (const tool of claudeTools) {
    // Classify with empty args — enough to show tool-level rules. Rules that
    // depend on arguments are listed in describeRules() above.
    const verdict = classifyCall(tool.name, {});
    const mark = verdict.decision === "ask" ? "⏸  ASK " : "▶  allow";
    console.log(`  ${mark}  ${tool.name}`);
  }

  console.log("\n----------------------------------------------------------------------");
  console.log("  SANITY CHECK");
  console.log("----------------------------------------------------------------------\n");
  const bad = claudeTools.filter(
    (t) => !t.input_schema || (t.input_schema as { type?: string }).type !== "object",
  );
  if (bad.length === 0) {
    console.log(`  All ${claudeTools.length} tools have a valid object input_schema.`);
  } else {
    console.log(`  ${bad.length} tool(s) have a bad input_schema:`);
    for (const t of bad) console.log(`      ${t.name}`);
  }

  console.log("\n----------------------------------------------------------------------");
  console.log("  ONE FULL TOOL DEFINITION, VERBATIM");
  console.log("----------------------------------------------------------------------\n");
  console.log(JSON.stringify(claudeTools[0], null, 2));
  console.log("");
}

main();
