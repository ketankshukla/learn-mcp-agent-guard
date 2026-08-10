/**
 * ============================================================================
 *  lib/agent-loop.ts  —  THE AGENT LOOP, NOW WITH A HANDBRAKE
 * ============================================================================
 *
 *  This is the file. Everything else in this repo is plumbing that exists so
 *  that this file can run. If you read one thing here, read this.
 *
 * ---------------------------------------------------------------------------
 *  WHAT PROJECT #3 ADDED, AND HOW LITTLE OF IT THERE IS
 * ---------------------------------------------------------------------------
 *
 *  Project #2's loop ran every tool the instant the model picked it. This
 *  version stops and asks first when the tool is dangerous. That sounds like a
 *  big change. It is about fifteen lines, in STEP 5 below, and the reason it's
 *  so small is worth understanding because it's the whole design:
 *
 *      The loop's entire state is the `messages` array.
 *
 *  There is no hidden memory. No session on Anthropic's side. Nothing in this
 *  generator's local variables that matters between iterations except that
 *  array. So "pause an agent mid-flight and resume it in a different HTTP
 *  request, on a different machine, five minutes later" reduces to:
 *
 *      1. stop the loop
 *      2. write `messages` to Postgres
 *      3. later: read it back, append the tool results, call the loop again
 *
 *  Step 3 needs NO new loop code. A conversation whose last message is a
 *  `user` turn full of `tool_result` blocks is just... a conversation. The
 *  resumed loop asks the model what to do next, exactly as it would have. It
 *  never learns that it was ever paused.
 *
 *  That is why this file has a `gate` and an `approval_required` event and
 *  nothing else. There is no continuation, no serialized generator, no
 *  coroutine library. The pause is a `return` and the resume is a function
 *  call with a bigger array.
 *
 * ---------------------------------------------------------------------------
 *  WHAT AN AGENT ACTUALLY IS
 * ---------------------------------------------------------------------------
 *
 *  An "AI agent" sounds like a thing. It isn't. It's a `while` loop.
 *
 *  Here is the whole idea, in the order it happens:
 *
 *      1. Send the conversation to the model, along with a list of tools.
 *      2. The model replies. Its reply either IS the answer, or it's a
 *         request: "please run roll_dice with these arguments."
 *      3. If it's a request: run the tool, paste the result into the
 *         conversation as if the user had said it, and GO BACK TO STEP 1.
 *      4. Otherwise, you're done.
 *
 *  That's it. That is the entire "agentic AI" pattern. Four steps, one loop.
 *
 * ---------------------------------------------------------------------------
 *  THE THING THAT MAKES IT FEEL LIKE MAGIC
 * ---------------------------------------------------------------------------
 *
 *  Ask it: "Roll 3d20, then put that many cookies in the jar."
 *
 *  Iteration 1  the model calls roll_dice(sides:20, times:3)
 *               -> the server rolls, returns "Rolled 3d20 -> [17,9,18] Total: 44"
 *               -> we paste that into the conversation
 *
 *  Iteration 2  the model reads its own tool's output, sees "44",
 *               and calls cookie_jar(action:"add", count:44)
 *
 *  Iteration 3  the model has both results and writes the sentence.
 *
 *  **Nobody wrote the wire from "44" to `count: 44`.** There is no code in
 *  this file that knows dice have anything to do with cookies. That behaviour
 *  is not programmed; it *emerges* from putting the tool's output back into
 *  the conversation and asking again. That is the whole lesson of this project.
 *
 * ---------------------------------------------------------------------------
 *  THREE RULES THAT WILL SAVE YOU
 * ---------------------------------------------------------------------------
 *
 *  1. APPEND THE WHOLE ASSISTANT REPLY, NOT JUST THE TEXT.
 *     `response.content` is a list of blocks: text, thinking, tool_use. If you
 *     extract the text and append a string, you throw away the `tool_use`
 *     block — and then your `tool_result` refers to an id the API has never
 *     seen. It rejects the request with a message about a mismatched
 *     tool_use_id and you will spend an hour on it.
 *
 *  2. ALL TOOL RESULTS GO IN ONE USER MESSAGE.
 *     If the model asks for three tools at once, send back one user message
 *     containing three `tool_result` blocks. Splitting them across three
 *     messages technically works, but it quietly teaches the model to stop
 *     asking for tools in parallel, and everything gets slower.
 *
 *  3. CAP THE LOOP. HARD.
 *     Every iteration is a full API call with a conversation that keeps
 *     growing. A loop with a bug is not a hang — it's a bill. MAX_ITERATIONS
 *     below is a seatbelt, and the token counters exist so you can watch the
 *     meter run.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Toolbox } from "./toolbox";
import { toClaudeTools } from "./tool-translation";
import { classifyCall } from "./approval";

// ---------------------------------------------------------------------------
// The seatbelts.
// ---------------------------------------------------------------------------

/**
 * The hard ceiling. Ten round trips is far more than the cookie demo needs
 * (it takes three) and still bounded enough that a runaway loop costs cents,
 * not rent. If you hit this, something is wrong — the loop tells you so
 * rather than quietly stopping.
 */
export const MAX_ITERATIONS = 10;

/**
 * Room for thinking plus the answer. Note that with adaptive thinking on,
 * `max_tokens` is a ceiling on thinking AND response text together — set it
 * too tight and you get a truncated answer with `stop_reason: "max_tokens"`.
 */
const MAX_TOKENS = 8000;

/**
 * The model. Chosen deliberately: a single user message can trigger three to
 * five API calls, each with a bigger conversation than the last, so per-call
 * cost compounds fast. Sonnet 5 is the sweet spot for a tool-calling loop.
 * Swapping this one string is the only change needed to try another model.
 *
 * Kept identical to project #2 on purpose. The eval suite in lib/evals.ts
 * scores this host's tool choices, and a score is only comparable against
 * another score from the same model. Change this string and every stored
 * eval result becomes a historical curiosity rather than a baseline.
 */
export const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You are the brain of an MCP host application — a chat app that connects to Model Context Protocol servers and can actually run their tools.

You have real tools connected from multiple servers. Tool names are namespaced as <server>__<tool> so that two servers can offer a tool with the same name without clashing.

How to work:
- When a request needs real data, real randomness, real arithmetic, or real state, call the tool. Do not guess, estimate, or simulate a result in your head. A made-up dice roll is worse than no answer.
- When a task has several steps, work through them one at a time. Use the output of an earlier tool call as the input to a later one.
- Call tools in parallel when the calls are genuinely independent of each other.
- When you are done, answer in plain, friendly language. Report what the tools actually returned — never round, adjust, or improve on a number a tool gave you.`;

// ---------------------------------------------------------------------------
// Events.
//
// The loop is an async generator: it *yields* a stream of small events as it
// goes rather than returning one lump at the end. That single decision is what
// makes both a live terminal trace and a live browser trace possible from the
// exact same loop code — the terminal script prints the events, the route
// handler forwards them to the browser as SSE.
// ---------------------------------------------------------------------------

export type TokenUsage = {
  /** Tokens processed at FULL price — the uncached remainder. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the cache this call (~1.25x price). Expect these on iteration 1. */
  cacheWriteTokens: number;
  /** Tokens served FROM the cache this call (~0.1x price). Expect these from iteration 2 on. */
  cacheReadTokens: number;
};

export type LoopEvent =
  /** Which MCP servers answered, and with how many tools. Fired once, first. */
  | { type: "servers"; servers: Toolbox["servers"]; toolCount: number }
  /** A new trip around the loop is starting. */
  | { type: "iteration_start"; iteration: number }
  /** A summarized chunk of the model's reasoning. */
  | { type: "thinking"; text: string }
  /** A chunk of the model's user-facing answer. */
  | { type: "text"; text: string }
  /** The model has asked for a tool. Fired BEFORE the tool runs. */
  | {
      type: "tool_call";
      id: string;
      name: string;
      serverLabel: string;
      args: unknown;
      iteration: number;
    }
  /** The tool has returned. */
  | {
      type: "tool_result";
      id: string;
      name: string;
      text: string;
      isError: boolean;
      ms: number;
    }
  /** Token cost for one iteration, plus the running total. Your meter. */
  | { type: "usage"; iteration: number; iterationUsage: TokenUsage; totalUsage: TokenUsage }
  /**
   * ⏸ THE HANDBRAKE. The model asked for at least one tool the host will not
   * run without a human. NOTHING in this iteration has been executed — not
   * even the safe calls alongside it. The loop stops here.
   *
   * `messages` is the loop's entire state at the moment it stopped. The route
   * handler writes it to Postgres and ends the HTTP request; /api/resume reads
   * it back, appends the results, and calls the loop again. It is deliberately
   * NOT forwarded to the browser — see app/api/chat/route.ts.
   */
  | {
      type: "approval_required";
      iteration: number;
      calls: PendingCall[];
      messages: Anthropic.MessageParam[];
      totalUsage: TokenUsage;
    }
  /** Why the loop ended. */
  | {
      type: "done";
      reason: "end_turn" | "max_iterations" | "max_tokens" | "refusal" | "other";
      detail?: string;
      iterations: number;
      totalUsage: TokenUsage;
      /** Final state, so the caller can persist it for the next turn. Not sent to the browser. */
      messages: Anthropic.MessageParam[];
      finalText: string;
    }
  /** Something went wrong that the loop could not recover from. */
  | { type: "error"; message: string };

/**
 * One tool call frozen mid-flight, waiting on a human.
 *
 * Note `requiresApproval` is per-call. If the model asks for three tools and
 * only one is dangerous, all three wait — but the UI only puts buttons on the
 * one that needs them, and on resume the other two just run.
 */
export type PendingCall = {
  id: string;
  name: string;
  serverLabel: string;
  args: unknown;
  requiresApproval: boolean;
  /** Why the host stopped, in plain English. Shown to the human. */
  reason?: string;
};

export type RunOptions = {
  /** The whole conversation so far. The API is stateless — you resend it every time. */
  messages: Anthropic.MessageParam[];
  toolbox: Toolbox;
  /**
   * Stream the model's text token-by-token?
   *
   * Phase 3 (terminal) runs this false: get the loop CORRECT before making it
   * pretty. Phase 4 (the chat UI) runs it true. The loop logic below is
   * identical either way — only how we obtain `response` differs.
   */
  stream?: boolean;
  /**
   * How hard the model should think. Lower = cheaper and faster; higher = more
   * willing to reach for tools and reason through multi-step tasks.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  apiKey?: string;
  /**
   * Should the approval gate run at all?
   *
   * True everywhere in the app. The eval harness sets it false for cases that
   * only care about *which* tool the model picked, and the terminal demo lets
   * you flip it to watch the difference between project #2's behaviour and
   * this one. Turning it off is a way to SEE the gate, not a way to skip it.
   */
  gate?: boolean;
  /**
   * Iterations already spent before this call, on a resumed run.
   *
   * ⚠️ Without this, MAX_ITERATIONS resets to zero on every resume — and a
   * seatbelt that unbuckles itself each time you stop the car is not a
   * seatbelt. A run that pauses for approval nine times would get nine fresh
   * budgets of ten iterations each.
   */
  iterationOffset?: number;
};

// ---------------------------------------------------------------------------
// THE LOOP.
// ---------------------------------------------------------------------------

export async function* runAgentLoop(
  options: RunOptions,
): AsyncGenerator<LoopEvent, void, void> {
  const {
    toolbox,
    stream = false,
    effort = "medium",
    gate = true,
    iterationOffset = 0,
  } = options;

  // The API key is read here, server-side. If this line ever executes in a
  // browser, the key is public and stolen. That's why this module is only ever
  // imported from a route handler or a terminal script.
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    yield {
      type: "error",
      message:
        "ANTHROPIC_API_KEY is not set. Put it in .env.local (which is gitignored) — never in a component.",
    };
    return;
  }

  const client = new Anthropic({ apiKey });

  // Translate the MCP tools into Claude's shape. Done once, outside the loop:
  // the tool list is identical on every iteration, and keeping it byte-stable
  // is also what lets prompt caching work.
  const claudeTools = toClaudeTools(toolbox.tools);

  yield { type: "servers", servers: toolbox.servers, toolCount: claudeTools.length };

  // `messages` is the entire state of the agent. There is no hidden memory,
  // no session on Anthropic's side. Everything the model knows about this
  // task is in this array, and we resend all of it every single iteration.
  // (That is also why cost grows with each trip around the loop.)
  const messages: Anthropic.MessageParam[] = [...options.messages];

  const totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  // Starts above zero on a resumed run, so the ten-iteration seatbelt covers
  // the WHOLE conversation rather than resetting at every approval pause.
  let iteration = iterationOffset;

  /** Accumulated user-facing text, so the caller can persist the final answer. */
  let finalText = "";

  while (iteration < MAX_ITERATIONS) {
    iteration += 1;
    // Reset per iteration: the answer we persist is the LAST thing the model
    // said, not a concatenation of every "let me just check..." along the way.
    finalText = "";
    yield { type: "iteration_start", iteration };

    // -------------------------------------------------------------------
    // STEP 1 — ask the model.
    // -------------------------------------------------------------------
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      /**
       * PROMPT CACHING — the single biggest cost lever in an agent loop.
       *
       * Look at what we resend on every trip around this loop: the same system
       * prompt and the same 8 tool definitions, byte for byte, ~2,300 tokens
       * of it. Without caching you pay full price for those tokens on
       * iteration 1, again on iteration 2, again on iteration 3.
       *
       * Caching is a PREFIX match, and the API renders the request in this
       * order:
       *
       *     tools  ->  system  ->  messages
       *
       * So one breakpoint on the last system block covers BOTH the tools and
       * the system prompt — everything before the conversation itself. The
       * messages keep growing after it, which is exactly what you want: the
       * stable part is cached, the volatile part isn't.
       *
       * The economics work inside a single user message. A cache write costs
       * ~1.25x and a read costs ~0.1x, so break-even is two requests — and
       * this loop makes three API calls in about ten seconds.
       *
       * ⚠️ The prefix must be byte-identical to hit. That's why the tool list
       * is built once outside the loop, and why `effort` and the system prompt
       * are constants rather than per-request strings. Interpolate a timestamp
       * into SYSTEM_PROMPT and every hit silently becomes a miss — no error,
       * just a bigger bill. Watch `cacheReadTokens` in the trace to confirm.
       *
       * (Minimum cacheable prefix on this model is 1024 tokens. Below that it
       * silently won't cache — no error, `cache_creation_input_tokens: 0`.)
       */
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: claudeTools,
      messages,
      // Adaptive thinking: the model decides how much to think per request.
      // `display: "summarized"` is an explicit opt-in — the default is
      // "omitted", which streams thinking blocks whose text is empty. If you
      // want to SHOW reasoning (we do, in the trace), you must ask for it.
      thinking: { type: "adaptive", display: "summarized" },
      // The cost/quality dial. Not a token budget — a spend hint.
      output_config: { effort },
    };

    let response: Anthropic.Message;

    try {
      if (stream) {
        // ---- streaming path (phase 4) --------------------------------
        // Text arrives token by token so the UI can render as it goes. The
        // SDK accumulates the full message for us; `finalMessage()` gives the
        // same object the non-streaming call would have returned, so the loop
        // logic below doesn't change at all.
        const streamHandle = client.messages.stream(request);

        for await (const event of streamHandle) {
          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              finalText += event.delta.text;
              yield { type: "text", text: event.delta.text };
            } else if (event.delta.type === "thinking_delta") {
              yield { type: "thinking", text: event.delta.thinking };
            }
            // `input_json_delta` (the tool arguments being typed out) is
            // deliberately ignored: partial JSON isn't parseable, and we show
            // the arguments once they're complete, below.
          }
        }

        response = await streamHandle.finalMessage();
      } else {
        // ---- non-streaming path (phase 3) ----------------------------
        // One request, one complete reply. Nothing to reassemble. This is the
        // version to build first — if the loop is wrong, you want to find out
        // without streaming in the way.
        response = await client.messages.create(request);

        for (const block of response.content) {
          if (block.type === "text") {
            finalText += block.text;
            yield { type: "text", text: block.text };
          }
          if (block.type === "thinking") yield { type: "thinking", text: block.thinking };
        }
      }
    } catch (error) {
      yield { type: "error", message: `Claude API error: ${(error as Error).message}` };
      return;
    }

    // -------------------------------------------------------------------
    // STEP 2 — the meter.
    // -------------------------------------------------------------------
    // NOTE: `input_tokens` is the UNCACHED remainder only. The true prompt
    // size is input + cache_creation + cache_read. Once caching is on,
    // `input_tokens` dropping is the point, not a measurement error.
    const iterationUsage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    totalUsage.inputTokens += iterationUsage.inputTokens;
    totalUsage.outputTokens += iterationUsage.outputTokens;
    totalUsage.cacheWriteTokens += iterationUsage.cacheWriteTokens;
    totalUsage.cacheReadTokens += iterationUsage.cacheReadTokens;

    yield { type: "usage", iteration, iterationUsage, totalUsage };

    // -------------------------------------------------------------------
    // STEP 3 — RULE 1: append the WHOLE reply.
    //
    // Not `response.content.find(b => b.type === "text").text`. The whole
    // array. It carries the tool_use blocks (and the thinking blocks, which
    // must be passed back unchanged) that the next request depends on.
    // -------------------------------------------------------------------
    messages.push({ role: "assistant", content: response.content });

    // -------------------------------------------------------------------
    // STEP 4 — why did the model stop?
    //
    // `stop_reason` is the loop's exit condition. Handling it explicitly is
    // the difference between a loop that terminates and a loop that spins.
    // -------------------------------------------------------------------
    if (response.stop_reason !== "tool_use") {
      switch (response.stop_reason) {
        case "end_turn":
          // The normal, happy ending: the model is finished talking.
          yield {
            type: "done",
            reason: "end_turn",
            iterations: iteration,
            totalUsage,
            messages,
            finalText,
          };
          return;

        case "max_tokens":
          // The answer got cut off mid-sentence. Raising MAX_TOKENS is the fix.
          yield {
            type: "done",
            reason: "max_tokens",
            detail: `Ran out of output tokens (limit ${MAX_TOKENS}). The answer above is incomplete.`,
            iterations: iteration,
            totalUsage,
            messages,
            finalText,
          };
          return;

        case "refusal":
          yield {
            type: "done",
            reason: "refusal",
            detail: "The model declined this request.",
            iterations: iteration,
            totalUsage,
            messages,
            finalText,
          };
          return;

        case "pause_turn":
          // Server-side tooling paused mid-turn. Resending the conversation
          // resumes it. We've already appended the assistant turn, so just
          // continue the loop.
          continue;

        default:
          yield {
            type: "done",
            reason: "other",
            detail: `Stopped with stop_reason "${response.stop_reason}".`,
            iterations: iteration,
            totalUsage,
            messages,
            finalText,
          };
          return;
      }
    }

    // -------------------------------------------------------------------
    // STEP 5 — the model wants tools. Run them.
    // -------------------------------------------------------------------
    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    // Announce every call BEFORE running any, so the trace shows what was
    // requested even if a tool then hangs or fails.
    for (const toolUse of toolUses) {
      const entry = toolbox.tools.find((t) => t.namespacedName === toolUse.name);
      yield {
        type: "tool_call",
        id: toolUse.id,
        name: toolUse.name,
        serverLabel: entry?.serverLabel ?? "unknown server",
        args: toolUse.input,
        iteration,
      };
    }

    // -------------------------------------------------------------------
    // ⏸ STEP 5a — THE GATE. This is project #3, in one block.
    //
    // Everything above this point is project #2 unchanged: the model asked
    // for some tools and we announced them. Everything below is project #2
    // unchanged too: run them and paste the results back.
    //
    // This is the seam. The single place where "the model picked a tool" and
    // "the tool ran" stop being the same event.
    //
    // Two decisions worth defending:
    //
    // 1. We classify with `classifyCall`, which reads a list WE own. The
    //    server's own `destructiveHint` annotation is never consulted. See
    //    the top of lib/approval.ts for why that is not paranoia.
    //
    // 2. If ANY call in this batch needs a human, we execute NOTHING — not
    //    even the obviously-safe ones sitting next to it. It would be faster
    //    to run the safe calls now and only hold the dangerous one. It would
    //    also mean that hitting "Deny" leaves you in a world where half the
    //    batch already happened, which is a much harder thing to reason about
    //    and to explain. All-or-nothing is worth the lost milliseconds.
    // -------------------------------------------------------------------
    if (gate) {
      const pending: PendingCall[] = toolUses.map((toolUse) => {
        const entry = toolbox.tools.find((t) => t.namespacedName === toolUse.name);
        const verdict = classifyCall(toolUse.name, toolUse.input);
        return {
          id: toolUse.id,
          name: toolUse.name,
          serverLabel: entry?.serverLabel ?? "unknown server",
          args: toolUse.input,
          requiresApproval: verdict.decision === "ask",
          reason: verdict.reason,
        };
      });

      if (pending.some((call) => call.requiresApproval)) {
        // Stop. `messages` already contains the assistant turn with these
        // tool_use blocks in it (STEP 3 pushed it), which is exactly the state
        // the resume needs: append tool_results to this array and the
        // conversation is valid again.
        yield {
          type: "approval_required",
          iteration,
          calls: pending,
          messages,
          totalUsage,
        };
        return;
      }
    }

    // Run them concurrently. The model asked for them in one message, which
    // means it considers them independent — so making them wait in line would
    // just be slower for no reason.
    const toolResults = await Promise.all(
      toolUses.map(async (toolUse) => {
        const startedAt = Date.now();
        const result = await toolbox.dispatch(toolUse.name, toolUse.input);
        return { toolUse, result, ms: Date.now() - startedAt };
      }),
    );

    for (const { toolUse, result, ms } of toolResults) {
      yield {
        type: "tool_result",
        id: toolUse.id,
        name: toolUse.name,
        text: result.text,
        isError: result.isError,
        ms,
      };
    }

    // -------------------------------------------------------------------
    // STEP 6 — RULE 2: paste all the results back as ONE user message.
    //
    // `tool_use_id` is the thread connecting a result to the request that
    // asked for it. Every tool_use block from the assistant turn must get
    // exactly one matching tool_result here, or the API rejects the request.
    //
    // And this line — this unremarkable `messages.push` — is where the magic
    // in the header comment actually happens. The dice total is now part of
    // the conversation. Next time around the loop, the model reads it like
    // any other message and can use it as an argument.
    // -------------------------------------------------------------------
    messages.push({
      role: "user",
      content: toolResults.map(({ toolUse, result }) => ({
        type: "tool_result" as const,
        tool_use_id: toolUse.id,
        content: result.text,
        // `is_error: true` tells the model this was a failure, so it can try
        // something else instead of confidently repeating the answer.
        is_error: result.isError,
      })),
    });

    // ...and around we go.
  }

  // -------------------------------------------------------------------
  // The seatbelt engaged. We only get here by running out of iterations,
  // which means the model kept asking for tools ten times in a row. That's
  // a bug (or a genuinely enormous task), and stopping loudly beats
  // spending money quietly.
  // -------------------------------------------------------------------
  yield {
    type: "done",
    reason: "max_iterations",
    detail: `Hit the ${MAX_ITERATIONS}-iteration cap without the model finishing. Stopped deliberately.`,
    iterations: iteration,
    totalUsage,
    messages,
    finalText,
  };
}

/**
 * ---------------------------------------------------------------------------
 *  THE OTHER HALF OF THE HANDBRAKE: turning human decisions into tool results.
 * ---------------------------------------------------------------------------
 *
 *  This is the only genuinely new logic the resume path needs, and notice what
 *  it produces: an ordinary `user` message full of ordinary `tool_result`
 *  blocks. Nothing about it says "this run was paused." The model resumes a
 *  conversation, not a suspended process.
 *
 *  ⚠️ THE DENY BRANCH IS THE SUBTLE ONE.
 *
 *  A denied tool must still produce a `tool_result` with the matching
 *  `tool_use_id`. Every `tool_use` block in the assistant turn needs exactly
 *  one result or the API rejects the whole request. So "deny" cannot mean
 *  "send nothing" — it means "send a result that says no."
 *
 *  And the wording of that result matters more than it looks. Say only
 *  "denied" and the model very reasonably tries the same call again, which
 *  gets denied again, which is how you burn ten iterations and a lot of money
 *  discovering that you wrote a bad sentence. The text below explicitly tells
 *  it not to retry and asks it to explain what it would have done instead —
 *  which is what turns a refusal into a useful answer rather than a dead end.
 */
export async function resolvePendingCalls(
  toolbox: Toolbox,
  pending: PendingCall[],
  decisions: Record<string, "approved" | "denied">,
): Promise<{
  results: {
    id: string;
    name: string;
    text: string;
    isError: boolean;
    ms: number;
    denied: boolean;
  }[];
}> {
  const results = await Promise.all(
    pending.map(async (call) => {
      // A call that never needed approval just runs. A call that needed it
      // runs only on an explicit "approved" — anything else (denied, or a
      // decision that never arrived) is treated as a no. Fail closed.
      const decision = decisions[call.id];
      const approved = !call.requiresApproval || decision === "approved";

      if (!approved) {
        return {
          id: call.id,
          name: call.name,
          text:
            `The human operator reviewed this exact call and DENIED it. ` +
            `The tool was not run and nothing changed. ` +
            `Do not attempt this call again. ` +
            `Tell the user plainly that the action was declined, and explain what you would have done or what you can do instead.`,
          // `is_error: true` so the model treats it as a failed path to route
          // around, not as a result to report as if it had succeeded.
          isError: true,
          ms: 0,
          denied: true,
        };
      }

      const startedAt = Date.now();
      const result = await toolbox.dispatch(call.name, call.args);
      return {
        id: call.id,
        name: call.name,
        text: result.text,
        isError: result.isError,
        ms: Date.now() - startedAt,
        denied: false,
      };
    }),
  );

  return { results };
}

/**
 * Build the single `user` message that carries every tool result back.
 *
 * RULE 2 from project #2, unchanged: one message, N blocks. Splitting them
 * across N messages technically works and quietly teaches the model to stop
 * requesting tools in parallel.
 */
export function toolResultMessage(
  results: { id: string; text: string; isError: boolean }[],
): Anthropic.MessageParam {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result" as const,
      tool_use_id: r.id,
      content: r.text,
      is_error: r.isError,
    })),
  };
}
