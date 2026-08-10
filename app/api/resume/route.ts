/**
 * ============================================================================
 *  app/api/resume/route.ts  —  the other side of the pause
 * ============================================================================
 *
 * A completely separate HTTP request from the one that started the run. It
 * might land on a different machine. It might arrive five minutes later, or
 * tomorrow. Nothing is alive in between — there is no held connection, no
 * background job, no in-memory queue.
 *
 * The reconstruction is four lines:
 *
 *     const run = await getRun(runId);           // the whole agent, from Postgres
 *     const results = await resolve(run.pending, decisions);
 *     const messages = [...run.messages, toolResultMessage(results)];
 *     runAgentLoop({ messages, ... });           // ...and it just carries on
 *
 * That's it. That is the entire pause-and-resume mechanism. If it feels
 * anticlimactic, that's the point: the agent's state was never anywhere except
 * the `messages` array, so persisting an agent is persisting an array.
 *
 * ---------------------------------------------------------------------------
 *  THINGS THAT WOULD BREAK, AND ARE HANDLED
 * ---------------------------------------------------------------------------
 *
 *  - Double-click on Approve. Two resumes for one pause would run the tool
 *    twice — for `smash_jar` that's harmless, for `charge_card` it is not. The
 *    status check below makes the second one a 409 instead.
 *  - A decision that never arrives for a gated call: treated as DENIED, not as
 *    approved. Fail closed.
 *  - The iteration counter: passed through as `iterationOffset` so the
 *    ten-iteration seatbelt spans the whole run instead of resetting on every
 *    approval.
 */

import {
  runAgentLoop,
  resolvePendingCalls,
  toolResultMessage,
  type LoopEvent,
} from "@/lib/agent-loop";
import { buildToolbox } from "@/lib/toolbox";
import { getServerConfigs } from "@/lib/servers";
import { isDatabaseConfigured } from "@/lib/db";
import {
  appendChatMessage,
  finishRun,
  getRun,
  nextSeq,
  pauseRunForApproval,
  recordApproval,
  recordEvent,
} from "@/lib/runs";

export const runtime = "nodejs";
export const maxDuration = 60;

type ResumeBody = {
  runId?: string;
  /** Map of tool_use_id -> the human's decision. */
  decisions?: Record<string, "approved" | "denied">;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};

export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "DATABASE_URL is not set." }, { status: 500 });
  }

  let body: ResumeBody;
  try {
    body = (await request.json()) as ResumeBody;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const runId = body.runId ?? "";
  if (!runId) {
    return Response.json({ error: "runId is required." }, { status: 400 });
  }

  const run = await getRun(runId);
  if (!run) {
    return Response.json({ error: `No run with id ${runId}.` }, { status: 404 });
  }

  // Idempotency guard. Without this, a double-clicked Approve button runs the
  // gated tool twice.
  if (run.status !== "awaiting_approval") {
    return Response.json(
      {
        error: `Run ${runId} is "${run.status}", not awaiting approval. It has already been resumed.`,
      },
      { status: 409 },
    );
  }

  const pending = run.pending ?? [];
  const decisions = body.decisions ?? {};

  // Write the audit log BEFORE running anything. If the tool then explodes,
  // you still know who said yes.
  for (const call of pending) {
    if (!call.requiresApproval) continue;
    await recordApproval({
      runId,
      toolUseId: call.id,
      toolName: call.name,
      toolArgs: call.args,
      reason: call.reason,
      decision: decisions[call.id] === "approved" ? "approved" : "denied",
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Continue the run's trace where the first request left off, so replay
      // reads one coherent story instead of two disjoint halves.
      let seq = await nextSeq(runId);

      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        send({ type: "run_resumed", runId, conversationId: run.conversation_id });

        const toolbox = await buildToolbox(getServerConfigs());

        // 1. Turn human decisions into tool results. Approved calls run now;
        //    denied ones become a readable refusal the model can act on.
        const { results } = await resolvePendingCalls(toolbox, pending, decisions);

        for (const r of results) {
          const event: LoopEvent = {
            type: "tool_result",
            id: r.id,
            name: r.name,
            text: r.text,
            isError: r.isError,
            ms: r.ms,
          };
          await recordEvent(runId, seq++, event);
          send({ ...event, denied: r.denied });
        }

        // 2. Rebuild the conversation. `run.messages` already ends with the
        //    assistant turn containing these tool_use blocks, so appending one
        //    user message of tool_results makes it a valid conversation again.
        const messages = [...run.messages, toolResultMessage(results)];

        // 3. ...and the loop simply continues. It never learns it was paused.
        for await (const event of runAgentLoop({
          messages,
          toolbox,
          stream: true,
          effort: body.effort ?? (run.effort as never) ?? "medium",
          gate: true,
          iterationOffset: run.iterations,
        })) {
          await recordEvent(runId, seq++, event);

          // A run can pause more than once — approve one destructive call and
          // the model may immediately ask for another. Same code path.
          if (event.type === "approval_required") {
            await pauseRunForApproval({
              runId,
              messages: event.messages,
              pending: event.calls,
              iterations: event.iteration,
              usage: event.totalUsage,
            });
            send(stripState(event));
            break;
          }

          if (event.type === "done") {
            await finishRun({
              runId,
              status: "done",
              messages: event.messages,
              finalText: event.finalText,
              stopReason: event.reason,
              detail: event.detail,
              iterations: event.iterations,
              usage: event.totalUsage,
            });
            if (event.finalText.trim()) {
              await appendChatMessage(
                run.conversation_id,
                "assistant",
                event.finalText.trim(),
                runId,
              );
            }
            send(stripState(event));
            break;
          }

          if (event.type === "error") {
            await finishRun({ runId, status: "error", detail: event.message });
          }

          send(event);
        }
      } catch (error) {
        const message = (error as Error).message;
        await finishRun({ runId, status: "error", detail: message }).catch(() => {});
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function stripState(event: LoopEvent): unknown {
  const copy = { ...event } as Record<string, unknown>;
  delete copy.messages;
  return copy;
}
