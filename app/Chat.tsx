"use client";

/**
 * ============================================================================
 *  app/Chat.tsx  —  the live trace, and the pause
 * ============================================================================
 *
 * `"use client"` because this uses useState and fetch on interaction.
 *
 * ⚠️ Notice what is NOT in this file: no API key, no database URL, no Anthropic
 * SDK, no MCP client, no server URLs. It talks to /api/chat and /api/resume and
 * nothing else. Everything secret stays on the other side of those two fetches.
 *
 * ---------------------------------------------------------------------------
 *  THE ONE SCREEN THIS WHOLE PROJECT IS FOR
 * ---------------------------------------------------------------------------
 *
 * <ApprovalCard>, near the bottom. When the host stops the agent, that card is
 * what you see: the exact tool, the exact arguments, in the exact shape they
 * will be sent, plus the host's reason for stopping — and two buttons.
 *
 * The arguments are rendered verbatim, unformatted, uninterpreted. If the card
 * summarised them ("the agent wants to modify the jar") you would be approving
 * a description of an action rather than the action, which is how you end up
 * approving something you didn't mean to.
 */

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Mirrors of the server's LoopEvent union, kept as local types rather than
// imported from lib/agent-loop so that nothing in lib/ (which reads env vars
// and talks to Postgres) can be pulled into the browser bundle by accident.
// ---------------------------------------------------------------------------

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

type ServerStatus = {
  key: string;
  label: string;
  url: string;
  ok: boolean;
  toolCount: number;
  excluded?: string[];
  error?: string;
};

type PendingCall = {
  id: string;
  name: string;
  serverLabel: string;
  args: unknown;
  requiresApproval: boolean;
  reason?: string;
};

type StreamEvent =
  | { type: "run_started"; runId: string; conversationId: string }
  | { type: "run_resumed"; runId: string; conversationId: string }
  | { type: "servers"; servers: ServerStatus[]; toolCount: number }
  | { type: "iteration_start"; iteration: number }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      serverLabel: string;
      args: unknown;
      iteration: number;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      text: string;
      isError: boolean;
      ms: number;
      denied?: boolean;
    }
  | { type: "usage"; iteration: number; iterationUsage: TokenUsage; totalUsage: TokenUsage }
  | {
      type: "approval_required";
      iteration: number;
      calls: PendingCall[];
      totalUsage: TokenUsage;
    }
  | {
      type: "done";
      reason: string;
      detail?: string;
      iterations: number;
      totalUsage: TokenUsage;
      finalText: string;
    }
  | { type: "error"; message: string };

type ToolCallView = {
  id: string;
  name: string;
  serverLabel: string;
  args: unknown;
  result?: { text: string; isError: boolean; ms: number; denied?: boolean };
};

type Iteration = {
  n: number;
  thinking: string;
  text: string;
  calls: ToolCallView[];
  usage?: TokenUsage;
};

type Turn = {
  role: "user" | "assistant";
  content: string;
  iterations?: Iteration[];
  servers?: ServerStatus[];
  totalUsage?: TokenUsage;
  done?: { reason: string; detail?: string; iterations: number };
  error?: string;
  runId?: string;
  /** Set while the host is waiting for a human. This is the whole feature. */
  awaiting?: PendingCall[];
  /** Recorded once a decision has been sent, so the card can't be used twice. */
  decided?: "approved" | "denied";
};

const DEMO_RECOVER = "Eat 500 cookies from the jar.";
const DEMO_PAUSE = "Empty the jar completely.";

const EXAMPLES = [
  DEMO_PAUSE,
  DEMO_RECOVER,
  "How many cookies are in the jar, and what's happened to it recently?",
  "Roll 3d20, then put that many cookies in the jar.",
  "Smash the jar. I'm sure.",
];

export default function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  /** Mutate the assistant turn currently being streamed into. */
  const patch = (fn: (turn: Turn) => Turn) =>
    setTurns((prev) => {
      const next = [...prev];
      const lastAssistant = next.map((t) => t.role).lastIndexOf("assistant");
      if (lastAssistant === -1) return prev;
      next[lastAssistant] = fn(next[lastAssistant]);
      return next;
    });

  /**
   * Read one NDJSON stream to completion.
   *
   * Shared by /api/chat and /api/resume because they emit the identical event
   * stream — which is the point. From the browser's side, "start a run" and
   * "resume a paused run" are the same operation with a different URL.
   */
  async function consume(response: Response) {
    if (!response.ok || !response.body) {
      const text = await response.text();
      patch((turn) => ({ ...turn, error: `HTTP ${response.status}: ${text.slice(0, 400)}` }));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // Keep the (possibly partial) last line. A network chunk can split a
      // JSON line in half — parsing per-chunk instead of per-complete-line is
      // the classic streaming bug that works locally and fails in production.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let event: StreamEvent;
        try {
          event = JSON.parse(line) as StreamEvent;
        } catch {
          continue;
        }
        if (event.type === "run_started" || event.type === "run_resumed") {
          setConversationId(event.conversationId);
        }
        patch((turn) => applyEvent(turn, event));
      }
    }
  }

  async function send(prompt: string) {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setInput("");

    setTurns((prev) => [
      ...prev,
      { role: "user", content: prompt },
      { role: "assistant", content: "", iterations: [] },
    ]);

    try {
      // Note what is sent: a conversation id and one sentence. NOT the history.
      // The database is the source of truth, so a refresh or a second tab sees
      // the same conversation.
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: prompt }),
      });
      await consume(response);
    } catch (error) {
      patch((turn) => ({ ...turn, error: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  /**
   * THE OTHER HALF. A brand-new HTTP request that restarts an agent which has
   * been sitting in Postgres since the last one ended.
   */
  async function decide(runId: string, calls: PendingCall[], decision: "approved" | "denied") {
    if (busy) return;
    setBusy(true);

    const decisions: Record<string, "approved" | "denied"> = {};
    for (const call of calls) {
      if (call.requiresApproval) decisions[call.id] = decision;
    }

    patch((turn) => ({ ...turn, awaiting: undefined, decided: decision }));

    try {
      const response = await fetch("/api/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, decisions }),
      });
      await consume(response);
    } catch (error) {
      patch((turn) => ({ ...turn, error: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-950/60">
      <div className="max-h-[44rem] min-h-[28rem] flex-1 space-y-6 overflow-y-auto p-5 sm:p-6">
        {turns.length === 0 && <EmptyState onPick={send} busy={busy} />}

        {turns.map((turn, index) =>
          turn.role === "user" ? (
            <div key={index} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-amber-400 px-4 py-2.5 text-base font-medium text-slate-900">
                {turn.content}
              </div>
            </div>
          ) : (
            <AssistantTurn key={index} turn={turn} onDecide={decide} busy={busy} />
          ),
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-white/10 bg-slate-900/50 p-4"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={busy ? "working..." : "Ask for something that needs a real tool..."}
            disabled={busy}
            className="flex-1 rounded-xl border border-white/10 bg-slate-950/80 px-4 py-3 text-base text-slate-100 placeholder-slate-500 outline-none transition focus:border-amber-400/50 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-xl bg-amber-400 px-6 py-3 text-base font-semibold text-slate-900 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Fold one streamed event into the assistant turn. Mirror of the loop's yields. */
function applyEvent(turn: Turn, event: StreamEvent): Turn {
  const iterations = [...(turn.iterations ?? [])];
  const current = iterations[iterations.length - 1];

  switch (event.type) {
    case "run_started":
    case "run_resumed":
      return { ...turn, runId: event.runId };

    case "servers":
      return { ...turn, servers: event.servers };

    case "iteration_start":
      iterations.push({ n: event.iteration, thinking: "", text: "", calls: [] });
      return { ...turn, iterations };

    case "thinking":
      if (!current) return turn;
      iterations[iterations.length - 1] = {
        ...current,
        thinking: current.thinking + event.text,
      };
      return { ...turn, iterations };

    case "text": {
      if (!current) return turn;
      iterations[iterations.length - 1] = { ...current, text: current.text + event.text };
      return { ...turn, iterations, content: current.text + event.text };
    }

    case "tool_call":
      if (!current) return turn;
      iterations[iterations.length - 1] = {
        ...current,
        calls: [
          ...current.calls,
          {
            id: event.id,
            name: event.name,
            serverLabel: event.serverLabel,
            args: event.args,
          },
        ],
      };
      return { ...turn, iterations };

    case "tool_result": {
      // On resume, results arrive before the first iteration of the continued
      // loop — so attach them to whichever iteration owns the call.
      const target = iterations.findIndex((it) => it.calls.some((c) => c.id === event.id));
      if (target === -1) return turn;
      iterations[target] = {
        ...iterations[target],
        calls: iterations[target].calls.map((call) =>
          call.id === event.id
            ? {
                ...call,
                result: {
                  text: event.text,
                  isError: event.isError,
                  ms: event.ms,
                  denied: event.denied,
                },
              }
            : call,
        ),
      };
      return { ...turn, iterations };
    }

    case "usage":
      if (!current) return turn;
      iterations[iterations.length - 1] = { ...current, usage: event.iterationUsage };
      return { ...turn, iterations, totalUsage: event.totalUsage };

    case "approval_required":
      // ⏸ The stream is about to end. The run now lives in Postgres.
      return { ...turn, awaiting: event.calls, totalUsage: event.totalUsage };

    case "done":
      return {
        ...turn,
        done: { reason: event.reason, detail: event.detail, iterations: event.iterations },
        totalUsage: event.totalUsage,
        content: event.finalText || turn.content,
      };

    case "error":
      return { ...turn, error: event.message };

    default:
      return turn;
  }
}

function AssistantTurn({
  turn,
  onDecide,
  busy,
}: {
  turn: Turn;
  onDecide: (runId: string, calls: PendingCall[], d: "approved" | "denied") => void;
  busy: boolean;
}) {
  const toolCalls = (turn.iterations ?? []).reduce((sum, it) => sum + it.calls.length, 0);
  const denied = (turn.iterations ?? []).some((it) =>
    it.calls.some((c) => c.result?.denied),
  );

  return (
    <div className="space-y-3">
      {turn.servers && <ServerBar servers={turn.servers} />}

      {(turn.iterations ?? []).map((iteration) => (
        <IterationCard key={iteration.n} iteration={iteration} />
      ))}

      {/* ⏸ THE SCREEN THIS PROJECT EXISTS FOR. */}
      {turn.awaiting && turn.runId && (
        <ApprovalCard
          calls={turn.awaiting}
          busy={busy}
          onDecide={(d) => onDecide(turn.runId!, turn.awaiting!, d)}
        />
      )}

      {turn.error && (
        <div className="rounded-2xl border border-red-500/30 bg-red-950/40 px-5 py-3.5 text-sm text-red-200">
          <span className="font-semibold">Error:</span> {turn.error}
        </div>
      )}

      {turn.done && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-xs text-slate-400">
          <span>
            <span className="text-slate-500">stopped:</span>{" "}
            <span
              className={turn.done.reason === "end_turn" ? "text-emerald-400" : "text-amber-400"}
            >
              {turn.done.reason}
            </span>
          </span>
          <span>
            <span className="text-slate-500">iterations:</span> {turn.done.iterations}
          </span>
          <span>
            <span className="text-slate-500">tool calls:</span> {toolCalls}
          </span>
          {turn.totalUsage && (
            <>
              <span>
                <span className="text-slate-500">tokens:</span>{" "}
                {turn.totalUsage.inputTokens.toLocaleString()} in /{" "}
                {turn.totalUsage.outputTokens.toLocaleString()} out
              </span>
              {turn.totalUsage.cacheReadTokens > 0 && (
                <span className="text-emerald-400">
                  <span className="text-slate-500">cached:</span>{" "}
                  {turn.totalUsage.cacheReadTokens.toLocaleString()} reused at ~10%
                </span>
              )}
            </>
          )}
          {turn.runId && (
            <span className="font-mono text-[10px] text-slate-600">run {turn.runId.slice(0, 8)}</span>
          )}
          {turn.done.detail && <span className="text-amber-400">{turn.done.detail}</span>}
        </div>
      )}

      {/* The payoff banner for the deny path: the agent adapted instead of dying. */}
      {denied && turn.done && (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-5 py-4 text-base leading-relaxed text-amber-100">
          <span className="font-semibold">That was the whole lesson.</span> You said no, the tool
          never ran, and the agent kept going — it read the refusal as an ordinary tool result,
          adapted, and told you what it would do instead. Nothing crashed and nothing stopped
          silently.
        </div>
      )}
    </div>
  );
}

/**
 * ---------------------------------------------------------------------------
 *  THE APPROVAL CARD
 * ---------------------------------------------------------------------------
 *
 *  Three deliberate choices, all of them about not lying to the person reading:
 *
 *  1. The arguments are printed as raw JSON. Not summarised, not prettified
 *     into a sentence. You approve the exact bytes that will be sent.
 *  2. The host's reason is shown. A stop sign with no explanation trains people
 *     to click past it.
 *  3. Deny is not styled as the scary option. Deny is the safe one — it is
 *     Approve that does something irreversible, so Approve is the one wearing
 *     the warning colour.
 */
function ApprovalCard({
  calls,
  busy,
  onDecide,
}: {
  calls: PendingCall[];
  busy: boolean;
  onDecide: (d: "approved" | "denied") => void;
}) {
  const gated = calls.filter((c) => c.requiresApproval);
  const queued = calls.filter((c) => !c.requiresApproval);

  return (
    <div className="overflow-hidden rounded-2xl border-2 border-amber-400/60 bg-amber-400/[0.07] shadow-lg shadow-amber-500/10">
      <div className="flex items-center gap-2 border-b border-amber-400/30 bg-amber-400/10 px-5 py-3">
        <span className="text-lg">⏸</span>
        <span className="font-semibold text-amber-200">
          Paused. The agent wants to call:
        </span>
      </div>

      <div className="space-y-4 px-5 py-5">
        {gated.map((call) => (
          <div key={call.id}>
            <div className="overflow-x-auto rounded-xl border border-amber-400/25 bg-slate-950/70 px-4 py-3">
              <code className="whitespace-nowrap font-mono text-sm">
                <span className="font-semibold text-amber-300">{call.name}</span>
                <span className="mx-3 text-slate-600">·</span>
                <span className="text-sky-300">{JSON.stringify(call.args)}</span>
              </code>
            </div>
            <div className="mt-1.5 text-xs text-slate-500">{call.serverLabel}</div>
            {call.reason && (
              <p className="mt-2.5 text-sm leading-relaxed text-amber-100/80">
                <span className="font-semibold text-amber-200">Why this stopped: </span>
                {call.reason}
              </p>
            )}
          </div>
        ))}

        {queued.length > 0 && (
          <p className="text-xs text-slate-500">
            Also waiting (not itself dangerous, but held so nothing runs
            half-way):{" "}
            {queued.map((c) => (
              <code key={c.id} className="mr-2 font-mono text-slate-400">
                {c.name}
              </code>
            ))}
          </p>
        )}

        <div className="flex flex-wrap gap-3 pt-1">
          <button
            onClick={() => onDecide("approved")}
            disabled={busy}
            className="rounded-xl bg-amber-400 px-6 py-2.5 font-semibold text-slate-900 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Approve
          </button>
          <button
            onClick={() => onDecide("denied")}
            disabled={busy}
            className="rounded-xl border border-white/20 bg-white/5 px-6 py-2.5 font-semibold text-slate-200 transition hover:border-white/40 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Deny
          </button>
        </div>

        <p className="text-xs leading-relaxed text-slate-500">
          Nothing has run yet — not even the safe calls in this batch. The HTTP request that
          started this run has already ended; the agent is a row in Postgres right now. Close
          this tab, come back tomorrow, and this decision is still waiting.
        </p>
      </div>
    </div>
  );
}

function ServerBar({ servers }: { servers: ServerStatus[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {servers.map((server) => (
        <span
          key={server.key}
          title={server.error ?? server.url}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
            server.ok
              ? "border-emerald-800 bg-emerald-950/40 text-emerald-300"
              : "border-red-800 bg-red-950/40 text-red-300"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${server.ok ? "bg-emerald-400" : "bg-red-400"}`}
          />
          {server.label}
          <span className="text-slate-500">
            {server.ok ? `${server.toolCount} tools` : "down"}
          </span>
          {server.excluded?.length ? (
            <span
              className="text-slate-600"
              title={`This host hides: ${server.excluded.join(", ")}`}
            >
              · {server.excluded.length} hidden
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/**
 * Markdown-lite: the model writes **bold** and `code`, and rendering those as
 * literal asterisks makes correct output look broken. Deliberately NOT a
 * markdown library — a regex split, so there is no HTML injection path (React
 * escapes every string it renders).
 */
function Formatted({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <strong key={index} className="font-semibold text-white">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code
              key={index}
              className="rounded bg-white/10 px-1.5 py-0.5 text-[0.9em] text-amber-300"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        return part;
      })}
    </>
  );
}

function IterationCard({ iteration }: { iteration: Iteration }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/40">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-5 py-2.5">
        <span className="font-mono text-xs font-semibold uppercase tracking-wider text-amber-400">
          iteration {iteration.n}
        </span>
        {iteration.usage && (
          <span className="flex items-center gap-2 font-mono text-[11px] text-slate-500">
            <span>
              {iteration.usage.inputTokens.toLocaleString()} in /{" "}
              {iteration.usage.outputTokens.toLocaleString()} out
            </span>
            {iteration.usage.cacheWriteTokens > 0 && (
              <span
                title="System prompt + tool definitions written to cache (~1.25x price, once)"
                className="rounded bg-sky-950 px-1.5 py-0.5 text-sky-300"
              >
                cache write {iteration.usage.cacheWriteTokens.toLocaleString()}
              </span>
            )}
            {iteration.usage.cacheReadTokens > 0 && (
              <span
                title="Served from cache at ~10% of the input price"
                className="rounded bg-emerald-950 px-1.5 py-0.5 text-emerald-300"
              >
                cache read {iteration.usage.cacheReadTokens.toLocaleString()}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="space-y-3 px-5 py-4">
        {iteration.thinking.trim() && (
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-400">
              reasoning
            </summary>
            <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-white/10 pl-3 text-slate-400">
              {iteration.thinking.trim()}
            </p>
          </details>
        )}

        {iteration.text.trim() && (
          <p className="whitespace-pre-wrap text-base leading-relaxed text-slate-100">
            <Formatted text={iteration.text.trim()} />
          </p>
        )}

        {iteration.calls.map((call) => (
          <div
            key={call.id}
            className={`rounded-xl border text-xs ${
              call.result?.denied
                ? "border-amber-500/40 bg-amber-950/20"
                : "border-white/10 bg-slate-950/70"
            }`}
          >
            <div className="flex flex-wrap items-baseline gap-2 border-b border-white/10 px-3.5 py-2">
              <span className="font-mono font-semibold text-amber-300">{call.name}</span>
              <span className="text-slate-500">{call.serverLabel}</span>
              {call.result?.denied && (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-semibold text-amber-300">
                  DENIED BY YOU
                </span>
              )}
              {call.result && !call.result.denied && (
                <span className="ml-auto font-mono text-slate-600">{call.result.ms}ms</span>
              )}
            </div>

            <div className="px-3 py-2">
              <div className="text-slate-500">arguments</div>
              <pre className="mt-0.5 overflow-x-auto font-mono text-[11px] text-sky-300">
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </div>

            <div className="border-t border-white/10 px-3.5 py-2">
              <div className="text-slate-500">result</div>
              {call.result ? (
                <pre
                  className={`mt-0.5 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] ${
                    call.result.denied
                      ? "text-amber-300"
                      : call.result.isError
                        ? "text-red-300"
                        : "text-emerald-300"
                  }`}
                >
                  {call.result.text}
                </pre>
              ) : (
                <div className="mt-0.5 animate-pulse font-mono text-[11px] text-slate-600">
                  waiting...
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ onPick, busy }: { onPick: (prompt: string) => void; busy: boolean }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-6 text-center">
      <div>
        <h3 className="text-xl font-semibold text-slate-100">Pick one, or ask your own.</h3>
        <p className="mt-2 text-base text-slate-400">
          Start with the first one. It stops and asks you before it does anything.
        </p>
      </div>

      <div className="grid gap-2.5 text-left">
        {EXAMPLES.map((example, index) => (
          <button
            key={example}
            onClick={() => onPick(example)}
            disabled={busy}
            className="rounded-2xl border border-white/10 bg-white/5 px-5 py-3.5 text-base text-slate-300 transition hover:border-amber-400/40 hover:bg-amber-400/5 hover:text-slate-100 disabled:opacity-50"
          >
            {index === 0 && (
              <span className="mr-2 rounded bg-amber-400 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-slate-900">
                the demo
              </span>
            )}
            {index === 1 && (
              <span className="mr-2 rounded bg-white/10 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-slate-300">
                recovers
              </span>
            )}
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
