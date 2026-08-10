/**
 * ============================================================================
 *  app/api/runs/route.ts  —  PHASE 4: the rewind button
 * ============================================================================
 *
 *     GET /api/runs            -> the most recent runs
 *     GET /api/runs?id=<uuid>  -> one run's full trace + approval log
 *
 * This file is short, and that is the entire point of phase 4.
 *
 * Replay looks like an ambitious feature — "reconstruct any past run, step by
 * step" — and it costs almost nothing here, because the decision that made it
 * cheap was taken two projects ago: the loop yields a stream of small JSON
 * events instead of returning one lump at the end.
 *
 * Once each of those events is a row, replay is `order by seq`. No model call,
 * no re-execution, nothing charged. You are reading back what actually
 * happened, including the tools that errored and the ones a human refused.
 *
 * That's worth noticing as a design lesson: the observability feature was
 * already paid for by an architectural choice that was made for a different
 * reason entirely.
 */

import { isDatabaseConfigured } from "@/lib/db";
import { getRun, getTrace, listApprovals, listRuns } from "@/lib/runs";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "DATABASE_URL is not set." }, { status: 500 });
  }

  const id = new URL(request.url).searchParams.get("id");

  if (!id) {
    return Response.json({ runs: await listRuns(20) });
  }

  const run = await getRun(id);
  if (!run) {
    return Response.json({ error: `No run with id ${id}.` }, { status: 404 });
  }

  const [trace, approvals] = await Promise.all([getTrace(id), listApprovals(id)]);

  return Response.json({
    run: {
      id: run.id,
      status: run.status,
      prompt: run.prompt,
      model: run.model,
      effort: run.effort,
      finalText: run.final_text,
      stopReason: run.stop_reason,
      iterations: run.iterations,
      inputTokens: run.input_tokens,
      outputTokens: run.output_tokens,
      cacheReadTokens: run.cache_read_tokens,
      createdAt: run.created_at,
      // ⚠️ `run.messages` — the model's full internal transcript — is
      // deliberately NOT returned. The browser doesn't need it, and it can
      // contain the entire conversation several times over.
    },
    trace,
    approvals,
  });
}
