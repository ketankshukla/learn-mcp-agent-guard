/**
 * ============================================================================
 *  lib/db.ts  —  PHASE 1: the notebook
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Project #1 ended with a confession. Its cookie jar was a plain variable:
 *
 *     let cookiesInJar = 12;
 *
 * That works perfectly on your laptop, where there is one process. On Vercel
 * there are many machines, each with its own copy of that variable, and they
 * fall asleep. Add 20 cookies, ask again, and a *different* machine answers
 * "12" — it never heard of the first one. Project #1 called that a sandcastle
 * and left it in deliberately, as a lesson.
 *
 * This file is the tide-proof version. Everything this app remembers — the
 * cookie jar, every conversation, every run, every step of every run, every
 * approve/deny decision, every eval score — lives here instead.
 *
 * ---------------------------------------------------------------------------
 *  WHY THE *SERVERLESS* DRIVER, AND NOT ORDINARY `pg`
 * ---------------------------------------------------------------------------
 *
 * The normal way to talk to Postgres is a connection POOL: you open, say, 10
 * TCP connections once when your server boots, and every request borrows one.
 * That's a great design — for a server that boots once and runs for months.
 *
 * A serverless function is the opposite. It boots, handles one request, and
 * may be frozen or thrown away. "Open a pool at boot" now means "open a pool
 * per request." Postgres has a hard cap on simultaneous connections (Neon's
 * free tier is ~100 via the pooler), and a spike of traffic walks straight
 * into it:
 *
 *     FATAL: sorry, too many clients already
 *
 * `@neondatabase/serverless` sidesteps the whole problem by not holding a
 * connection at all. Each query is an ordinary HTTPS request to Neon's SQL
 * endpoint. No pool, no sockets to leak, nothing to clean up — and it works
 * unchanged in a route handler, in a script, and at the edge.
 *
 * The tradeoff, and it is a real one: each query is a separate HTTP round
 * trip, so there is no interactive transaction. You cannot BEGIN, read a row,
 * think about it, and then UPDATE inside the same transaction. Two ways
 * around that, both used in this project:
 *
 *   1. `sql.transaction([...])` — send several statements as one atomic batch.
 *   2. Do the read and the write in ONE statement. See the cookie jar's
 *      `update ... set cookies = cookies - $1 ... returning cookies`, which is
 *      atomic *because* it's a single statement. Two people eating cookies at
 *      the same instant cannot lose one.
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ SERVER-SIDE ONLY
 * ---------------------------------------------------------------------------
 *
 * DATABASE_URL contains a password. This module must only ever be imported
 * from a route handler or a terminal script. A database URL that reaches the
 * browser bundle is a public database.
 */

import { neon } from "@neondatabase/serverless";

/**
 * The one query function.
 *
 * Used as a tagged template:
 *
 *     const rows = await sql`select * from runs where id = ${runId}`;
 *
 * Everything you interpolate with `${...}` becomes a bound **parameter**, not
 * pasted-in text. That is not a style preference — it is the entire defence
 * against SQL injection, and it is why this file never builds a query by
 * concatenating strings. `sql` is doing the escaping for you, correctly,
 * every time.
 *
 * Created lazily inside a function rather than at module scope. If it were a
 * top-level `const`, importing this file with DATABASE_URL unset would throw
 * at import time — which on Next.js means a build failure with a stack trace
 * pointing at an import statement instead of a readable message.
 */
let cached: ReturnType<typeof neon> | null = null;

export function db() {
  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Run `npx vercel env pull .env.local` (or paste a " +
        "Neon connection string into .env.local), then RESTART the dev server — " +
        "env files are read once, at startup.",
    );
  }

  cached = neon(url);
  return cached;
}

/** True when a database is configured. Lets the UI degrade honestly instead of exploding. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

// ---------------------------------------------------------------------------
// THE SCHEMA.
//
// Written as one idempotent script rather than a migration tool, because this
// is a teaching project and you should be able to read the entire shape of the
// app's memory in one screen. `create table if not exists` everywhere means
// running it twice is safe.
// ---------------------------------------------------------------------------

export const SCHEMA_STATEMENTS: string[] = [
  // -------------------------------------------------------------------
  // 1. THE COOKIE JAR — project #1's lie, finally fixed.
  //
  // One row. `id` is a text primary key fixed to 'default' so there is
  // exactly one jar and the row can be upserted without a race.
  // -------------------------------------------------------------------
  `create table if not exists jar_state (
     id         text primary key default 'default',
     cookies    integer not null default 12 check (cookies >= 0),
     updated_at timestamptz not null default now()
   )`,

  `insert into jar_state (id, cookies) values ('default', 12)
     on conflict (id) do nothing`,

  // Every change to the jar, forever. This is what makes `jar_history` a real
  // tool and what `smash_jar` destroys — which is precisely why smash_jar
  // needs a human's permission.
  `create table if not exists jar_events (
     id            bigserial primary key,
     action        text not null,
     count         integer,
     cookies_after integer not null,
     note          text,
     created_at    timestamptz not null default now()
   )`,

  // -------------------------------------------------------------------
  // 2. CONVERSATIONS — so a refresh doesn't wipe everything.
  // -------------------------------------------------------------------
  `create table if not exists conversations (
     id         uuid primary key default gen_random_uuid(),
     title      text,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,

  // The human-readable turns: what you typed, what it answered. Distinct from
  // `runs.messages` below, which holds the model's own machine-readable
  // version of the same conversation (with tool_use / tool_result blocks).
  `create table if not exists chat_messages (
     id              bigserial primary key,
     conversation_id uuid not null references conversations(id) on delete cascade,
     role            text not null check (role in ('user','assistant')),
     content         text not null,
     run_id          uuid,
     created_at      timestamptz not null default now()
   )`,

  // -------------------------------------------------------------------
  // 3. RUNS — one trip through the agent loop, and THE RESUME MECHANISM.
  //
  // `messages` is the important column and it deserves a paragraph.
  //
  // The agent loop's entire state is its `messages` array. There is no hidden
  // memory anywhere — not in this app, not on Anthropic's side. So "pause a
  // running agent and resume it in a completely different HTTP request, maybe
  // on a different machine, five minutes later" reduces to: write that array
  // to Postgres, and read it back.
  //
  // That is the whole trick. There is no continuation, no coroutine, no
  // serialized generator. Just an array of messages in a jsonb column.
  // -------------------------------------------------------------------
  `create table if not exists runs (
     id              uuid primary key default gen_random_uuid(),
     conversation_id uuid not null references conversations(id) on delete cascade,
     status          text not null check (status in ('running','awaiting_approval','done','error')),
     prompt          text not null,
     model           text not null,
     effort          text,
     -- The loop's entire state: Anthropic MessageParam[].
     messages        jsonb not null default '[]'::jsonb,
     -- Tool calls the model asked for, frozen mid-flight, waiting for a human.
     pending         jsonb,
     final_text      text,
     stop_reason     text,
     detail          text,
     iterations      integer not null default 0,
     input_tokens        integer not null default 0,
     output_tokens       integer not null default 0,
     cache_write_tokens  integer not null default 0,
     cache_read_tokens   integer not null default 0,
     created_at      timestamptz not null default now(),
     updated_at      timestamptz not null default now()
   )`,

  // -------------------------------------------------------------------
  // 4. THE TRACE — every event the loop yielded, in order.
  //
  // The loop already yields a stream of small JSON events so the UI can draw
  // itself live. Writing those same events here costs almost nothing and buys
  // replay for free: to watch last Tuesday's run again you just read these
  // rows back in `seq` order. Phase 4 is nearly a `select`.
  // -------------------------------------------------------------------
  `create table if not exists trace_events (
     id         bigserial primary key,
     run_id     uuid not null references runs(id) on delete cascade,
     seq        integer not null,
     event      jsonb not null,
     created_at timestamptz not null default now(),
     unique (run_id, seq)
   )`,

  `create index if not exists trace_events_run_seq_idx on trace_events (run_id, seq)`,

  // -------------------------------------------------------------------
  // 5. APPROVALS — the audit log. Who allowed what, and when.
  //
  // The point of an approval gate isn't only to stop the tool. It's to be able
  // to answer "who said yes to that?" afterwards.
  // -------------------------------------------------------------------
  `create table if not exists approvals (
     id          bigserial primary key,
     run_id      uuid not null references runs(id) on delete cascade,
     tool_use_id text not null,
     tool_name   text not null,
     args        jsonb,
     reason      text,
     decision    text not null check (decision in ('approved','denied')),
     decided_at  timestamptz not null default now()
   )`,

  // -------------------------------------------------------------------
  // 6. EVALS — the report card, kept over time so you can diff runs.
  // -------------------------------------------------------------------
  `create table if not exists eval_runs (
     id          uuid primary key default gen_random_uuid(),
     label       text,
     model       text not null,
     effort      text,
     attempts    integer not null,
     total       integer not null,
     passed      integer not null,
     pass_rate   real not null,
     created_at  timestamptz not null default now()
   )`,

  `create table if not exists eval_results (
     id           bigserial primary key,
     eval_run_id  uuid not null references eval_runs(id) on delete cascade,
     case_id      text not null,
     attempt      integer not null,
     passed       boolean not null,
     expectation  text not null,
     actual       jsonb,
     detail       text,
     created_at   timestamptz not null default now()
   )`,

  `create index if not exists eval_results_run_idx on eval_results (eval_run_id, case_id)`,
];

/**
 * Create every table. Safe to run repeatedly.
 *
 * Note `sql.query(text)` rather than the tagged template: these statements are
 * literal constants defined above, not user input, and the tagged template
 * form is for interpolating *values*, not whole statements.
 */
export async function initSchema(): Promise<void> {
  const sql = db();
  for (const statement of SCHEMA_STATEMENTS) {
    await sql.query(statement);
  }
}
