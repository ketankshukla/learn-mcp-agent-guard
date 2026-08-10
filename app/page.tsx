/**
 * app/page.tsx — the lesson page.
 *
 * Stays a SERVER component (no "use client") and imports <Chat /> and
 * <Replay /> as interactive islands — the same pattern projects #1 and #2 use.
 *
 * Design deliberately matches its siblings: slate-950, amber accent,
 * rounded-3xl cards on white/10 borders, alternating section backgrounds.
 * Three projects, one look.
 */

import Chat from "./Chat";
import Replay from "./Replay";
import { ruleSummary } from "@/lib/approval";

const FOUR_THINGS = [
  {
    emoji: "📓",
    plain: "A notebook",
    real: "persistence",
    body: "It writes down everything it does — every conversation, every run, every step, every approve and deny — in Postgres. A refresh doesn't wipe it, and neither does a different machine picking up the next request.",
  },
  {
    emoji: "✋",
    plain: 'An "are you sure?"',
    real: "human-in-the-loop approval",
    body: "Before anything it can't undo, it stops and shows you the exact tool and the exact arguments. You click Approve or Deny. Deny feeds a refusal back into the loop and the agent adapts.",
  },
  {
    emoji: "📊",
    plain: "A report card",
    real: "evals",
    body: "A list of prompts and what should happen for each. Run them, score a pass rate, diff against last time. It turns “feels better” into a number that moved or didn't.",
  },
  {
    emoji: "⏪",
    plain: "A rewind button",
    real: "replay",
    body: "Because the notebook recorded every step in order, you can pull up any past run and watch it again — including the calls that failed and the ones you refused.",
  },
];

export default function Home() {
  const rules = ruleSummary();

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      {/* ---------------------------- HERO ---------------------------- */}
      <section className="relative overflow-hidden border-b border-white/5">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[46rem] -translate-x-1/2 rounded-full bg-amber-500/20 blur-3xl" />
        <div className="relative mx-auto max-w-5xl px-6 py-24 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 font-mono text-xs text-amber-300">
            ✋ mcp-agent-guard · project #3
          </div>
          <h1 className="text-balance text-5xl font-bold leading-tight sm:text-7xl">
            The agent that
            <br />
            <span className="bg-gradient-to-r from-amber-300 to-orange-400 bg-clip-text text-transparent">
              asks first
            </span>
          </h1>
          <p className="mx-auto mt-8 max-w-2xl text-pretty text-xl leading-relaxed text-slate-400">
            Project #2 built a loop that calls every tool the instant the model picks it, keeps no
            record, and forgets everything on refresh. That&apos;s fine for dice and cookies.
            It is not fine the moment a tool can delete, send, or charge something.
          </p>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-slate-500">
            This one stops and asks — and writes down what happened either way.
          </p>
        </div>
      </section>

      {/* ------------------------ THE PROBLEM ------------------------- */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <h2 className="mb-4 text-3xl font-bold">The uncomfortable question</h2>
        <p className="mb-10 max-w-2xl text-slate-400">
          Your agent works. It rolls dice, adds cookies, chains tool calls, shows every step.
          Now connect one more server — one with a <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-amber-300">delete_file</code> tool.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-3xl border border-red-500/25 bg-red-950/20 p-7">
            <div className="mb-3 text-4xl">💥</div>
            <h3 className="mb-2 text-lg font-semibold text-red-200">Project #2&apos;s loop</h3>
            <p className="text-slate-400">
              The model picks the tool. The loop runs it. Those are the same instant — there is no
              gap between them where anything could intervene. No pause, no confirmation, no
              record. Refresh the page and it never happened.
            </p>
          </div>
          <div className="rounded-3xl border border-amber-400/30 bg-amber-400/10 p-7">
            <div className="mb-3 text-4xl">✋</div>
            <h3 className="mb-2 text-lg font-semibold">This loop</h3>
            <p className="text-slate-300">
              Between &ldquo;the model picked a tool&rdquo; and &ldquo;the tool ran&rdquo; there is
              now a gap, and a human standing in it. Everything that happens on either side is
              written down.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------ FOUR THINGS ------------------------- */}
      <section className="border-y border-white/5 bg-slate-900/40">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="mb-4 text-3xl font-bold">Four things, in plain words</h2>
          <p className="mb-10 max-w-2xl text-slate-400">
            Forget the jargon for a second. This project gives the agent a notebook, an
            are-you-sure, a report card, and a rewind button. Everything else is detail.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {FOUR_THINGS.map((thing) => (
              <div
                key={thing.plain}
                className="rounded-3xl border border-white/10 bg-slate-950/60 p-7"
              >
                <div className="mb-3 text-4xl">{thing.emoji}</div>
                <h3 className="text-lg font-semibold">{thing.plain}</h3>
                <div className="mb-3 font-mono text-xs uppercase tracking-wider text-amber-400">
                  {thing.real}
                </div>
                <p className="text-sm leading-relaxed text-slate-400">{thing.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------- THE DEMO -------------------------- */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <h2 className="mb-4 text-3xl font-bold">Try it. It will stop you.</h2>
        <p className="mb-4 max-w-2xl text-slate-400">
          A real loop against two real MCP servers — this repo&apos;s cookie jar (backed by a real
          Postgres database) and{" "}
          <a
            href="https://github.com/ketankshukla/learn-mcp-5-year-old"
            className="text-amber-300 underline decoration-amber-300/30 underline-offset-4 hover:decoration-amber-300"
          >
            project #1&apos;s live server
          </a>
          . Every tool call, argument, result and token count is shown as it happens.
        </p>
        <p className="mb-10 max-w-2xl text-slate-400">
          Ask it to <strong className="text-slate-200">empty the jar</strong> and watch the run
          stop dead. The HTTP request that started it has already finished by then — the agent is
          sitting in Postgres waiting for you. You could close the tab and come back tomorrow.
        </p>
        <Chat />
      </section>

      {/* --------------------------- THE RULES ------------------------- */}
      <section className="border-y border-white/5 bg-slate-900/40">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="mb-4 text-3xl font-bold">Who decides what&apos;s dangerous?</h2>
          <p className="mb-8 max-w-3xl text-slate-400">
            MCP lets a server advertise{" "}
            <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-amber-300">
              destructiveHint: true
            </code>{" "}
            on a tool. This host sets that flag honestly on its own tools — and then{" "}
            <strong className="text-slate-200">never reads it</strong>.
          </p>
          <div className="mb-10 rounded-3xl border border-amber-400/30 bg-amber-400/10 p-7">
            <p className="text-lg leading-relaxed text-slate-200">
              That flag is a claim, sent over a network, by a machine you don&apos;t control. If
              your gate consults it, then any server that wants to bypass your gate simply sets it
              to <code className="font-mono text-amber-300">false</code>. You&apos;d have built a
              lock whose key is kept by the person outside the door.
            </p>
            <p className="mt-4 text-lg font-semibold text-amber-200">
              A hint from the other side of a network boundary is not a permission model.
            </p>
          </div>

          <h3 className="mb-4 text-xl font-semibold">
            So the list lives here, on the host side
          </h3>
          <div className="overflow-hidden rounded-3xl border border-white/10 bg-slate-950/60">
            {rules.map((rule) => (
              <div
                key={`${rule.tool}-${rule.when}`}
                className="border-b border-white/5 px-6 py-4 last:border-0"
              >
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="text-amber-400">⏸</span>
                  <code className="font-mono text-sm font-semibold text-amber-300">
                    {rule.tool}
                  </code>
                  <span className="text-sm text-slate-500">when {rule.when}</span>
                </div>
                <p className="mt-2 pl-7 text-sm leading-relaxed text-slate-400">{rule.reason}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-slate-500">
            Everything else runs without asking. Rules read the{" "}
            <strong className="text-slate-400">arguments</strong>, not just the name — because{" "}
            <code className="font-mono text-slate-400">cookie_jar</code> isn&apos;t dangerous, but{" "}
            <code className="font-mono text-slate-400">
              cookie_jar &#123; action: &quot;eat&quot; &#125;
            </code>{" "}
            is. The whole file is{" "}
            <code className="font-mono text-amber-300">lib/approval.ts</code>.
          </p>
        </div>
      </section>

      {/* -------------------------- THE REWIND ------------------------- */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <h2 className="mb-4 text-3xl font-bold">The rewind button</h2>
        <p className="mb-10 max-w-2xl text-slate-400">
          Every run above was written to Postgres as it happened — one row per event, in order. So
          replaying one is a <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-amber-300">select</code>.
          No model is called and nothing re-runs; you are reading back what actually happened,
          including the calls that failed and the ones somebody refused.
        </p>
        <Replay />
      </section>

      {/* --------------------------- CONNECT --------------------------- */}
      <section className="border-y border-white/5 bg-slate-900/40">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="mb-4 text-3xl font-bold">This project ships a server too</h2>
          <p className="mb-8 max-w-2xl text-slate-400">
            The cookie jar from project #1, with its memory finally fixed. Same tools, same
            protocol — but the count lives in Postgres instead of a variable, so it survives
            restarts and agrees across machines. Plug it into Claude Code like any other server:
          </p>
          <pre className="overflow-x-auto rounded-3xl border border-white/10 bg-slate-900 p-6 font-mono text-sm text-emerald-300">
            claude mcp add --transport http cookie-jar-durable https://learn-mcp-agent-guard.vercel.app/api/jar
          </pre>
          <p className="mt-6 text-slate-400">
            It offers{" "}
            <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-amber-300">cookie_jar</code>,{" "}
            <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-amber-300">jar_history</code>,{" "}
            <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-amber-300">secret_code</code>{" "}
            and{" "}
            <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-amber-300">smash_jar</code>
            {" "}— that last one genuinely, permanently deletes data, which is exactly why the gate
            exists.
          </p>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            <a
              href="https://github.com/ketankshukla/learn-mcp-agent-guard"
              className="group rounded-3xl border border-white/10 bg-white/5 p-6 transition hover:border-amber-400/40 hover:bg-amber-400/5"
            >
              <div className="mb-1 font-semibold text-slate-100">Read the gate →</div>
              <p className="text-sm text-slate-400">
                <code className="font-mono">lib/approval.ts</code> is thirty lines and the most
                important file here.
              </p>
            </a>
            <a
              href="https://github.com/ketankshukla/learn-mcp-agent-loop"
              className="group rounded-3xl border border-white/10 bg-white/5 p-6 transition hover:border-amber-400/40 hover:bg-amber-400/5"
            >
              <div className="mb-1 font-semibold text-slate-100">Project #2: the loop →</div>
              <p className="text-sm text-slate-400">
                Where the agent loop came from. Start there if &ldquo;agent&rdquo; is still fuzzy.
              </p>
            </a>
            <a
              href="https://github.com/ketankshukla/learn-mcp-5-year-old"
              className="group rounded-3xl border border-white/10 bg-white/5 p-6 transition hover:border-amber-400/40 hover:bg-amber-400/5"
            >
              <div className="mb-1 font-semibold text-slate-100">Project #1: the server →</div>
              <p className="text-sm text-slate-400">
                Where the cookie jar came from, and the in-memory lie this project fixes.
              </p>
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/5 py-10 text-center text-sm text-slate-600">
        Built with Next.js + the Claude API + Neon Postgres · the whole permission model is one
        file: <code className="font-mono">lib/approval.ts</code>
      </footer>
    </main>
  );
}
