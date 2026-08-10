/**
 * ============================================================================
 *  lib/runs.ts  —  reading and writing the notebook
 * ============================================================================
 *
 * Every SQL statement in the app lives here or in app/api/jar/route.ts, so
 * there is exactly one place to look when you want to know what gets stored.
 *
 * ⚠️ SERVER-SIDE ONLY.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import type { LoopEvent, PendingCall, TokenUsage } from "./agent-loop";

export type RunStatus = "running" | "awaiting_approval" | "done" | "error";

export type RunRow = {
  id: string;
  conversation_id: string;
  status: RunStatus;
  prompt: string;
  model: string;
  effort: string | null;
  messages: Anthropic.MessageParam[];
  pending: PendingCall[] | null;
  final_text: string | null;
  stop_reason: string | null;
  detail: string | null;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function createConversation(title?: string): Promise<string> {
  const sql = db();
  const rows = (await sql`
    insert into conversations (title) values (${title ?? null})
    returning id
  `) as { id: string }[];
  return rows[0].id;
}

export async function conversationExists(id: string): Promise<boolean> {
  const sql = db();
  const rows = (await sql`select 1 from conversations where id = ${id}`) as unknown[];
  return rows.length > 0;
}

export async function appendChatMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  runId?: string,
): Promise<void> {
  const sql = db();
  await sql`
    insert into chat_messages (conversation_id, role, content, run_id)
    values (${conversationId}, ${role}, ${content}, ${runId ?? null})
  `;
  await sql`update conversations set updated_at = now() where id = ${conversationId}`;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function createRun(args: {
  conversationId: string;
  prompt: string;
  model: string;
  effort: string;
  messages: Anthropic.MessageParam[];
}): Promise<string> {
  const sql = db();
  const rows = (await sql`
    insert into runs (conversation_id, status, prompt, model, effort, messages)
    values (
      ${args.conversationId},
      'running',
      ${args.prompt},
      ${args.model},
      ${args.effort},
      ${JSON.stringify(args.messages)}::jsonb
    )
    returning id
  `) as { id: string }[];
  return rows[0].id;
}

export async function getRun(runId: string): Promise<RunRow | null> {
  const sql = db();
  const rows = (await sql`select * from runs where id = ${runId}`) as RunRow[];
  return rows[0] ?? null;
}

/**
 * Freeze a run mid-flight.
 *
 * This single function IS the pause. `messages` is the loop's entire state, so
 * writing it here is enough to reconstruct the agent later, in a different
 * process, on a different machine.
 */
export async function pauseRunForApproval(args: {
  runId: string;
  messages: Anthropic.MessageParam[];
  pending: PendingCall[];
  iterations: number;
  usage: TokenUsage;
}): Promise<void> {
  const sql = db();
  await sql`
    update runs set
      status             = 'awaiting_approval',
      messages           = ${JSON.stringify(args.messages)}::jsonb,
      pending            = ${JSON.stringify(args.pending)}::jsonb,
      iterations         = ${args.iterations},
      input_tokens       = input_tokens + ${args.usage.inputTokens},
      output_tokens      = output_tokens + ${args.usage.outputTokens},
      cache_write_tokens = cache_write_tokens + ${args.usage.cacheWriteTokens},
      cache_read_tokens  = cache_read_tokens + ${args.usage.cacheReadTokens},
      updated_at         = now()
    where id = ${args.runId}
  `;
}

export async function finishRun(args: {
  runId: string;
  status: "done" | "error";
  messages?: Anthropic.MessageParam[];
  finalText?: string;
  stopReason?: string;
  detail?: string;
  iterations?: number;
  usage?: TokenUsage;
}): Promise<void> {
  const sql = db();
  const usage = args.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  await sql`
    update runs set
      status             = ${args.status},
      messages           = coalesce(${args.messages ? JSON.stringify(args.messages) : null}::jsonb, messages),
      pending            = null,
      final_text         = ${args.finalText ?? null},
      stop_reason        = ${args.stopReason ?? null},
      detail             = ${args.detail ?? null},
      iterations         = greatest(iterations, ${args.iterations ?? 0}),
      input_tokens       = input_tokens + ${usage.inputTokens},
      output_tokens      = output_tokens + ${usage.outputTokens},
      cache_write_tokens = cache_write_tokens + ${usage.cacheWriteTokens},
      cache_read_tokens  = cache_read_tokens + ${usage.cacheReadTokens},
      updated_at         = now()
    where id = ${args.runId}
  `;
}

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

/**
 * Append one loop event to the run's permanent trace.
 *
 * `seq` is supplied by the caller and increments across the WHOLE run,
 * including across resumes — so replay reads events back in the order they
 * actually happened, not in the order of two separate HTTP requests.
 *
 * `approval_required` and `done` events carry the entire `messages` array.
 * Storing that in every trace row would duplicate the conversation once per
 * event, so it is stripped here — `runs.messages` already holds it.
 */
export async function recordEvent(
  runId: string,
  seq: number,
  event: LoopEvent,
): Promise<void> {
  const sql = db();
  const slim = { ...event } as Record<string, unknown>;
  delete slim.messages;
  await sql`
    insert into trace_events (run_id, seq, event)
    values (${runId}, ${seq}, ${JSON.stringify(slim)}::jsonb)
    on conflict (run_id, seq) do nothing
  `;
}

export async function nextSeq(runId: string): Promise<number> {
  const sql = db();
  const rows = (await sql`
    select coalesce(max(seq), -1) + 1 as next from trace_events where run_id = ${runId}
  `) as { next: number }[];
  return rows[0].next;
}

export async function getTrace(
  runId: string,
): Promise<{ seq: number; event: LoopEvent }[]> {
  const sql = db();
  const rows = (await sql`
    select seq, event from trace_events where run_id = ${runId} order by seq asc
  `) as { seq: number; event: LoopEvent }[];
  return rows;
}

// ---------------------------------------------------------------------------
// Approvals — the audit log
// ---------------------------------------------------------------------------

export async function recordApproval(args: {
  runId: string;
  toolUseId: string;
  toolName: string;
  toolArgs: unknown;
  reason?: string;
  decision: "approved" | "denied";
}): Promise<void> {
  const sql = db();
  await sql`
    insert into approvals (run_id, tool_use_id, tool_name, args, reason, decision)
    values (
      ${args.runId},
      ${args.toolUseId},
      ${args.toolName},
      ${JSON.stringify(args.toolArgs ?? null)}::jsonb,
      ${args.reason ?? null},
      ${args.decision}
    )
  `;
}

export async function listApprovals(runId: string) {
  const sql = db();
  return (await sql`
    select tool_use_id, tool_name, args, reason, decision, decided_at
      from approvals where run_id = ${runId} order by id asc
  `) as {
    tool_use_id: string;
    tool_name: string;
    args: unknown;
    reason: string | null;
    decision: "approved" | "denied";
    decided_at: string;
  }[];
}

// ---------------------------------------------------------------------------
// Reading history back — conversations, runs, replay
// ---------------------------------------------------------------------------

export async function listRuns(limit = 25) {
  const sql = db();
  return (await sql`
    select r.id, r.conversation_id, r.status, r.prompt, r.stop_reason,
           r.iterations, r.final_text, r.created_at,
           (select count(*)::int from approvals a where a.run_id = r.id) as approval_count,
           (select count(*)::int from trace_events t where t.run_id = r.id) as event_count
      from runs r
     order by r.created_at desc
     limit ${limit}
  `) as {
    id: string;
    conversation_id: string;
    status: RunStatus;
    prompt: string;
    stop_reason: string | null;
    iterations: number;
    final_text: string | null;
    created_at: string;
    approval_count: number;
    event_count: number;
  }[];
}

export async function getConversationHistory(
  conversationId: string,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const sql = db();
  return (await sql`
    select role, content from chat_messages
     where conversation_id = ${conversationId}
     order by id asc
  `) as { role: "user" | "assistant"; content: string }[];
}

export async function getJarState(): Promise<{ cookies: number; events: number }> {
  const sql = db();
  const jar = (await sql`select cookies from jar_state where id = 'default'`) as {
    cookies: number;
  }[];
  const ev = (await sql`select count(*)::int as n from jar_events`) as { n: number }[];
  return { cookies: jar[0]?.cookies ?? 0, events: ev[0]?.n ?? 0 };
}
