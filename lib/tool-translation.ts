/**
 * ============================================================================
 *  lib/tool-translation.ts  —  PHASE 2: MCP schemas -> Claude tool definitions
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * MCP and the Claude API both describe tools with JSON Schema, so you'd expect
 * to pass one straight to the other. You almost can. The gap is small enough
 * to be invisible and large enough to break things quietly:
 *
 *   MCP says                          Claude API says
 *   ------------------------------    ------------------------------
 *   { name, description,              { name, description,
 *     inputSchema: {...} }              input_schema: {...} }
 *          ^^^^^^^^^^^                       ^^^^^^^^^^^^
 *          camelCase                         snake_case
 *
 * That single rename is the entire "translation layer" people warn you about.
 * Get it wrong and the API rejects the request with a message about a missing
 * field, and you stare at two schemas that look identical.
 *
 * THE OTHER HALF: NAMESPACING
 * ---------------------------
 * A host connects to several servers at once. Two of them can easily have a
 * tool called `search`, or `secret_code` (ours do — deliberately). The Claude
 * API sees one flat list of tool names; if two entries share a name, one wins
 * and the other silently disappears.
 *
 * So the host rewrites every name on the way out:
 *
 *     cookiejar / roll_dice     ->   cookiejar__roll_dice
 *     toolbox   / secret_code   ->   toolbox__secret_code
 *
 * ...and unrewrites it on the way back, so the right server gets the call.
 * The double underscore is the separator because Claude's tool names must
 * match ^[a-zA-Z0-9_-]{1,128}$ — no dots, no slashes, no colons.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { McpTool } from "./mcp-client";

/** The separator between server key and tool name. */
const NS = "__";

/**
 * An MCP tool that has been given a namespaced name and remembers where it
 * came from. This is the host's internal bookkeeping — the model only ever
 * sees `namespacedName`.
 */
export type NamespacedTool = {
  /** e.g. "cookiejar__roll_dice" — what the model calls it. */
  namespacedName: string;
  /** e.g. "roll_dice" — what the server calls it. */
  originalName: string;
  /** e.g. "cookiejar" — which server owns it. */
  serverKey: string;
  /** Human-friendly server name, for the UI. */
  serverLabel: string;
  /** The raw tool as the server described it. */
  tool: McpTool;
};

/** Build the namespaced name for a tool. */
export function namespaceToolName(serverKey: string, toolName: string): string {
  return `${serverKey}${NS}${toolName}`;
}

/**
 * Split a namespaced name back apart.
 *
 * Note `indexOf`, not `split`: a tool name could itself contain a double
 * underscore (`do__thing`), and only the FIRST separator is ours. Using
 * `split(NS)` would mangle it. This is the sort of bug that shows up once, in
 * production, on somebody else's server.
 */
export function parseToolName(
  namespacedName: string,
): { serverKey: string; toolName: string } | null {
  const index = namespacedName.indexOf(NS);
  if (index <= 0) return null;
  return {
    serverKey: namespacedName.slice(0, index),
    toolName: namespacedName.slice(index + NS.length),
  };
}

/**
 * THE TRANSLATION.
 *
 * Takes the tools from one server and returns them namespaced. The actual
 * shape change happens in `toClaudeTools` below; this step is just bookkeeping.
 */
export function namespaceTools(
  serverKey: string,
  serverLabel: string,
  tools: McpTool[],
): NamespacedTool[] {
  return tools.map((tool) => ({
    namespacedName: namespaceToolName(serverKey, tool.name),
    originalName: tool.name,
    serverKey,
    serverLabel,
    tool,
  }));
}

/**
 * Convert namespaced MCP tools into the exact shape `client.messages.create()`
 * wants in its `tools` array.
 *
 * Three things happen here, and each one matters:
 *
 *  1. `inputSchema` -> `input_schema`. The rename described at the top.
 *
 *  2. The schema is passed through nearly untouched. MCP servers built with
 *     Zod emit JSON Schema draft 2020-12 including a `$schema` key. The Claude
 *     API ignores unknown keys, so this works — but we strip `$schema` anyway
 *     because it's noise in every request and you pay tokens for noise.
 *
 *  3. A missing/empty schema becomes `{type:"object", properties:{}}`. The
 *     Claude API requires `input_schema` to be an object schema. A tool with
 *     no arguments is legal in MCP and will 400 here if you pass it through
 *     as `undefined`.
 */
export function toClaudeTools(tools: NamespacedTool[]): Anthropic.Tool[] {
  return tools.map((entry) => {
    const { $schema: _ignored, ...schema } = entry.tool.inputSchema ?? {};

    const inputSchema =
      schema && typeof schema === "object" && Object.keys(schema).length > 0
        ? schema
        : { type: "object", properties: {} };

    return {
      name: entry.namespacedName,
      /**
       * The description is the ONLY thing the model reads when deciding to
       * call this tool. We prefix the server label so that when two servers
       * offer similar tools, the model can tell them apart by more than a
       * name prefix — it gets a sentence of context too.
       */
      description: `[${entry.serverLabel}] ${entry.tool.description ?? entry.tool.title ?? entry.originalName}`,
      input_schema: inputSchema as Anthropic.Tool["input_schema"],
    };
  });
}

/**
 * Find which server a namespaced tool name belongs to.
 * Returns null for a name the model invented, which does happen — the loop
 * turns that into a readable tool_result rather than a crash.
 */
export function resolveTool(
  tools: NamespacedTool[],
  namespacedName: string,
): NamespacedTool | null {
  return tools.find((t) => t.namespacedName === namespacedName) ?? null;
}

/**
 * Report name collisions across servers. Not used by the loop — used by the
 * phase-2 checkpoint script and the UI, to make the invisible visible.
 */
export function findCollisions(tools: NamespacedTool[]): Map<string, NamespacedTool[]> {
  const byOriginalName = new Map<string, NamespacedTool[]>();
  for (const tool of tools) {
    const list = byOriginalName.get(tool.originalName) ?? [];
    list.push(tool);
    byOriginalName.set(tool.originalName, list);
  }
  // Keep only the names offered by more than one server.
  return new Map([...byOriginalName].filter(([, list]) => list.length > 1));
}
