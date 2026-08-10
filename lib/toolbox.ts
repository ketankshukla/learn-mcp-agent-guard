/**
 * ============================================================================
 *  lib/toolbox.ts  —  PHASE 5: one shelf, many servers
 * ============================================================================
 *
 * Connects to every configured MCP server, collects their tools, namespaces
 * them, and hands back a single combined toolbox plus a dispatcher that knows
 * which server each tool actually lives on.
 *
 * This is what makes the app a HOST rather than a client. From the agent
 * loop's point of view there is one flat list of tools; the fact that they
 * come from three different machines on three different domains is this
 * file's problem, not the loop's.
 *
 * ⚠️ SERVER-SIDE ONLY.
 */

import { McpConnection, mcpResultToText, type McpServerConfig } from "./mcp-client";
import {
  namespaceTools,
  parseToolName,
  resolveTool,
  type NamespacedTool,
} from "./tool-translation";

export type ServerStatus = {
  key: string;
  label: string;
  url: string;
  ok: boolean;
  toolCount: number;
  /** Tools this server offered that the host chose not to expose. */
  excluded?: string[];
  /** Populated when `ok` is false. */
  error?: string;
};

export type Toolbox = {
  /** Every tool from every server that answered, namespaced. */
  tools: NamespacedTool[];
  /** Per-server connection report — the UI shows this. */
  servers: ServerStatus[];
  /**
   * Run a namespaced tool call against whichever server owns it.
   * Never throws: a failure comes back as text with `isError`, because the
   * model can read text and recover, but it can't recover from an exception.
   */
  dispatch: (
    namespacedName: string,
    args: unknown,
  ) => Promise<{ text: string; isError: boolean }>;
};

/**
 * Connect to all servers and build the combined toolbox.
 *
 * Note `Promise.allSettled`, not `Promise.all`. If one server is down, the
 * host should still work with the others — an agent that refuses to do
 * anything because a single unrelated server is asleep is a bad agent. The
 * failure is recorded in `servers` and surfaced in the UI.
 */
export async function buildToolbox(configs: McpServerConfig[]): Promise<Toolbox> {
  const connections = new Map<string, McpConnection>();

  const results = await Promise.allSettled(
    configs.map(async (config) => {
      const conn = new McpConnection(config);
      const tools = await conn.listTools();
      connections.set(config.key, conn);
      return { config, tools };
    }),
  );

  const tools: NamespacedTool[] = [];
  const servers: ServerStatus[] = [];

  results.forEach((result, index) => {
    const config = configs[index];

    if (result.status === "fulfilled") {
      // The host curates. A server advertising a tool is an offer, not an
      // instruction — see the long comment in lib/servers.ts about why the
      // legacy server's `cookie_jar` is dropped here.
      const exclude = new Set(config.excludeTools ?? []);
      const offered = result.value.tools;
      const kept = offered.filter((tool) => !exclude.has(tool.name));
      const dropped = offered
        .filter((tool) => exclude.has(tool.name))
        .map((tool) => tool.name);

      const namespaced = namespaceTools(config.key, config.label, kept);
      tools.push(...namespaced);
      servers.push({
        key: config.key,
        label: config.label,
        url: config.url,
        ok: true,
        toolCount: namespaced.length,
        excluded: dropped.length > 0 ? dropped : undefined,
      });
    } else {
      servers.push({
        key: config.key,
        label: config.label,
        url: config.url,
        ok: false,
        toolCount: 0,
        error: (result.reason as Error)?.message ?? String(result.reason),
      });
    }
  });

  async function dispatch(namespacedName: string, args: unknown) {
    // 1. Which server does this belong to?
    const parsed = parseToolName(namespacedName);
    const entry = resolveTool(tools, namespacedName);

    if (!parsed || !entry) {
      // The model asked for a tool that doesn't exist. This genuinely happens
      // — usually a near-miss on the name. Telling it so, in plain English,
      // lets it correct itself on the next iteration.
      return {
        text: `No tool named "${namespacedName}" is connected. Available tools: ${tools
          .map((t) => t.namespacedName)
          .join(", ")}`,
        isError: true,
      };
    }

    const conn = connections.get(entry.serverKey);
    if (!conn) {
      return {
        text: `The server "${entry.serverLabel}" is not connected right now.`,
        isError: true,
      };
    }

    // 2. Call it under its ORIGINAL name. The server has never heard of our
    //    namespace prefix and would reject `cookiejar__roll_dice`.
    try {
      const result = await conn.callTool(entry.originalName, args);
      return { text: mcpResultToText(result), isError: Boolean(result.isError) };
    } catch (error) {
      // A transport-level failure (network, 401, 500). Hand it back as text
      // so the model can decide whether to try something else.
      return {
        text: `Calling ${namespacedName} failed: ${(error as Error).message}`,
        isError: true,
      };
    }
  }

  return { tools, servers, dispatch };
}
