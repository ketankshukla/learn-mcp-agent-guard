/**
 * ============================================================================
 *  lib/servers.ts  —  which MCP servers this host connects to, and which of
 *                     their tools it is willing to hand the model
 * ============================================================================
 *
 * ⚠️ SERVER-SIDE ONLY. Reads environment variables and holds a bearer token.
 * Never import this from a component that ships to the browser.
 */

import type { McpServerConfig } from "./mcp-client";

/**
 * Where this app is running. Needed because one of our MCP servers lives inside
 * this very app, so the host has to call itself over HTTP.
 *
 * ⚠️ THE ORDER OF THESE LINES IS LOAD-BEARING, and it cost project #2 a real
 * production bug that survived a clean typecheck, a clean build, a green
 * deployment, and a working demo.
 *
 * Vercel gives you two hostnames:
 *
 *   VERCEL_URL                     -> my-app-c6ssfjjub-team.vercel.app
 *                                     the PER-DEPLOYMENT hostname. Deployment
 *                                     Protection guards it, so an
 *                                     unauthenticated request gets 401.
 *
 *   VERCEL_PROJECT_PRODUCTION_URL  -> my-app.vercel.app
 *                                     the stable public alias. Not protected.
 *
 * Use VERCEL_URL here and the host calls itself through a locked door: our own
 * server drops out of the toolbox, and the model quietly runs with half its
 * tools. Nothing turns red. You just have fewer capabilities than you think.
 */
export function selfBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  // Last resort. Works only where Deployment Protection is off.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * The shelf.
 *
 * ---------------------------------------------------------------------------
 *  ON `excludeTools` — A HOST IS ALLOWED TO SAY NO
 * ---------------------------------------------------------------------------
 *
 * Project #1's live server offers a `cookie_jar` tool. So does ours. They have
 * the same name, take the same arguments, and answer in the same shape — but
 * project #1's forgets, because its jar is a variable in memory.
 *
 * Namespacing (project #2's lesson) means both can be *connected* without one
 * silently shadowing the other: the model would see `legacy__cookie_jar` and
 * `cookiejar__cookie_jar`. So the collision is survivable. But "survivable"
 * isn't the goal here — the model would have to guess which jar you meant on
 * every single request, and it would sometimes guess wrong. Half your cookies
 * would go into a jar that forgets them.
 *
 * So the host doesn't offer the choice. It connects to project #1 for the tools
 * only project #1 has, and drops the one that would be ambiguous.
 *
 * That is a genuine job of a host, and it's worth naming: **a host curates the
 * toolbox.** It is not a dumb pipe that forwards whatever a server advertises.
 * The same mechanism is what you'd use to keep an experimental tool away from
 * production, or to withhold a tool from a user who shouldn't have it. It is
 * also the mildest form of the idea this whole project is about — the host,
 * not the server, decides what the model is allowed to reach.
 */
export function getServerConfigs(): McpServerConfig[] {
  return [
    {
      key: "cookiejar",
      label: "Cookie Jar (this repo, durable)",
      url: process.env.JAR_MCP_URL ?? `${selfBaseUrl()}/api/jar`,
      /**
       * The shared bearer token. The HOST holds it; the browser never sees it.
       * Unset in development, so a fresh clone needs no setup.
       */
      bearerToken: process.env.MCP_SHARED_TOKEN,
    },
    {
      key: "legacy",
      label: "Cookie Jar (project #1, forgetful)",
      url:
        process.env.LEGACY_MCP_URL ??
        "https://learn-mcp-5-year-old.vercel.app/api/mcp",
      // See the long comment above. Everything else project #1 offers —
      // roll_dice, say_hello, secret_code — is genuinely useful and unique.
      excludeTools: ["cookie_jar"],
    },
  ];
}
