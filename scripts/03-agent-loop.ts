/**
 * scripts/03-agent-loop.ts — CHECKPOINT 3: does the loop chain its own output?
 *
 *     npm run agent
 *     npm run agent "how many cookies are in the jar?"
 *
 * The gate is OFF here on purpose. This script answers project #2's question —
 * "does the loop work?" — and nothing else. Checkpoint 4 turns the gate on.
 * Proving one layer at a time is why you're never more than one layer away
 * from a bug.
 */

import { runAgentLoop, MODEL } from "../lib/agent-loop";
import { buildToolbox } from "../lib/toolbox";
import { getServerConfigs } from "../lib/servers";

const DEMO = "Roll 3d20, then put that many cookies in the jar.";

async function main() {
  const prompt = process.argv.slice(2).join(" ") || DEMO;

  console.log(`\n  model:  ${MODEL}`);
  console.log(`  prompt: ${prompt}`);
  console.log(`  gate:   OFF (checkpoint 4 turns it on)\n`);

  const toolbox = await buildToolbox(getServerConfigs());
  for (const s of toolbox.servers) {
    console.log(`  ${s.ok ? "✓" : "✗"} ${s.label} — ${s.ok ? `${s.toolCount} tools` : s.error}`);
  }

  let toolCalls = 0;
  let iterationsWithCalls = 0;
  let lastIterationHadCall = false;

  for await (const event of runAgentLoop({
    messages: [{ role: "user", content: prompt }],
    toolbox,
    stream: false,
    effort: "medium",
    gate: false,
  })) {
    switch (event.type) {
      case "iteration_start":
        if (lastIterationHadCall) iterationsWithCalls += 1;
        lastIterationHadCall = false;
        console.log(
          `\n--- iteration ${event.iteration} --------------------------------------------------`,
        );
        break;
      case "text":
        if (event.text.trim()) console.log(`  ${event.text.trim()}`);
        break;
      case "tool_call":
        toolCalls += 1;
        lastIterationHadCall = true;
        console.log(`  -> CALL ${event.name}  ${JSON.stringify(event.args)}`);
        break;
      case "tool_result":
        console.log(
          `  <- RESULT ${event.text.replace(/\n/g, " ").slice(0, 100)}  (${event.ms}ms)`,
        );
        break;
      case "done":
        if (lastIterationHadCall) iterationsWithCalls += 1;
        console.log(`\ndone — ${event.reason}`);
        console.log(
          `  ${event.iterations} iteration(s), ${toolCalls} tool call(s), ` +
            `${event.totalUsage.inputTokens} uncached in / ${event.totalUsage.outputTokens} out`,
        );
        console.log(
          `  cache: ${event.totalUsage.cacheWriteTokens} written, ` +
            `${event.totalUsage.cacheReadTokens} read at ~10% price`,
        );
        if (event.detail) console.log(`  ${event.detail}`);
        console.log(
          iterationsWithCalls >= 2
            ? `\n  PASS: tools were called across ${iterationsWithCalls} separate iterations — the loop chained its own output.`
            : `\n  (only ${iterationsWithCalls} iteration(s) used tools — try the default prompt to see chaining)`,
        );
        break;
      case "error":
        console.log(`\nERROR: ${event.message}`);
        break;
    }
  }
  console.log("");
}

main();
