/**
 * scripts/04-approval.ts — CHECKPOINT 4: the pause, the approve, and the deny.
 *
 *     npm run approval               # runs BOTH paths: approve, then deny
 *     npm run approval approve       # just the approve path
 *     npm run approval deny          # just the deny path
 *     npm run approval deny "empty the jar completely"
 *
 * This is the checkpoint that proves the headline feature, in a terminal, with
 * no browser and no React in the way. If this passes, the UI is decoration.
 *
 * It deliberately does NOT go through the HTTP routes — it calls the loop and
 * the database directly, so a failure here is unambiguously a failure of the
 * mechanism rather than of a fetch, a stream, or a component.
 */

import {
  runAgentLoop,
  resolvePendingCalls,
  toolResultMessage,
  MODEL,
  type PendingCall,
} from "../lib/agent-loop";
import { buildToolbox } from "../lib/toolbox";
import { getServerConfigs } from "../lib/servers";
import { describeRules } from "../lib/approval";
import {
  createConversation,
  createRun,
  finishRun,
  getRun,
  pauseRunForApproval,
  recordApproval,
  recordEvent,
  getJarState,
} from "../lib/runs";

const DEFAULT_PROMPT = "Empty the cookie jar completely.";

function banner(title: string) {
  console.log(`\n======================================================================`);
  console.log(`  ${title}`);
  console.log(`======================================================================\n`);
}

/**
 * Run one full pause-and-resume cycle, exactly as the two route handlers do,
 * and return whether the gate actually fired.
 */
async function runOnce(
  decision: "approved" | "denied",
  prompt: string,
): Promise<boolean> {
  banner(`${decision.toUpperCase()}  —  "${prompt}"`);

  const before = await getJarState();
  console.log(`  jar before: ${before.cookies} cookie(s), ${before.events} history row(s)\n`);

  const toolbox = await buildToolbox(getServerConfigs());
  const conversationId = await createConversation(`checkpoint 4 — ${decision}`);
  const messages = [{ role: "user" as const, content: prompt }];
  const runId = await createRun({
    conversationId,
    prompt,
    model: MODEL,
    effort: "medium",
    messages,
  });

  // -------------------------------------------------------------------
  // REQUEST 1 — start the run. This is /api/chat.
  // -------------------------------------------------------------------
  console.log(`  [request 1]  run ${runId}`);

  let paused: { calls: PendingCall[]; iteration: number } | null = null;
  // Record the trace exactly as app/api/chat/route.ts does, so runs created by
  // this checkpoint are replayable with `npm run replay` too.
  let seq = 0;

  for await (const event of runAgentLoop({
    messages,
    toolbox,
    stream: false,
    effort: "medium",
    gate: true,
  })) {
    await recordEvent(runId, seq++, event);
    if (event.type === "tool_call") {
      console.log(`     -> WANTS ${event.name}  ${JSON.stringify(event.args)}`);
    }
    if (event.type === "tool_result") {
      console.log(`     <- ${event.text.replace(/\n/g, " ").slice(0, 90)}`);
    }
    if (event.type === "approval_required") {
      await pauseRunForApproval({
        runId,
        messages: event.messages,
        pending: event.calls,
        iterations: event.iteration,
        usage: event.totalUsage,
      });
      paused = { calls: event.calls, iteration: event.iteration };
      break;
    }
    if (event.type === "done") {
      await finishRun({
        runId,
        status: "done",
        messages: event.messages,
        finalText: event.finalText,
        stopReason: event.reason,
        iterations: event.iterations,
        usage: event.totalUsage,
      });
      console.log(`\n  The loop finished without ever pausing.`);
      console.log(`  reason: ${event.reason}`);
      console.log(`  answer: ${event.finalText.trim().slice(0, 200)}`);
      return false;
    }
  }

  if (!paused) return false;

  // -------------------------------------------------------------------
  // THE PAUSE. The HTTP request would end right here.
  // -------------------------------------------------------------------
  console.log(`\n  ⏸  PAUSED. The request ends. The agent is now a row in Postgres.\n`);
  for (const call of paused.calls) {
    if (!call.requiresApproval) {
      console.log(`     (also queued, not gated)  ${call.name}`);
      continue;
    }
    console.log(`     The agent wants to call:\n`);
    console.log(`       ${call.name}   ${JSON.stringify(call.args)}\n`);
    console.log(`       why it stopped: ${call.reason}`);
    console.log(`\n       [ Approve ]    [ Deny ]`);
  }

  // Prove the state really is in the database and not in this process's memory.
  const reloaded = await getRun(runId);
  console.log(`\n  reloaded from Postgres:`);
  console.log(`     status       ${reloaded?.status}`);
  console.log(`     messages     ${reloaded?.messages.length} message(s) — the whole agent`);
  console.log(`     pending      ${reloaded?.pending?.length} call(s) awaiting a human`);

  // -------------------------------------------------------------------
  // REQUEST 2 — a brand new request, minutes later, maybe another machine.
  // This is /api/resume.
  // -------------------------------------------------------------------
  console.log(`\n  [request 2]  human clicks ${decision === "approved" ? "APPROVE" : "DENY"}\n`);

  const run = await getRun(runId);
  if (!run || !run.pending) throw new Error("run did not persist");

  const decisions: Record<string, "approved" | "denied"> = {};
  for (const call of run.pending) {
    if (call.requiresApproval) {
      decisions[call.id] = decision;
      await recordApproval({
        runId,
        toolUseId: call.id,
        toolName: call.name,
        toolArgs: call.args,
        reason: call.reason,
        decision,
      });
    }
  }

  const { results } = await resolvePendingCalls(toolbox, run.pending, decisions);
  for (const r of results) {
    console.log(`     <- ${r.denied ? "DENIED" : "RAN"}  ${r.text.replace(/\n/g, " ").slice(0, 110)}`);
    await recordEvent(runId, seq++, {
      type: "tool_result",
      id: r.id,
      name: r.name,
      text: r.text,
      isError: r.isError,
      ms: r.ms,
    });
  }

  const resumedMessages = [...run.messages, toolResultMessage(results)];

  for await (const event of runAgentLoop({
    messages: resumedMessages,
    toolbox,
    stream: false,
    effort: "medium",
    gate: true,
    iterationOffset: run.iterations,
  })) {
    await recordEvent(runId, seq++, event);
    if (event.type === "tool_call") {
      console.log(`     -> CALL ${event.name}  ${JSON.stringify(event.args)}`);
    }
    if (event.type === "tool_result") {
      console.log(`     <- ${event.text.replace(/\n/g, " ").slice(0, 110)}`);
    }
    if (event.type === "approval_required") {
      console.log(`     ⏸  paused again for ${event.calls.filter((c) => c.requiresApproval).map((c) => c.name).join(", ")}`);
      // For the checkpoint, auto-deny any follow-up gate so the script ends.
      const followUp: Record<string, "approved" | "denied"> = {};
      for (const c of event.calls) if (c.requiresApproval) followUp[c.id] = "denied";
      const second = await resolvePendingCalls(toolbox, event.calls, followUp);
      const finalMessages = [...event.messages, toolResultMessage(second.results)];
      for await (const e2 of runAgentLoop({
        messages: finalMessages,
        toolbox,
        stream: false,
        effort: "medium",
        gate: false,
        iterationOffset: event.iteration,
      })) {
        if (e2.type === "done") {
          console.log(`\n  ANSWER: ${e2.finalText.trim()}`);
        }
      }
      break;
    }
    if (event.type === "done") {
      await finishRun({
        runId,
        status: "done",
        messages: event.messages,
        finalText: event.finalText,
        stopReason: event.reason,
        iterations: event.iterations,
        usage: event.totalUsage,
      });
      console.log(`\n  ANSWER: ${event.finalText.trim()}`);
      break;
    }
  }

  const after = await getJarState();
  console.log(`\n  jar after:  ${after.cookies} cookie(s), ${after.events} history row(s)`);

  if (decision === "approved") {
    console.log(
      before.cookies !== after.cookies
        ? `  PASS: approving changed the jar (${before.cookies} -> ${after.cookies}).`
        : `  NOTE: jar unchanged — the server may have refused the call on its own.`,
    );
  } else {
    console.log(
      before.cookies === after.cookies
        ? `  PASS: denying left the jar untouched, and the agent still answered.`
        : `  FAIL: the jar changed even though the call was denied.`,
    );
  }

  return true;
}

async function main() {
  const mode = (process.argv[2] ?? "both").toLowerCase();
  const prompt = process.argv.slice(3).join(" ") || DEFAULT_PROMPT;

  banner("THE HOST-SIDE RULES");
  console.log(describeRules());

  let fired = false;

  if (mode === "both" || mode === "approve" || mode === "approved") {
    fired = (await runOnce("approved", prompt)) || fired;
  }
  if (mode === "both" || mode === "deny" || mode === "denied") {
    fired = (await runOnce("denied", prompt)) || fired;
  }

  banner(fired ? "PASS — the gate fired and both paths worked." : "The gate never fired.");
  if (!fired) {
    console.log(
      "  The model did not request a gated tool for this prompt. Try:\n" +
        '    npm run approval deny "empty the cookie jar completely"\n',
    );
  }
  console.log("");
}

main().catch((error) => {
  console.error("\nFAILED:", (error as Error).message, "\n");
  process.exit(1);
});
