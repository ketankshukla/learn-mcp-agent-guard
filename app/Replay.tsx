"use client";

/**
 * app/Replay.tsx — the rewind button.
 *
 * Pick a past run, step through it. Nothing here calls the model or re-runs a
 * tool; it reads `trace_events` back in order. The step-by-step control exists
 * because the interesting part of a run is usually one specific moment — the
 * pause — and scrolling past it in a wall of text is how you miss it.
 */

import { useCallback, useEffect, useState } from "react";

type RunSummary = {
  id: string;
  status: string;
  prompt: string;
  iterations: number;
  created_at: string;
  approval_count: number;
  event_count: number;
};

type TraceRow = { seq: number; event: Record<string, unknown> };

type ApprovalRow = {
  tool_name: string;
  args: unknown;
  decision: "approved" | "denied";
  decided_at: string;
  reason: string | null;
};

type RunDetail = {
  run: {
    id: string;
    status: string;
    prompt: string;
    model: string;
    finalText: string | null;
    stopReason: string | null;
    iterations: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    createdAt: string;
  };
  trace: TraceRow[];
  approvals: ApprovalRow[];
};

export default function Replay() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /** Used by the refresh button. */
  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      const data = await res.json();
      if (data.error) return setError(data.error);
      setRuns(data.runs);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  /**
   * Load once on mount.
   *
   * The fetch lives inside the effect (rather than calling `loadRuns`) with a
   * `cancelled` flag, so a component that unmounts mid-request doesn't try to
   * set state afterwards. React's lint rule pushed for this shape and it is
   * genuinely the right one — the old version had a real (if rare) bug.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/runs");
        const data = await res.json();
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setRuns(data.runs);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function open(id: string) {
    setDetail(null);
    setStep(0);
    try {
      const res = await fetch(`/api/runs?id=${id}`);
      const data = await res.json();
      if (data.error) return setError(data.error);
      setDetail(data);
      setStep(data.trace.length); // start fully expanded
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) {
    return (
      <div className="rounded-3xl border border-red-500/30 bg-red-950/30 px-6 py-5 text-sm text-red-200">
        {error}
      </div>
    );
  }

  if (!runs) {
    return (
      <div className="rounded-3xl border border-white/10 bg-slate-950/60 px-6 py-8 text-center text-sm text-slate-500">
        loading past runs…
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-3xl border border-white/10 bg-slate-950/60 px-6 py-8 text-center text-sm text-slate-500">
        No runs recorded yet. Send something in the demo above, then come back — it&apos;ll be
        here.
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      {/* ---- the list of past runs ---- */}
      <div className="max-h-[34rem] space-y-2 overflow-y-auto rounded-3xl border border-white/10 bg-slate-950/60 p-3">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="font-mono text-xs uppercase tracking-wider text-slate-500">
            past runs
          </span>
          <button
            onClick={loadRuns}
            className="rounded px-2 py-0.5 text-xs text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
          >
            refresh
          </button>
        </div>
        {runs.map((run) => (
          <button
            key={run.id}
            onClick={() => open(run.id)}
            className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
              detail?.run.id === run.id
                ? "border-amber-400/50 bg-amber-400/10"
                : "border-white/10 bg-white/5 hover:border-amber-400/30 hover:bg-amber-400/5"
            }`}
          >
            <div className="truncate text-sm text-slate-200">{run.prompt}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
              <span>{new Date(run.created_at).toLocaleString()}</span>
              <span>·</span>
              <span>{run.event_count} events</span>
              {run.approval_count > 0 && (
                <>
                  <span>·</span>
                  <span className="text-amber-400">
                    {run.approval_count} decision{run.approval_count > 1 ? "s" : ""}
                  </span>
                </>
              )}
              {run.status === "awaiting_approval" && (
                <span className="rounded bg-amber-400/20 px-1.5 py-0.5 font-semibold text-amber-300">
                  still paused
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* ---- the replay itself ---- */}
      <div className="max-h-[34rem] overflow-y-auto rounded-3xl border border-white/10 bg-slate-950/60 p-5">
        {!detail ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            Pick a run on the left.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/10 pb-4 text-xs text-slate-400">
              <span className="font-mono text-slate-500">{detail.run.id.slice(0, 8)}</span>
              <span>{detail.run.model}</span>
              <span>{detail.run.iterations} iterations</span>
              <span>
                {detail.run.inputTokens} in / {detail.run.outputTokens} out
              </span>
              {detail.run.cacheReadTokens > 0 && (
                <span className="text-emerald-400">
                  {detail.run.cacheReadTokens.toLocaleString()} cached
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setStep(0)}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/10"
              >
                ⏮ start
              </button>
              <button
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/10"
              >
                ◀ back
              </button>
              <button
                onClick={() => setStep((s) => Math.min(detail.trace.length, s + 1))}
                className="rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-slate-900 transition hover:bg-amber-300"
              >
                step ▶
              </button>
              <button
                onClick={() => setStep(detail.trace.length)}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/10"
              >
                all ⏭
              </button>
              <span className="ml-auto font-mono text-xs text-slate-500">
                {step} / {detail.trace.length}
              </span>
            </div>

            <div className="space-y-1.5 font-mono text-xs">
              {detail.trace.slice(0, step).map((row) => (
                <TraceLine key={row.seq} seq={row.seq} event={row.event} />
              ))}
            </div>

            {step >= detail.trace.length && detail.approvals.length > 0 && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="mb-2 font-mono text-xs uppercase tracking-wider text-slate-500">
                  who decided what
                </div>
                {detail.approvals.map((a, i) => (
                  <div key={i} className="text-xs text-slate-300">
                    <span
                      className={
                        a.decision === "approved"
                          ? "font-semibold text-emerald-400"
                          : "font-semibold text-amber-400"
                      }
                    >
                      {a.decision.toUpperCase()}
                    </span>{" "}
                    <code className="text-amber-300">{a.tool_name}</code>{" "}
                    <span className="text-sky-300">{JSON.stringify(a.args)}</span>
                    <span className="ml-2 text-slate-600">
                      {new Date(a.decided_at).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {step >= detail.trace.length && detail.run.finalText && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm leading-relaxed whitespace-pre-wrap text-slate-200">
                {detail.run.finalText}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TraceLine({ seq, event }: { seq: number; event: Record<string, unknown> }) {
  const type = String(event.type);
  const n = <span className="mr-2 text-slate-700">{String(seq).padStart(3, "0")}</span>;

  if (type === "iteration_start") {
    return (
      <div className="pt-2 text-amber-400">
        {n}— iteration {String(event.iteration)} —
      </div>
    );
  }

  if (type === "tool_call") {
    return (
      <div className="text-slate-300">
        {n}
        <span className="text-slate-500">-&gt; CALL </span>
        <span className="text-amber-300">{String(event.name)}</span>{" "}
        <span className="text-sky-300">{JSON.stringify(event.args)}</span>
      </div>
    );
  }

  if (type === "tool_result") {
    const isError = Boolean(event.isError);
    return (
      <div className={isError ? "text-red-300" : "text-emerald-300"}>
        {n}
        <span className="text-slate-500">&lt;- </span>
        {String(event.text).replace(/\n/g, " ").slice(0, 120)}
      </div>
    );
  }

  if (type === "approval_required") {
    const calls = (event.calls ?? []) as {
      name: string;
      args: unknown;
      requiresApproval: boolean;
      reason?: string;
    }[];
    return (
      <div className="my-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2.5">
        <div className="font-semibold text-amber-200">⏸ PAUSED FOR A HUMAN</div>
        {calls.map((c, i) => (
          <div key={i} className="mt-1">
            <span className="text-amber-300">{c.name}</span>{" "}
            <span className="text-sky-300">{JSON.stringify(c.args)}</span>
            {c.requiresApproval && (
              <span className="ml-2 rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-200">
                GATED
              </span>
            )}
            {c.reason && (
              <div className="mt-0.5 font-sans text-[11px] leading-relaxed text-amber-100/70">
                {c.reason}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (type === "done") {
    return (
      <div className="pt-2 text-slate-400">
        {n}done — {String(event.reason)}
      </div>
    );
  }

  if (type === "error") {
    return (
      <div className="text-red-300">
        {n}ERROR {String(event.message)}
      </div>
    );
  }

  if (type === "usage") {
    const u = event.iterationUsage as { inputTokens: number; outputTokens: number };
    return (
      <div className="text-slate-600">
        {n}
        {u?.inputTokens} in / {u?.outputTokens} out
      </div>
    );
  }

  if (type === "servers") {
    return (
      <div className="text-slate-600">
        {n}connected — {String(event.toolCount)} tools
      </div>
    );
  }

  // text / thinking chunks: too granular to list individually.
  return null;
}
