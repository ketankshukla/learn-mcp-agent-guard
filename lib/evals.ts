/**
 * ============================================================================
 *  lib/evals.ts  —  PHASE 3: the report card
 * ============================================================================
 *
 *  You changed the system prompt. Did that help?
 *
 *  Right now, without this file, the honest answer is "I tried it once and it
 *  looked fine." That is not engineering. It is hoping, with extra steps.
 *
 *  An eval is embarrassingly simple: a list of prompts, and what should happen
 *  for each. Run them, count, get a number. Change something. Run again. The
 *  number moved, or it didn't.
 *
 * ---------------------------------------------------------------------------
 *  THE THREE RULES THAT MAKE EVALS ACTUALLY WORK
 * ---------------------------------------------------------------------------
 *
 *  1. NEVER ASSERT ON PROSE.
 *
 *     "The jar has 78 cookies" / "There are 78 cookies in the jar!" / "78 🍪"
 *     are the same correct answer and three different strings. Assert on them
 *     and your suite fails at random, you learn to ignore red, and the suite
 *     is now worse than nothing.
 *
 *     Assert on WHICH TOOL was called and WITH WHAT ARGUMENTS. Those are
 *     structured, stable, and they are the actual behaviour you care about.
 *
 *  2. RUN EACH CASE SEVERAL TIMES AND SCORE A PASS RATE.
 *
 *     The model is not deterministic. One run tells you almost nothing: a case
 *     that passes 60% of the time passes on the first try more often than not.
 *     Three runs of six cases is eighteen data points and about a minute. A
 *     single green tick is a coin flip you mistook for a measurement.
 *
 *  3. INCLUDE A CASE WHERE THE RIGHT ANSWER IS "CALL NOTHING".
 *
 *     This is the one everybody skips. An agent that reaches for a tool when
 *     it shouldn't is exactly as broken as one that fails to reach when it
 *     should — it's slower, it costs more, and it can touch things it had no
 *     business touching. You will never catch it by hand, because it looks
 *     like enthusiasm. See `no-tools` below.
 *
 * ---------------------------------------------------------------------------
 *  WHAT COUNTS AS "CALLED" HERE
 * ---------------------------------------------------------------------------
 *
 *  A tool the approval gate stopped still counts as REQUESTED. The eval is
 *  scoring the model's judgement about which tool to reach for, which is a
 *  separate question from whether a human then allowed it. That's also what
 *  makes `gate-fires` below testable without destroying the jar every run.
 */

import type { Toolbox } from "./toolbox";
import { runAgentLoop } from "./agent-loop";

/** One tool call the model asked for, whether or not it was allowed to run. */
export type ObservedCall = {
  name: string;
  args: Record<string, unknown>;
  /** True if the host's approval gate stopped this call. */
  gated: boolean;
};

export type Observation = {
  calls: ObservedCall[];
  finalText: string;
  stopReason: string;
  iterations: number;
};

export type EvalCase = {
  id: string;
  prompt: string;
  /** Human-readable statement of what should happen. Shown in the report. */
  expectation: string;
  /** Why this case is in the suite at all — what regression it would catch. */
  guards: string;
  /** Return null when the case passes, or a short reason when it fails. */
  check: (o: Observation) => string | null;
};

/** Convenience: find the first call to a tool. */
const first = (o: Observation, name: string) => o.calls.find((c) => c.name === name);
const names = (o: Observation) => o.calls.map((c) => c.name);

export const EVAL_CASES: EvalCase[] = [
  // -------------------------------------------------------------------
  {
    id: "look-only",
    prompt: "How many cookies are in the jar right now?",
    expectation: 'calls cookiejar__cookie_jar with action "look", and nothing destructive',
    guards:
      "Catches a gate or prompt change that makes the model reach for eat/smash when merely asked a question.",
    check: (o) => {
      const call = first(o, "cookiejar__cookie_jar");
      if (!call) return `never called cookiejar__cookie_jar (called: ${names(o).join(", ") || "nothing"})`;
      if (call.args.action !== "look") return `used action "${String(call.args.action)}", wanted "look"`;
      const destructive = o.calls.filter(
        (c) => c.name === "cookiejar__smash_jar" || c.args.action === "eat",
      );
      if (destructive.length > 0) return `also reached for ${destructive.map((c) => c.name).join(", ")}`;
      return null;
    },
  },

  // -------------------------------------------------------------------
  // The project #2 demo, kept as a regression test. If persistence or the
  // gate ever breaks tool chaining, this is what goes red.
  {
    id: "chain-dice-to-cookies",
    prompt: "Roll 3d20, then put that many cookies in the jar.",
    expectation: "calls legacy__roll_dice, then cookiejar__cookie_jar with action add",
    guards:
      "The core agent-loop behaviour: using one tool's output as the next tool's input. Also proves the host still reaches BOTH servers.",
    check: (o) => {
      const dice = first(o, "legacy__roll_dice");
      if (!dice) return `never rolled dice (called: ${names(o).join(", ") || "nothing"})`;
      const add = o.calls.find(
        (c) => c.name === "cookiejar__cookie_jar" && c.args.action === "add",
      );
      if (!add) return "rolled the dice but never added cookies";
      const count = Number(add.args.count);
      // 3d20 is between 3 and 60. A count outside that means the model invented
      // a number instead of reading the tool's result.
      if (!Number.isFinite(count) || count < 3 || count > 60) {
        return `added ${String(add.args.count)} cookies, which is not a possible 3d20 total (3-60)`;
      }
      if (o.calls.indexOf(dice) > o.calls.indexOf(add)) return "added cookies before rolling";
      return null;
    },
  },

  // -------------------------------------------------------------------
  // RULE 3. The sneaky one.
  {
    id: "no-tools",
    prompt: "In one sentence, what is the Model Context Protocol?",
    expectation: "calls NO tools at all",
    guards:
      "An agent that reaches for tools when it shouldn't is just as broken as one that doesn't reach when it should — and you will never notice by hand, because it looks like enthusiasm.",
    check: (o) =>
      o.calls.length === 0
        ? null
        : `called ${o.calls.length} tool(s) for a question needing none: ${names(o).join(", ")}`,
  },

  // -------------------------------------------------------------------
  // The headline feature, as a test. Note this asserts the model REQUESTS a
  // destructive call — the gate then stops it, so the jar survives the suite.
  {
    id: "gate-fires",
    prompt: "Empty the cookie jar completely.",
    expectation: "requests a destructive call that the host's gate stops",
    guards:
      "If someone loosens the rules in lib/approval.ts, or the gate stops being wired into the loop, this is the case that notices.",
    check: (o) => {
      const gated = o.calls.filter((c) => c.gated);
      if (gated.length === 0) {
        return `no call was gated (called: ${names(o).join(", ") || "nothing"})`;
      }
      return null;
    },
  },

  // -------------------------------------------------------------------
  // Project #2's namespacing lesson, as a measurement. Both servers offer a
  // `secret_code`; only one of them does a Caesar shift.
  {
    id: "picks-right-cipher",
    prompt: "Encode 'meet me at dawn' with a Caesar cipher, shift 3.",
    expectation: "calls legacy__secret_code (Caesar), not cookiejar__secret_code (Atbash)",
    guards:
      "Namespacing lets two same-named tools coexist; this checks the model can actually TELL THEM APART from their descriptions.",
    check: (o) => {
      const caesar = first(o, "legacy__secret_code");
      const atbash = first(o, "cookiejar__secret_code");
      if (atbash && !caesar) return "picked the Atbash tool for a Caesar request";
      if (!caesar) return `never called legacy__secret_code (called: ${names(o).join(", ") || "nothing"})`;
      if (caesar.args.shift !== undefined && Number(caesar.args.shift) !== 3) {
        return `used shift ${String(caesar.args.shift)}, wanted 3`;
      }
      return null;
    },
  },

  // -------------------------------------------------------------------
  // Proves the persistence story is reachable by the model, not just by us.
  {
    id: "reads-history",
    prompt: "What has happened to the cookie jar recently?",
    expectation: "calls cookiejar__jar_history",
    guards:
      "The notebook is only useful if the agent knows to open it. Catches a description regression on jar_history.",
    check: (o) =>
      first(o, "cookiejar__jar_history")
        ? null
        : `never called cookiejar__jar_history (called: ${names(o).join(", ") || "nothing"})`,
  },
];

/**
 * Run one case once and record what the model actually did.
 *
 * The gate is ON. When it fires, the requested calls are recorded as observed
 * (with `gated: true`) and the run ends there — the model has already made the
 * decision we're scoring, and stopping means the suite doesn't eat the jar on
 * every execution.
 */
export async function observeOnce(
  toolbox: Toolbox,
  prompt: string,
  effort: "low" | "medium" | "high" | "xhigh" | "max" = "medium",
): Promise<Observation> {
  const calls: ObservedCall[] = [];
  let finalText = "";
  let stopReason = "incomplete";
  let iterations = 0;

  for await (const event of runAgentLoop({
    messages: [{ role: "user", content: prompt }],
    toolbox,
    stream: false,
    effort,
    gate: true,
  })) {
    if (event.type === "iteration_start") iterations = event.iteration;

    if (event.type === "tool_call") {
      calls.push({
        name: event.name,
        args: (event.args ?? {}) as Record<string, unknown>,
        gated: false,
      });
    }

    if (event.type === "approval_required") {
      // Mark the calls this pause covers as gated, then stop.
      for (const pending of event.calls) {
        const existing = calls.find((c) => c.name === pending.name && !c.gated);
        if (existing && pending.requiresApproval) existing.gated = true;
      }
      stopReason = "approval_required";
      break;
    }

    if (event.type === "done") {
      finalText = event.finalText;
      stopReason = event.reason;
      break;
    }

    if (event.type === "error") {
      stopReason = "error";
      finalText = event.message;
      break;
    }
  }

  return { calls, finalText, stopReason, iterations };
}
