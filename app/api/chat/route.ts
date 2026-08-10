/**
 * ============================================================================
 *  app/api/chat/route.ts  —  start a run
 * ============================================================================
 *
 * ⚠️ THE SECURITY POINT
 * ---------------------
 * `ANTHROPIC_API_KEY` and `DATABASE_URL` are read HERE, inside a route handler
 * that runs on the server and is never sent to the browser. That is the entire
 * reason this file exists separately from the chat component. A browser cannot
 * keep a secret; a key in a client component is compiled into the bundle,
 * served to every visitor, and scraped within hours.
 *
 * ---------------------------------------------------------------------------
 *  THE PART THAT IS NEW IN PROJECT #3
 * ---------------------------------------------------------------------------
 *
 * This handler can now finish in two completely different ways:
 *
 *   1. The loop reaches `done`. Normal. Persist and close the stream.
 *
 *   2. The loop yields `approval_required`. **The request ENDS.** Not paused,
 *      not held open, not polling — the HTTP response completes and the
 *      serverless function is free to be frozen or destroyed. The agent's
 *      whole state is now a row in Postgres, and the only thing that can
 *      restart it is a fresh POST to /api/resume carrying the run id.
 *
 * Why not just hold the connection open and await a click?
 *
 * Because a serverless function has a hard execution ceiling (60 seconds here,
 * and `maxDuration` cannot save you beyond the platform's own limit). A human
 * deciding whether to let an agent delete something might take five seconds or
 * five minutes. Hold the connection and you have built a feature that works
 * perfectly in development, works for the fast clicks in staging, and times out
 * in production for exactly the decisions people thought hardest about.
 *
 * So the timeout isn't an annoyance the design works around — the timeout is
 * *why* the design is shaped this way. And it happens to be the correct shape
 * anyway: because the state is in the database and not in a live process, you
 * can close the laptop, come back tomorrow, and approve the same run.
 */

import {
  runAgentLoop,
  MODEL,
  type LoopEvent,
} from "@/lib/agent-loop";
import { buildToolbox } from "@/lib/toolbox";
import { getServerConfigs } from "@/lib/servers";
import { isDatabaseConfigured } from "@/lib/db";
import {
  appendChatMessage,
  conversationExists,
  createConversation,
  createRun,
  finishRun,
  getConversationHistory,
  pauseRunForApproval,
  recordEvent,
} from "@/lib/runs";
import type Anthropic from "@anthropic-ai/sdk";

/** Node runtime: the MCP client fetches arbitrary hosts and we talk to Postgres. */
export const runtime = "nodejs";
/** The loop makes several API calls; the default serverless timeout is too short. */
export const maxDuration = 60;

type ChatRequestBody = {
  conversationId?: string;
  message?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};

export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
    return Response.json(
      {
        error:
          "DATABASE_URL is not set. Run `npx vercel env pull .env.local` and restart the dev server.",
      },
      { status: 500 },
    );
  }

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const prompt = (body.message ?? "").trim();
  if (!prompt) {
    return Response.json({ error: "No message provided." }, { status: 400 });
  }

  const effort = body.effort ?? "medium";

  // -------------------------------------------------------------------
  // The browser sends a conversation ID and one sentence — never the
  // history. The database is the source of truth for what was said, which
  // means a refresh, a second tab, or a different device all see the same
  // conversation. (In project #2 the browser held the history, so a refresh
  // erased it.)
  // -------------------------------------------------------------------
  let conversationId = body.conversationId ?? "";
  if (!conversationId || !(await conversationExists(conversationId))) {
    conversationId = await createConversation(prompt.slice(0, 80));
  }

  const history = await getConversationHistory(conversationId);
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: prompt },
  ];

  await appendChatMessage(conversationId, "user", prompt);

  const runId = await createRun({
    conversationId,
    prompt,
    model: MODEL,
    effort,
    messages,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0;

      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        // Tell the browser the ids first, so it can drive /api/resume later
        // even if the connection drops halfway through.
        send({ type: "run_started", runId, conversationId });

        const toolbox = await buildToolbox(getServerConfigs());

        for await (const event of runAgentLoop({
          messages,
          toolbox,
          stream: true,
          effort,
          gate: true,
        })) {
          // Persist first, then forward. If the browser goes away mid-run the
          // trace is still complete and the run is still replayable.
          await recordEvent(runId, seq++, event);

          if (event.type === "approval_required") {
            await pauseRunForApproval({
              runId,
              messages: event.messages,
              pending: event.calls,
              iterations: event.iteration,
              usage: event.totalUsage,
            });
            // Strip `messages` before it reaches the browser. The client has
            // no use for the model's internal transcript, and shipping the
            // whole conversation on every pause is wasted bytes.
            send(stripState(event));
            break; // <- THE REQUEST ENDS HERE. See the header comment.
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
                conversationId,
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
      // Stops proxies buffering the response and destroying the point of
      // streaming.
      "X-Accel-Buffering": "no",
    },
  });
}

/** Remove the loop's internal state before an event goes to the browser. */
function stripState(event: LoopEvent): unknown {
  const copy = { ...event } as Record<string, unknown>;
  delete copy.messages;
  return copy;
}
