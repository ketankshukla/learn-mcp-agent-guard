/**
 * scripts/06-replay.ts — PHASE 4: the rewind button, in a terminal.
 *
 *     npm run replay              # list recent runs
 *     npm run replay <run-id>     # replay one, step by step
 *     npm run replay latest       # replay the most recent run
 *
 * There is almost nothing here, and that's the point. Because the loop already
 * yielded a stream of small JSON events, and app/api/chat/route.ts wrote each
 * one to `trace_events` before forwarding it, "replay a run from last Tuesday"
 * is a `select ... order by seq`.
 *
 * You do not re-run the agent. You do not call the model. Nothing is charged
 * and nothing is re-executed — you are reading back what actually happened,
 * including the failures and the calls a human refused.
 */

import { getTrace, listApprovals, listRuns, getRun } from "../lib/runs";

function fmt(ts: string) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

async function list() {
  const runs = await listRuns(15);
  if (runs.length === 0) {
    console.log("\n  No runs recorded yet. Try `npm run approval` first.\n");
    return;
  }
  console.log("\n======================================================================");
  console.log("  RECENT RUNS");
  console.log("======================================================================\n");
  for (const r of runs) {
    const status =
      r.status === "done"
        ? "done"
        : r.status === "awaiting_approval"
          ? "PAUSED"
          : r.status;
    console.log(`  ${r.id}`);
    console.log(
      `      ${fmt(r.created_at)}  ${status.padEnd(8)} ${String(r.event_count).padStart(3)} events  ` +
        `${r.approval_count} approval(s)  ${r.iterations} iteration(s)`,
    );
    console.log(`      "${r.prompt}"`);
  }
  console.log(`\n  Replay one:  npm run replay <run-id>\n`);
}

async function replay(runId: string) {
  const run = await getRun(runId);
  if (!run) {
    console.log(`\n  No run with id ${runId}\n`);
    return;
  }

  const trace = await getTrace(runId);
  const approvals = await listApprovals(runId);

  console.log("\n======================================================================");
  console.log(`  REPLAY  ${runId}`);
  console.log("======================================================================\n");
  console.log(`  when:     ${fmt(run.created_at)}`);
  console.log(`  prompt:   "${run.prompt}"`);
  console.log(`  model:    ${run.model}  (effort: ${run.effort})`);
  console.log(`  status:   ${run.status}`);
  console.log(`  tokens:   ${run.input_tokens} in / ${run.output_tokens} out, ` +
    `${run.cache_read_tokens} read from cache`);
  console.log(`  events:   ${trace.length}\n`);
  console.log("----------------------------------------------------------------------\n");

  for (const { seq, event } of trace) {
    const n = String(seq).padStart(3);
    switch (event.type) {
      case "servers":
        console.log(`  ${n}  connected to ${event.servers.length} server(s), ${event.toolCount} tools`);
        break;
      case "iteration_start":
        console.log(`\n  ${n}  --- iteration ${event.iteration} ---`);
        break;
      case "thinking":
        break; // too noisy for a replay summary
      case "text":
        if (event.text.trim()) process.stdout.write(event.text);
        break;
      case "tool_call":
        console.log(`\n  ${n}  -> CALL  ${event.name}  ${JSON.stringify(event.args)}`);
        break;
      case "tool_result":
        console.log(
          `  ${n}  <- ${event.isError ? "ERROR " : "RESULT"}  ${event.text.replace(/\n/g, " ").slice(0, 90)}  (${event.ms}ms)`,
        );
        break;
      case "usage":
        console.log(
          `  ${n}     tokens: ${event.iterationUsage.inputTokens} in / ` +
            `${event.iterationUsage.outputTokens} out` +
            (event.iterationUsage.cacheReadTokens
              ? `, ${event.iterationUsage.cacheReadTokens} from cache`
              : ""),
        );
        break;
      case "approval_required": {
        console.log(`\n  ${n}  ⏸  PAUSED FOR A HUMAN`);
        for (const call of event.calls) {
          const tag = call.requiresApproval ? "GATED" : "queued";
          console.log(`         [${tag}] ${call.name}  ${JSON.stringify(call.args)}`);
          if (call.reason) console.log(`                 ${call.reason}`);
        }
        break;
      }
      case "done":
        console.log(`\n  ${n}  done — ${event.reason}` + (event.detail ? ` (${event.detail})` : ""));
        break;
      case "error":
        console.log(`\n  ${n}  ERROR  ${event.message}`);
        break;
    }
  }

  if (approvals.length > 0) {
    console.log("\n\n----------------------------------------------------------------------");
    console.log("  WHO DECIDED WHAT");
    console.log("----------------------------------------------------------------------\n");
    for (const a of approvals) {
      console.log(
        `  ${fmt(a.decided_at)}  ${a.decision.toUpperCase().padEnd(9)} ${a.tool_name}  ${JSON.stringify(a.args)}`,
      );
    }
  }

  if (run.final_text) {
    console.log("\n----------------------------------------------------------------------");
    console.log("  FINAL ANSWER");
    console.log("----------------------------------------------------------------------\n");
    console.log(`  ${run.final_text.replace(/\n/g, "\n  ")}`);
  }
  console.log("");
}

async function main() {
  const arg = process.argv[2];
  if (!arg) return list();
  if (arg === "latest") {
    const runs = await listRuns(1);
    if (runs.length === 0) return list();
    return replay(runs[0].id);
  }
  return replay(arg);
}

main().catch((error) => {
  console.error("\nFAILED:", (error as Error).message, "\n");
  process.exit(1);
});
