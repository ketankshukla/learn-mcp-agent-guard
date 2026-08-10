You are an expert at teaching AI engineering to beginners, and you are about to build my third MCP project with me. Teach me like I'm five — plain language, concrete analogies, no jargon without explaining it first — but write code like a senior engineer.

## Read this first, before anything else

My first two projects:

1. **https://github.com/ketankshukla/learn-mcp-5-year-old** — an MCP **server**
2. **https://github.com/ketankshukla/learn-mcp-agent-loop** — an MCP **host** that owns the agent loop

Clone both into a temp folder (or fetch the raw files) and read these, in this order:

| File | Repo | Why |
|---|---|---|
| `README.md` | #2 | The teaching voice, the Mermaid conventions, and the agent loop you're extending |
| `lib/agent-loop.ts` | #2 | **The file this project builds on.** Read every comment. |
| `BUILD_FROM_SCRATCH.md` | #2 | Especially **Appendix A** — seven real failures. Do not repeat them. |
| `NEXT_STEP.md` | #2 | The plan for this project and the four decisions already settled |
| `README.md` | #1 | Where the cookie jar came from, and the in-memory-state lie this project finally fixes |

Project #2 is a working, deployed MCP host. **This project extends it — you are not starting from scratch.** Copy its `lib/` wholesale and build on top. Treat it as a sequel that reuses the same sets and cast.

## Set up permissions FIRST, before you write any code

Do not ask me to approve things one at a time. Before your first build command, write a broad allowlist to **`.claude/settings.json`** (the project file — **not** `settings.local.json`, which the harness overwrites after every approval, wiping anything you put there):

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "PowerShell(node:*)", "PowerShell(npm:*)", "PowerShell(npx:*)",
      "PowerShell(git:*)", "PowerShell(gh:*)", "PowerShell(Get-ChildItem:*)",
      "PowerShell(Test-Path:*)", "PowerShell(New-Item:*)", "PowerShell(Remove-Item:*)",
      "PowerShell(Get-Content:*)", "PowerShell(Select-String:*)", "PowerShell(Start-Sleep:*)",
      "PowerShell(Set-Content:*)", "PowerShell(Copy-Item:*)", "PowerShell(Get-NetTCPConnection:*)",
      "PowerShell(taskkill:*)", "PowerShell(vercel:*)",
      "Bash(node:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(git:*)",
      "Bash(gh:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(curl:*)",
      "Bash(grep:*)", "Bash(mkdir:*)", "Bash(cp:*)", "Bash(vercel:*)"
    ]
  }
}
```

Add `Read`/`Write`/`Edit`/`Glob`/`Grep` entries for this project's path too. Then work end to end without stopping to ask.

## My environment — already set up, don't re-verify interactively

- **Windows 11**, PowerShell primary, Git Bash available. Use Git Bash for `curl` with single-quoted JSON; `cmd.exe` chokes on it.
- **GitHub CLI** authenticated as `ketankshukla`. Use `gh` to create the remote repo.
- **Vercel CLI** authenticated. Team slug: `ketan-shuklas-projects-8feda58f`
- **Neon** is available through the Vercel Marketplace (`npx vercel install neon`). Nothing is provisioned yet.
- I will add secrets to Vercel — or you can pipe them from `.env.local` without printing them. **Never echo a secret into the transcript.**

## What to build

**Working name: `mcp-agent-guard` — the agent that asks first.**

Project #2's loop calls every tool the instant the model picks it, keeps no record, and forgets everything on refresh. That's fine for dice and cookies. It is not fine the moment a tool can delete, send, or charge something.

This project adds the four things that turn that demo into something you'd let near real systems: **a notebook, an "are you sure?", a report card, and a rewind button.**

### Committed scope — phases 1–3 must ship and be verified

| Phase | What | Why this order |
|---|---|---|
| **1** | **Persistence** — Neon Postgres. Conversations, messages, and the full trace of every run. | Everything else needs somewhere to write. Also finally fixes project #1's confessed in-memory-state lie. |
| **2** | **Approval gates** — mark tools destructive; pause the loop, show the exact arguments, wait for a human, resume | The headline. This is where an agent stops being a toy. |
| **3** | **Evals** — a suite of prompts with expected tool calls; run them, score them, diff against the last run | The only way to know a prompt change helped. Turns "feels better" into a number. |

### Stretch — attempt only after 1–3 are complete and verified

| Phase | What |
|---|---|
| **4** | **Replay** — reconstruct any past run from the stored trace, step by step, in the UI |

A polished approval flow with a documented replay plan beats a half-finished everything. If time runs short, cut from the bottom and say clearly in your summary what you cut.

### Settled decisions — don't re-litigate these

| | Decision |
|---|---|
| **Database** | **Neon Postgres** via the Vercel Marketplace, using `@neondatabase/serverless` (ordinary `pg` exhausts connections on serverless) |
| **Model** | **Claude Sonnet 5** (`claude-sonnet-5`) — same as project #2, which keeps eval scores comparable |
| **Approval flow** | **Pause-and-resume.** Persist the pending call, END the request, resume as a new request keyed on a run id. Do not hold an HTTP connection open waiting for a human — a serverless function will die first. |
| **What counts as destructive** | An explicit allowlist **on the host side**. MCP's `destructiveHint` is a hint from someone else's computer; never let it decide your permissions. |
| **Scope** | Phases 1–3 committed, 4 stretch |

## The two demos that prove it works

Build toward these, and make them work end to end.

**1. It recovers from failure, and remembers.**

> **"Eat 500 cookies from the jar."**

There aren't 500. The agent should try, get the server's polite refusal, adapt — and the entire run, including the failed attempt, should still be readable from the database afterwards.

**2. It stops and asks.** ← *the one that matters*

> **"Empty the jar completely."**

This must **pause** and show me exactly this, before anything happens:

```
The agent wants to call:

  cookiejar__cookie_jar   { "action": "eat", "count": 78 }

  [ Approve ]    [ Deny ]
```

**Approve** runs it and the loop continues. **Deny** must feed a refusal back into the loop so the agent adapts and explains what it would do instead — it must not crash, and it must not silently stop. Show me that pause in the UI. That single interaction is the whole lesson of this project; make it impossible to miss.

## Engineering requirements — these are not optional

**Verify the APIs from the types on disk before writing code against them.** This is the #1 lesson from both previous projects and it has bitten twice:

```bash
npm ls @anthropic-ai/sdk @neondatabase/serverless @modelcontextprotocol/server mcp-handler zod
node -e "console.log(require('./node_modules/mcp-handler/package.json').peerDependencies)"
grep -rln "registerTool" node_modules/@modelcontextprotocol/server/dist/
```

The `.d.ts` files are ground truth for the version on my disk and cannot be out of date. Note that `@modelcontextprotocol/server` ships `.d.mts`, so `find -name "*.d.ts"` finds nothing — search by content instead. If a `claude-api` skill is available in your session, load it before writing any Claude API code, and confirm the current model ID rather than trusting mine.

**Carry forward what project #2 already learned.** Do not rediscover these:

- `create-next-app` refuses to scaffold into a folder containing *any* unrecognised file, including this prompt. `--skip-install --disable-git` does not help. Scaffold into a temp dir and copy in.
- `mcp-handler` peer-depends on **`@modelcontextprotocol/server`**, not `@modelcontextprotocol/sdk`.
- The Next.js `.gitignore` has `.env*`, which also swallows `.env.example`. Add `!.env.example` — and put that block **last**, because `vercel link` appends its own `.env*` line and gitignore is order-sensitive.
- Killing the shell that started `next dev` does not kill the server. Check the **port**, not the shell: `Get-NetTCPConnection -LocalPort 3000 -State Listen` then `taskkill /PID <pid> /F`.
- `.env.local` is read at process startup. Add a variable, restart the dev server, and confirm Next prints `- Environments: .env.local`.
- **`VERCEL_URL` is the per-deployment hostname and Deployment Protection guards it with a 401.** If the host must call itself, use `VERCEL_PROJECT_PRODUCTION_URL`. This one deployed green and silently ran with half its tools.
- A Vercel build **succeeds with no environment variables set** — nothing at build time touches them. Add secrets, then redeploy, then test.

**Secrets never touch the browser.** `ANTHROPIC_API_KEY` and `DATABASE_URL` are read only inside route handlers. `.env.local` is gitignored. Check `git status` before the first commit and confirm it isn't staged.

**Keep the loop's seatbelts.** Project #2 caps at 10 iterations, handles every `stop_reason` explicitly, and caches the system prompt + tool definitions with one `cache_control` breakpoint (worth a measured 47% off input tokens). Keep all of it, and keep the per-iteration token meter in the UI.

**Postgres on serverless needs the serverless driver.** Every request is a fresh connection; ordinary `pg` will exhaust the pool. Use `@neondatabase/serverless`.

**Evals must not assert on prose.** The model's wording changes every run. Assert on **which tool was called and with what arguments**. Run each case several times and score a pass rate — a single run tells you nothing about a non-deterministic system. Include at least one case where the correct answer is **"call no tools at all"**; an agent that reaches for tools when it shouldn't is just as broken as one that doesn't reach when it should.

**Test against the real thing, not mocks.** Actually call my live servers. Actually run the loop. Actually approve and deny something. Show me real output, not assumptions. If something fails, show me the failure.

## Deliverables

1. **The working app**, deployed to Vercel via GitHub, with a real Neon database behind it
2. **A GitHub repo** named the same as the folder — create it with `gh repo create ... --source=. --push`
3. **`README.md`** in projects #1 and #2's voice: teach approval gates and evals from zero, with **Mermaid diagrams**. Include a sequence diagram of the pause-and-resume flow showing where the request *ends* and a new one begins.
4. **`BUILD_FROM_SCRATCH.md`** in the same style: numbered stages, exact commands, a checkpoint proving each stage worked, and an appendix of the things that actually broke *while you built it* — real failures, not hypotheticals.
5. **`NEXT_STEP.md`** arguing for project #4, in the same teaching voice as the README — analogies first, jargon second. (Project #2's first draft of this failed that test; don't repeat it.)
6. **`.mcp.json`** so Claude Code can plug into whatever servers this project exposes.
7. **Heavily commented code.** The approval/resume logic especially should read like a lesson.

## Verification discipline — I care about this

- **Render every Mermaid diagram** through `npx @mermaid-js/mermaid-cli` before committing, across **all** markdown files — including `NEXT_STEP.md`. A malformed diagram shows as an ugly error box on GitHub.
- Use **translucent `rgba()`** for sequence-diagram `rect` bands so they're readable in both GitHub light and dark themes. When you check dark mode, render with `-t dark`, not just a dark background — otherwise you're testing a light theme on a dark canvas and the text will look broken when it isn't.
- **Check that internal links and TOC anchors resolve.** GitHub's slug rule converts *each* space to a hyphen without collapsing runs — `## Stage 0 — Prerequisites` becomes `stage-0--prerequisites`.
- **Run `npx tsc --noEmit` and `npm run build`** before the first push.
- **Verify the deployed URL, exercising the actual feature.** "It deployed and the page loads" is not verification — that is exactly how project #2 shipped a silent bug where half its tools were missing.

## Match the house style

These three projects should look like siblings. Project #2's landing page is the reference: `slate-950` background, amber/orange accent, `5xl`/`7xl` gradient hero with a blurred glow, `rounded-3xl` cards on `white/10` borders, alternating section backgrounds, a footer. Structure it as a scrolling lesson page with the interactive demo embedded partway down, exactly as projects #1 and #2 do.

## How to work with me

- Explain each concept **before** the code that implements it. Analogies first, then the real terms.
- Tell me plainly when something doesn't work. Show the error.
- Don't pad summaries with things you didn't verify.
- Make routine calls yourself; only ask me when a decision genuinely changes the outcome.
- I'm learning, so when you hit a wall, **show me how you figured it out** — reading the `.d.ts`, checking which process holds the port, comparing two URLs. That's the part I can't get from a tutorial.

Start by reading projects #1 and #2, then set up permissions, then tell me your plan before you build.
