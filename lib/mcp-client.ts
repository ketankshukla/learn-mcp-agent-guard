/**
 * ============================================================================
 *  lib/mcp-client.ts  —  PHASE 1: talking to an MCP server, by hand
 * ============================================================================
 *
 * WHAT THIS FILE IS
 * -----------------
 * A *client* for the Model Context Protocol. Project #1 built the other half:
 * a **server** that sits there and waits. This is the thing that knocks on its
 * door.
 *
 * The whole protocol is ordinary HTTP POSTs carrying JSON. There is no magic,
 * no SDK required, no websocket. If you can `fetch`, you can speak MCP.
 *
 * THE ANALOGY
 * -----------
 * The server is a vending machine. This file is the hand with the coins.
 *
 *   1. `initialize`  — "Hi, I speak MCP. What are you?"        (the handshake)
 *   2. `tools/list`  — "What have you got?"                    (read the menu)
 *   3. `tools/call`  — "B4, please, with these settings."       (press a button)
 *
 * That's it. Three messages. Everything else in this project is built on them.
 *
 * TWO THINGS THAT WILL BITE YOU (they bit project #1, and they bit this one)
 * -------------------------------------------------------------------------
 *  1. The `Accept` header must list BOTH `application/json` AND
 *     `text/event-stream`. Omit either and the server returns `406 Not
 *     Acceptable` with no explanation. The spec requires the *client* to
 *     declare it can cope with both reply shapes before the server will talk.
 *
 *  2. The reply may come back as plain JSON *or* as a Server-Sent Events
 *     stream (`event: message` / `data: {...}` lines). The same server can do
 *     either depending on the request. You must handle both. `JSON.parse()` on
 *     a raw SSE body throws a very confusing error.
 */

// ---------------------------------------------------------------------------
// Types — deliberately hand-written rather than imported from the MCP SDK.
//
// Why? Because the point of this file is that MCP is *just JSON*. If you can
// see the exact shape of the messages in TypeScript, the protocol stops being
// mysterious. Importing an SDK type would hide the very thing we're teaching.
// ---------------------------------------------------------------------------

/** A JSON Schema object, as it appears in an MCP `tools/list` response. */
export type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

/** One tool, exactly as an MCP server describes it. */
export type McpTool = {
  name: string;
  title?: string;
  /** The ONLY thing the model reads when deciding whether to use this tool. */
  description?: string;
  inputSchema: JsonSchema;
};

/** One piece of a tool's answer. Servers can return several. */
export type McpContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

/** What comes back from `tools/call`. */
export type McpToolResult = {
  content?: McpContentBlock[];
  /** True when the server is reporting a failure rather than an answer. */
  isError?: boolean;
  structuredContent?: unknown;
};

/** How to reach one MCP server. */
export type McpServerConfig = {
  /**
   * Short, stable key used to namespace this server's tools so two servers
   * can both have a tool called `search` without colliding. See lib/servers.ts.
   */
  key: string;
  /** Human-friendly name, shown in the UI. */
  label: string;
  /** The endpoint, e.g. https://example.vercel.app/api/mcp */
  url: string;
  /**
   * Optional shared bearer token. The HOST holds this — never the browser.
   * (See lib/servers.ts for where it comes from.)
   */
  bearerToken?: string;
  /**
   * Tool names (as the SERVER calls them, un-namespaced) that this host
   * refuses to put in front of the model, even though the server advertises
   * them. See the long comment in lib/servers.ts: a host curates its toolbox.
   */
  excludeTools?: string[];
};

// ---------------------------------------------------------------------------
// The one low-level function everything else is built on.
// ---------------------------------------------------------------------------

/**
 * A JSON-RPC 2.0 error, as returned in the `error` field of an MCP response.
 * We throw this rather than returning it so callers can't forget to check.
 */
export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly serverKey?: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/**
 * Read an MCP response body, whichever of the two shapes it arrived in.
 *
 * Plain JSON:
 *     {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * Server-Sent Events:
 *     event: message
 *     data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * SSE exists so a server can push progress updates during a slow tool call and
 * *then* send the result. That means the payload we want is the LAST `data:`
 * line, not the first — earlier ones may be progress notifications.
 */
function parseMcpBody(raw: string): unknown {
  const trimmed = raw.trim();

  // Not SSE framing? Then it's plain JSON. Easy path.
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return JSON.parse(trimmed);
  }

  // SSE. Strip the framing and keep the last data payload.
  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0);

  if (dataLines.length === 0) {
    throw new McpError(`MCP replied with an SSE stream containing no data lines: ${raw.slice(0, 200)}`);
  }

  return JSON.parse(dataLines[dataLines.length - 1]);
}

// ---------------------------------------------------------------------------
// The connection.
// ---------------------------------------------------------------------------

/**
 * A live conversation with one MCP server.
 *
 * Usage:
 *     const conn = new McpConnection({ key: "cookie-jar", label: "...", url: "..." });
 *     await conn.connect();          // handshake
 *     const tools = await conn.listTools();
 *     const result = await conn.callTool("roll_dice", { sides: 20, times: 3 });
 */
export class McpConnection {
  /**
   * Some MCP servers are *stateful*: they hand you a session id on
   * `initialize` and expect it echoed on every later request. Some are
   * *stateless* and never send one. You must handle both — hence `| undefined`
   * rather than a required field.
   */
  private sessionId: string | undefined;

  /** Monotonic JSON-RPC request id. Every request needs a unique one. */
  private nextId = 1;

  private connected = false;

  constructor(readonly config: McpServerConfig) {}

  /** Headers every request needs. */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // ⚠️ BOTH values. Drop either and you get a bare 406 with no hint why.
      Accept: "application/json, text/event-stream",
      // Servers use this to negotiate behaviour. Harmless if ignored.
      "MCP-Protocol-Version": "2025-06-18",
    };

    // Session id, only if the server gave us one.
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    // Phase 7: shared-secret auth. This runs SERVER-SIDE ONLY — the token
    // comes from an env var in a route handler and never reaches the browser.
    if (this.config.bearerToken) {
      headers["Authorization"] = `Bearer ${this.config.bearerToken}`;
    }

    return headers;
  }

  /**
   * Send one JSON-RPC request and return its `result`.
   * Throws McpError on a protocol-level failure.
   */
  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;

    const response = await fetch(this.config.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    // The session id arrives in a HEADER, not the body. Easy to miss.
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession) this.sessionId = returnedSession;

    const raw = await response.text();

    if (!response.ok) {
      // 401 here means the bearer token was wrong or missing (phase 7).
      // 406 means the Accept header was wrong (see above).
      throw new McpError(
        `${this.config.key}: HTTP ${response.status} from ${this.config.url} — ${raw.slice(0, 300)}`,
        response.status,
        this.config.key,
      );
    }

    const body = parseMcpBody(raw) as {
      result?: T;
      error?: { code: number; message: string };
    };

    if (body.error) {
      throw new McpError(
        `${this.config.key}: ${body.error.message}`,
        body.error.code,
        this.config.key,
      );
    }

    return body.result as T;
  }

  /**
   * Send a JSON-RPC *notification* — a message with no `id`, to which the
   * server sends no reply. Used for `notifications/initialized`.
   */
  private async notify(method: string, params?: unknown): Promise<void> {
    await fetch(this.config.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
  }

  /**
   * STEP 1 — the handshake.
   *
   * Two messages: `initialize` (a request, gets a reply) then
   * `notifications/initialized` (a notification, gets nothing). The second one
   * is the client saying "I got your reply, we're live."
   */
  async connect(): Promise<{ name: string; version: string }> {
    const result = await this.rpc<{
      protocolVersion: string;
      serverInfo: { name: string; version: string };
    }>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-agent-lab", version: "1.0.0" },
    });

    await this.notify("notifications/initialized");
    this.connected = true;

    return result.serverInfo;
  }

  /** STEP 2 — read the menu. */
  async listTools(): Promise<McpTool[]> {
    if (!this.connected) await this.connect();
    const result = await this.rpc<{ tools: McpTool[] }>("tools/list");
    return result.tools ?? [];
  }

  /**
   * STEP 3 — press a button.
   *
   * Note what does NOT happen here: we don't validate `args`. The server's
   * Zod schema does that for free and returns a readable error the model can
   * act on. Duplicating validation client-side would only let the two drift.
   */
  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    if (!this.connected) await this.connect();
    return this.rpc<McpToolResult>("tools/call", { name, arguments: args });
  }
}

/**
 * Flatten an MCP tool result into the plain string the Claude API wants back
 * as a `tool_result`.
 *
 * MCP returns `content: [{type:"text", text:"..."}, ...]` — a list of typed
 * parts, because a tool could return an image or embedded resource too. The
 * Claude API's `tool_result` block takes a string (or its own block list). For
 * a teaching project, joining the text parts is exactly right.
 */
export function mcpResultToText(result: McpToolResult): string {
  const parts = (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text ?? "" : `[${block.type}]`))
    .filter(Boolean);

  if (parts.length === 0) {
    // A tool that legitimately returns nothing still needs to say *something*,
    // or the model is left staring at an empty string wondering what happened.
    return result.isError ? "(tool reported an error with no message)" : "(no output)";
  }

  return parts.join("\n");
}
