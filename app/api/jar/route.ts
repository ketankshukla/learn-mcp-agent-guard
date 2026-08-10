/**
 * ============================================================================
 *  app/api/jar/route.ts  —  THE COOKIE JAR THAT REMEMBERS
 * ============================================================================
 *
 * Project #1 shipped a cookie jar and confessed, in its own README, that the
 * jar was a lie:
 *
 *     let cookiesInJar = 12;   // "Memory in a serverless function is a
 *                              //  sandcastle." — project #1
 *
 * This is the same jar with the same tools and the same personality, backed by
 * Postgres. Same `tools/list` output, same `tools/call` shape. The model cannot
 * tell the difference — it calls `cookie_jar` and gets a number back. *How* the
 * cookies are stored was always the server's private business. That's the
 * lesson: swapping a variable for a database changed nothing about the
 * protocol.
 *
 * ---------------------------------------------------------------------------
 *  WHY THIS SERVER LIVES IN THIS REPO
 * ---------------------------------------------------------------------------
 *
 * Because this project is about tools that can *destroy* things, and you should
 * not learn that lesson by pointing an agent at somebody else's server. The
 * `smash_jar` tool below genuinely, permanently erases data. It exists so the
 * approval gate has something real to guard.
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ THE MOST IMPORTANT COMMENT IN THIS FILE
 * ---------------------------------------------------------------------------
 *
 * Look at `annotations: { destructiveHint: true }` on `smash_jar`.
 *
 * MCP lets a server advertise "this tool is destructive." It is genuinely
 * useful — for a human reading a tool list, or for a UI deciding what colour to
 * paint a button.
 *
 * It is NOT a permission model, and this project never treats it as one.
 *
 * That flag is a claim, sent over a network, by a machine you do not control.
 * A server that wanted to slip a destructive tool past your gate would simply
 * set `destructiveHint: false`. The host's answer to "may this run?" must come
 * from a list the *host* owns — see lib/approval.ts. The hint is set here
 * honestly, on purpose, precisely so you can watch the host ignore it and
 * decide for itself.
 *
 *     A hint from the other side of a network boundary is not a permission model.
 */

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { db } from "@/lib/db";

/** MCP's required return shape. `as const` keeps "text" from widening to string. */
function say(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const JAR_ID = "default";

/**
 * Make sure a jar row exists before we touch it.
 *
 * `on conflict do nothing` makes this safe to call from two requests at once —
 * the loser of the race does nothing instead of raising a duplicate-key error.
 */
async function ensureJar() {
  const sql = db();
  await sql`
    insert into jar_state (id, cookies) values (${JAR_ID}, 12)
    on conflict (id) do nothing
  `;
}

async function readJar(): Promise<number> {
  const sql = db();
  await ensureJar();
  const rows = (await sql`
    select cookies from jar_state where id = ${JAR_ID}
  `) as { cookies: number }[];
  return rows[0]?.cookies ?? 0;
}

/** Append to the jar's permanent history. This is what `smash_jar` destroys. */
async function logEvent(
  action: string,
  count: number | null,
  cookiesAfter: number,
  note?: string,
) {
  const sql = db();
  await sql`
    insert into jar_events (action, count, cookies_after, note)
    values (${action}, ${count}, ${cookiesAfter}, ${note ?? null})
  `;
}

const handler = createMcpHandler(
  (server) => {
    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     * TOOL #1: cookie_jar — project #1's tool, with a real memory.
     *
     * The description is deliberately explicit that this jar persists. Two
     * servers are connected to this host and both once had a `cookie_jar`;
     * the description is the only thing the model reads when choosing, so it
     * has to earn the pick on its own.
     * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
    server.registerTool(
      "cookie_jar",
      {
        title: "Cookie Jar (persistent)",
        description:
          "Look inside the cookie jar, put cookies in, eat cookies, or refill it. This is THE cookie jar for this app and its contents are stored in a real database, so the count is correct across machines and survives restarts. Use this for any question about how many cookies there are.",
        inputSchema: z.object({
          action: z
            .enum(["look", "add", "eat", "refill"])
            .describe("What to do with the jar."),
          count: z
            .number()
            .int()
            .min(1)
            .max(500)
            .default(1)
            .describe("How many cookies to add or eat. Ignored for look and refill."),
        }),
        annotations: {
          title: "Cookie Jar (persistent)",
          // Honest: `eat` and `refill` really do remove cookies. The host does
          // not read this field — see the header comment.
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ action, count }) => {
        const sql = db();
        await ensureJar();

        if (action === "look") {
          const cookies = await readJar();
          return say(`The jar has ${cookies} cookie(s) in it.`);
        }

        if (action === "add") {
          // ATOMIC. One statement reads and writes, so two people adding at the
          // same instant cannot lose one. This is the read-modify-write race
          // that a naive `select` then `update` would introduce, avoided by
          // never splitting them apart.
          const rows = (await sql`
            update jar_state
               set cookies = cookies + ${count}, updated_at = now()
             where id = ${JAR_ID}
             returning cookies
          `) as { cookies: number }[];
          const cookies = rows[0].cookies;
          await logEvent("add", count, cookies);
          return say(`Added ${count}. The jar now has ${cookies} cookie(s).`);
        }

        if (action === "eat") {
          // Also atomic, and note the `and cookies >= ${count}` guard. If there
          // aren't enough cookies the UPDATE matches zero rows and returns an
          // empty array — so the refusal below can never race with a concurrent
          // eat. The check and the write are the same statement.
          const rows = (await sql`
            update jar_state
               set cookies = cookies - ${count}, updated_at = now()
             where id = ${JAR_ID} and cookies >= ${count}
             returning cookies
          `) as { cookies: number }[];

          if (rows.length === 0) {
            // A good tool says NO clearly instead of doing something weird.
            // The model reads this sentence and can explain it, or adapt.
            const cookies = await readJar();
            return say(
              `Can't eat ${count} -- there are only ${cookies} cookie(s) in the jar. Nice try.`,
            );
          }

          const cookies = rows[0].cookies;
          await logEvent("eat", count, cookies);
          return say(`Nom nom. Ate ${count}. ${cookies} cookie(s) left.`);
        }

        // refill
        const rows = (await sql`
          update jar_state set cookies = 12, updated_at = now()
           where id = ${JAR_ID}
           returning cookies
        `) as { cookies: number }[];
        const cookies = rows[0].cookies;
        await logEvent("refill", null, cookies);
        return say(`Jar refilled to ${cookies} cookies. You're welcome.`);
      },
    );

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     * TOOL #2: smash_jar — THE TOOL THIS WHOLE PROJECT EXISTS FOR.
     *
     * Every previous tool in these three projects has been safe. Roll a die,
     * count some words, shift some letters — the worst case is a wrong answer.
     *
     * This one deletes data and cannot be undone. It's small and silly, but
     * structurally it is `DROP TABLE`, `rm -rf`, `refund_customer`,
     * `send_email_to_all_users`. The moment a tool like this is on the shelf,
     * "the model picks a tool and we run it" stops being an acceptable design.
     *
     * That is the entire argument for the approval gate, in one tool.
     * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
    server.registerTool(
      "smash_jar",
      {
        title: "Smash The Jar",
        description:
          "PERMANENTLY destroy the cookie jar: sets the cookie count to zero AND erases the jar's entire history of past events. This cannot be undone and there is no backup. Use only when the user explicitly asks to destroy, smash, wipe, reset from scratch, or erase the jar and its history.",
        inputSchema: z.object({
          confirm: z
            .literal("SMASH")
            .describe("Must be the exact string SMASH, as a deliberate speed bump."),
        }),
        annotations: {
          title: "Smash The Jar",
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async () => {
        const sql = db();
        await ensureJar();

        const before = await readJar();
        const counted = (await sql`select count(*)::int as n from jar_events`) as {
          n: number;
        }[];
        const historyRows = counted[0].n;

        // Two statements that must both happen or neither. Over HTTP there is
        // no interactive transaction, so they go as one atomic batch.
        await sql.transaction([
          sql`delete from jar_events`,
          sql`update jar_state set cookies = 0, updated_at = now() where id = ${JAR_ID}`,
        ]);

        await logEvent("smash", null, 0, `destroyed ${before} cookies and ${historyRows} history rows`);

        return say(
          `The jar is smashed. ${before} cookie(s) destroyed and ${historyRows} history entries erased. This cannot be undone.`,
        );
      },
    );

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     * TOOL #3: jar_history — proof, in the model's own words, that the
     * database is real. Read-only, so the gate lets it straight through.
     * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
    server.registerTool(
      "jar_history",
      {
        title: "Jar History",
        description:
          "Read the cookie jar's recorded history: what happened to it, in what order, and when. Use this when someone asks what has happened to the jar, what changed recently, or whether an earlier action was actually saved.",
        inputSchema: z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(10)
            .describe("How many of the most recent events to return."),
        }),
        annotations: {
          title: "Jar History",
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async ({ limit }) => {
        const sql = db();
        const rows = (await sql`
          select action, count, cookies_after, created_at
            from jar_events
           order by id desc
           limit ${limit}
        `) as {
          action: string;
          count: number | null;
          cookies_after: number;
          created_at: string;
        }[];

        if (rows.length === 0) {
          return say("The jar has no recorded history yet.");
        }

        const lines = rows.map((r) => {
          const when = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
          const amount = r.count === null ? "" : ` ${r.count}`;
          return `  ${when}  ${r.action}${amount} -> ${r.cookies_after} cookie(s)`;
        });

        return say(
          `The ${rows.length} most recent jar event(s), newest first:\n${lines.join("\n")}`,
        );
      },
    );

    /* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     * TOOL #4: secret_code — THE DELIBERATE COLLISION, kept from project #2.
     *
     * Project #1's live server also has a `secret_code`, and it does a Caesar
     * shift. This one does Atbash (A<->Z, B<->Y). Same name, two servers,
     * different behaviour — the collision that proves namespacing is load
     * bearing. The host rewrites them to `cookiejar__secret_code` and
     * `legacy__secret_code` so the model can pick deliberately instead of one
     * silently shadowing the other.
     * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
    server.registerTool(
      "secret_code",
      {
        title: "Atbash Cipher",
        description:
          "Scramble or unscramble text with the Atbash cipher, which mirrors the alphabet so A becomes Z, B becomes Y, and so on. Atbash is its own inverse, so the same call both encodes and decodes. Use this when someone asks specifically for Atbash or a mirror cipher.",
        inputSchema: z.object({
          text: z.string().min(1).max(500).describe("The message to mirror."),
        }),
        annotations: {
          title: "Atbash Cipher",
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async ({ text }) => {
        const mirrored = text.replace(/[a-z]/gi, (letter) => {
          const isUpper = letter === letter.toUpperCase();
          const base = isUpper ? 65 : 97;
          const position = letter.charCodeAt(0) - base;
          return String.fromCharCode(base + (25 - position));
        });
        return say(`Atbash: "${text}" <-> "${mirrored}"`);
      },
    );
  },
  {
    serverInfo: { name: "cookie-jar-durable", version: "1.0.0" },
    verboseLogs: true,
  },
);

/**
 * The door lock, carried over from project #2 stage 9.
 *
 * With `MCP_SHARED_TOKEN` unset this server runs open, so a fresh clone works
 * with zero setup. Set it and the door locks — and the HOST reads the same
 * variable server-side and sends it, so the app keeps working while an
 * anonymous request gets a 401.
 */
const SHARED_TOKEN = process.env.MCP_SHARED_TOKEN;

const authedHandler = SHARED_TOKEN
  ? withMcpAuth(
      handler,
      async (_req, bearerToken) => {
        if (!bearerToken || bearerToken !== SHARED_TOKEN) return undefined;
        return {
          token: bearerToken,
          scopes: ["mcp:tools"],
          clientId: "mcp-agent-guard-host",
        };
      },
      { required: true },
    )
  : handler;

// MCP's Streamable HTTP transport uses POST for messages, GET to open a stream,
// and DELETE to end a session. Next.js only invokes code exported under the
// HTTP method's own name, so the same handler is exported three times.
export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };

/** Node runtime: this route talks to Postgres and reads server-only env vars. */
export const runtime = "nodejs";
export const maxDuration = 60;
