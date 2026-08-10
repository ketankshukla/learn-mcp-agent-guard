/**
 * ============================================================================
 *  lib/approval.ts  —  PHASE 2: what counts as dangerous, and who decides
 * ============================================================================
 *
 *  This file is thirty lines of actual logic and it is the most important file
 *  in the project. Read the reasoning, not just the code.
 *
 * ---------------------------------------------------------------------------
 *  THE ONE RULE
 * ---------------------------------------------------------------------------
 *
 *      A hint from the other side of a network boundary is not a
 *      permission model.
 *
 *  MCP servers can advertise `annotations: { destructiveHint: true }` on a
 *  tool. Our own server sets it honestly (see app/api/jar/route.ts). It is a
 *  genuinely useful signal — for a human skimming a tool list, or for a UI
 *  picking an icon.
 *
 *  This file does not read it. Not once. Not as a hint, not as a default, not
 *  as a tiebreaker.
 *
 *  Why: that flag arrives over HTTP from a machine you do not control, and it
 *  is set by whoever wrote that server. If your gate consults it, then any
 *  server that wants to bypass your gate bypasses your gate — it just sets
 *  `destructiveHint: false` and your host waves it through. You would have
 *  built a lock whose key is kept by the person outside the door.
 *
 *  The same reasoning kills every variant of the idea:
 *    - "trust it only for servers on my allowlist"  -> then trust the server,
 *      not the flag; the flag adds nothing and can only weaken it
 *    - "use it as a default and let me override"    -> a server can still opt
 *      a new tool OUT of your gate by shipping it with the hint unset
 *    - "warn if the hint disagrees with my list"    -> fine as telemetry,
 *      never as an input to the decision
 *
 *  So: an explicit allowlist, on the host side, written by you, defaulting to
 *  ALLOW for tools you have not classified.
 *
 * ---------------------------------------------------------------------------
 *  WAIT — DEFAULT TO *ALLOW*? ISN'T DEFAULT-DENY SAFER?
 * ---------------------------------------------------------------------------
 *
 *  Yes, and for a production system guarding real money or real infrastructure
 *  you should default to deny: unknown tool -> ask a human.
 *
 *  This project defaults to allow, deliberately, and it's worth being honest
 *  about the tradeoff rather than pretending it doesn't exist. A default-deny
 *  host prompts you for `roll_dice` and `say_hello`, you develop click-fatigue
 *  within about ninety seconds, and you start approving without reading. An
 *  approval gate that trains you to click "Approve" reflexively is worse than
 *  no gate at all, because it also gives you the feeling of having one.
 *
 *  Flipping this is one line — see DEFAULT_DECISION below — and the README
 *  argues for when you should.
 *
 * ---------------------------------------------------------------------------
 *  WHY RULES LOOK AT ARGUMENTS, NOT JUST NAMES
 * ---------------------------------------------------------------------------
 *
 *  `cookie_jar` is not dangerous. `cookie_jar { action: "eat" }` is.
 *
 *  A name-only gate forces you to choose between stopping the agent from
 *  *looking* in the jar and letting it *empty* the jar unasked. Real tools are
 *  the same shape: `sql` is fine for SELECT, `github` is fine for reading an
 *  issue, `stripe` is fine for fetching a customer. The verb lives in the
 *  arguments, so the gate has to read them.
 */

/** What the host decided to do with one requested tool call. */
export type GateDecision = "allow" | "ask";

export type GateVerdict = {
  decision: GateDecision;
  /**
   * Shown to the human in the approval card, so the pause never feels
   * arbitrary. "Why am I being asked?" should always have an answer.
   */
  reason?: string;
};

type Rule = {
  /** The namespaced tool name the model sees, e.g. "cookiejar__cookie_jar". */
  tool: string;
  /** Plain-English description of when this rule fires, for the docs and the UI. */
  when: string;
  /** Given the model's arguments, does this rule apply to this specific call? */
  matches: (args: Record<string, unknown>) => boolean;
  /** Shown to the human when it fires. */
  reason: string;
};

/**
 * Everything not matched by a rule below gets this. See the long note above
 * about why it is "allow" here and why you might want "ask".
 */
const DEFAULT_DECISION: GateDecision = "allow";

/**
 * ---------------------------------------------------------------------------
 *  THE LIST.
 * ---------------------------------------------------------------------------
 *
 *  Note what is NOT here: `cookiejar__jar_history`, `legacy__roll_dice`,
 *  `legacy__say_hello`, and both `secret_code` tools. Reading is free.
 *  Rolling dice is free. Nothing they do is hard to undo, so stopping to ask
 *  would be pure friction.
 */
const RULES: Rule[] = [
  {
    tool: "cookiejar__smash_jar",
    when: "always",
    matches: () => true,
    reason:
      "smash_jar permanently deletes every cookie AND erases the jar's entire history. There is no undo and no backup.",
  },
  {
    tool: "cookiejar__cookie_jar",
    when: 'action is "eat"',
    matches: (args) => args.action === "eat",
    reason:
      "Eating removes cookies from the jar. Cookies cannot be un-eaten, so a human should see the number first.",
  },
  {
    tool: "cookiejar__cookie_jar",
    when: 'action is "refill"',
    matches: (args) => args.action === "refill",
    reason:
      "Refill resets the jar to exactly 12 cookies. If the jar currently holds more than 12, this silently destroys the difference.",
  },
];

/**
 * THE GATE.
 *
 * Called for every tool the model asks for, before anything runs.
 *
 * `args` is whatever the model produced. It is untrusted, possibly
 * malformed, and typed as `unknown` on purpose — a rule that assumes a shape
 * and gets something else must not throw and take the whole run with it.
 */
export function classifyCall(toolName: string, args: unknown): GateVerdict {
  const safeArgs: Record<string, unknown> =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  for (const rule of RULES) {
    if (rule.tool !== toolName) continue;

    let hit = false;
    try {
      hit = rule.matches(safeArgs);
    } catch {
      // A rule that crashes on weird input must fail CLOSED. If we cannot tell
      // whether this call is dangerous, that is exactly when to ask a human.
      return {
        decision: "ask",
        reason: `Could not evaluate the safety rule for ${toolName}, so it is being treated as dangerous.`,
      };
    }

    if (hit) return { decision: "ask", reason: rule.reason };
  }

  return { decision: DEFAULT_DECISION };
}

/** True when at least one of these calls needs a human. */
export function anyRequiresApproval(
  calls: { name: string; args: unknown }[],
): boolean {
  return calls.some((call) => classifyCall(call.name, call.args).decision === "ask");
}

/** Human-readable rule table, for the checkpoint script and the UI. */
export function describeRules(): string {
  const lines = RULES.map(
    (rule) => `    ⏸  ${rule.tool.padEnd(28)} when ${rule.when}`,
  );
  return (
    `  Host-side rules (MCP's destructiveHint is deliberately ignored):\n` +
    lines.join("\n") +
    `\n    ▶  everything else            default: ${DEFAULT_DECISION}`
  );
}

/** The rules, as data, for rendering in the browser. Contains no secrets. */
export function ruleSummary(): { tool: string; when: string; reason: string }[] {
  return RULES.map((r) => ({ tool: r.tool, when: r.when, reason: r.reason }));
}

export { DEFAULT_DECISION };
