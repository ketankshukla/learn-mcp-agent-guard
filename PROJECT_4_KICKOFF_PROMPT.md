# Project #4 — kickoff prompt

You are an expert at teaching AI engineering to beginners, and you are about to build my fourth MCP project with me. Teach me like I'm five — plain language, concrete analogies, no jargon without explaining it first — but write code like a senior engineer.

## Read this first, before anything else

My first three projects:

1. **https://github.com/ketankshukla/learn-mcp-5-year-old** — an MCP **server**
2. **https://github.com/ketankshukla/learn-mcp-agent-loop** — an MCP **host** that owns the agent loop
3. **https://github.com/ketankshukla/learn-mcp-agent-guard** — the agent that **asks first**: approval gates, Postgres persistence, evals, replay

Clone all three into a temp folder and read these, in this order:

| File | Repo | Why |
|---|---|---|
| `README.md` | #3 | The teaching voice, the Mermaid conventions, and the four things you're building on |
| `lib/agent-loop.ts` | #3 | **The file this project makes recursive.** Read every comment. |
| `lib/approval.ts` | #3 | The permission model. It gets harder when five agents share one human. |
| `lib/evals.ts` + `scripts/05-evals.ts` | #3 | **The thing that will judge this project.** Understand it before you change anything. |
| `NEXT_STEP.md` | #3 | The plan for this project and the seven decisions already settled |
| `BUILD_FROM_SCRATCH.md` | #3 | Especially **Appendix A** — eight real failures. Do not repeat them. |

Project #3 is a working, deployed MCP host with a database, a permission model, and a scored eval suite. **This project extends it — you are not starting from scratch.** Copy its `lib/` wholesale and build on top.

## Set up permissions FIRST, before you write any code

Do not ask me to approve things one at a time. Before your first build command, write a broad allowlist to **`.claude/settings.json`** (the project file — **not** `settings.local.json`, which the harness overwrites after every approval). Copy the allowlist from project #3's `.claude/settings.json` and change the paths.

## My environment — already set up, don't re-verify interactively

- **Windows 11**, PowerShell primary, Git Bash available. Use Git Bash for `curl` with single-quoted JSON.
- **GitHub CLI** authenticated as `ketankshukla`. Use `gh` to create the remote repo.
- **Vercel CLI** authenticated. Team slug: `ketan-shuklas-projects-8feda58f`
- **Neon** installs from the Vercel Marketplace with `npx vercel install neon`. It does **not** ask for a card. `npx vercel env pull .env.local` gets you a pooled `DATABASE_URL`.
- Never echo a secret into the transcript.

## What to build

**Working name: `learn-mcp-agent-crew` — one agent that hires help.**

Project #3's agent is a very good cook working alone. Ask it to process 200 files and it will try to do all of it itself, in one line, holding the whole mess in its head — and somewhere around file 40 it will forget what it was doing. That isn't a prompt problem. It's a shape problem.

A head chef doesn't cook faster. They split the work, hand pieces to other cooks, and keep only the **plan** in their own head instead of every detail.

### Committed scope — phases 1–3 must ship and be verified

| Phase | What | Why this order |
|---|---|---|
| **1** | **Measure the ceiling first.** Build an eval case that a single agent demonstrably fails — too much for one context window. Record the score. | If you can't show the failure, you cannot show the fix. This is the baseline the whole project is judged against. |
| **2** | **Delegation.** A `spawn_agent` tool whose implementation is another `runAgentLoop`, with its own `runId` and a `parent_run_id`. Sub-agent traces nest under the parent. | The headline. |
| **3** | **Approvals and cost under delegation.** Every gated call bubbles to ONE human queue, carrying the child's reasoning. Per-sub-agent token metering in the UI. | This is where it stops being a toy. Five agents each asking separately is unusable. |

### Stretch — attempt only after 1–3 are complete and verified

| Phase | What |
|---|---|
| **4** | **Nested replay** — expand a parent run's trace to see what each sub-agent actually did |

### Settled decisions — don't re-litigate these

| | Decision |
|---|---|
| **Sub-agent transport** | `runAgentLoop` called recursively. **No orchestration framework.** The loop already takes messages in and yields events out — that is a sub-agent. |
| **Approvals** | Always bubble to the top-level run. One human, one queue, child's reason carried up. |
| **Concurrency** | Hard cap, starting at **3**. A parallel loop with a bug is a bill times N. |
| **Model** | **`claude-sonnet-5`** — unchanged, so eval scores stay comparable to project #3. |
| **Database** | Neon Postgres, `@neondatabase/serverless`, extending project #3's schema |
| **Scope** | Phases 1–3 committed, 4 stretch |

## The demo that proves it

> **"Here are 60 cookie jars. Find every one that's been tampered with, and empty only those."**

One agent runs out of room. The orchestrator splits it three ways, gets three short reports back, and then — **this is the part that matters** — asks me **once**, with a list, before emptying anything.

That single approval standing in front of three agents' worth of work is the picture. Make it impossible to miss.

## Engineering requirements — these are not optional

**Verify the APIs from the types on disk before writing code against them.** This is the #1 lesson from all three previous projects and it has bitten three times. `.d.ts` files are ground truth for the version on my disk.

**The honest question comes first.** Before building the whole thing, run the eval suite with delegation off and on, and compare **both the pass rate and the token cost**. It is entirely possible that one agent is better and cheaper at this size. **Finding that out with a number is a successful project, not a failed one.** Do not build for a week and then discover it. Tell me plainly what the numbers say.

**Carry forward what projects #2 and #3 already learned.** Do not rediscover these:

- `create-next-app` refuses to scaffold into a folder containing *any* unrecognised file. Scaffold to a temp dir and copy in.
- `mcp-handler` peer-depends on **`@modelcontextprotocol/server`**, not `@modelcontextprotocol/sdk`.
- The Next.js `.gitignore` has `.env*`, which swallows `.env.example`. Add `!.env.example` and put that block **last** — **every** `vercel` command that writes `.env.local` appends its own `.env*` line, not just `vercel link`.
- `git check-ignore -v` reports the matching *negation* line with exit 0, which reads like failure. Use `git add -n <file>` to test what git will actually do.
- `LayoutProps<"/">` doesn't exist before a build. Type the layout explicitly or `tsc --noEmit` fails on a clean clone.
- **`VERCEL_URL` is the per-deployment hostname and Deployment Protection guards it with a 401.** If the host must call itself, use `VERCEL_PROJECT_PRODUCTION_URL`.
- Killing the shell that started `next dev` does not kill the server. Check the **port**: `Get-NetTCPConnection -LocalPort 3000 -State Listen` then `taskkill /PID <pid> /F`.
- A Vercel build **succeeds with no environment variables set**. Add secrets, then redeploy, then test.
- If two code paths reach the same feature (a route handler and a terminal script), they **will** drift. Project #3 shipped an empty trace that way.

**Keep every seatbelt, and add one.** Project #3 caps iterations at 10, threads `iterationOffset` through resumes, handles every `stop_reason`, and caches the prompt prefix. Keep all of it. Then add a **concurrency cap** and a **total-spend ceiling across the whole agent tree** — a runaway orchestrator is the most expensive bug in this series so far.

**Evals must not assert on prose.** Assert on which tool was called and with what arguments. Run each case several times and score a pass rate. Keep project #3's six cases passing — a regression there matters more than a new feature working.

**Test against the real thing, not mocks.** Actually run the orchestrator. Actually approve and deny something inside a sub-agent. Show me real output, real token counts, and real failures.

## Deliverables

1. **The working app**, deployed to Vercel via GitHub, with a real Neon database
2. **A GitHub repo** named `learn-mcp-agent-crew` — `gh repo create ... --source=. --push`
3. **`README.md`** in the series' voice, with **Mermaid diagrams**. Include a diagram of the agent tree and one showing how a sub-agent's approval bubbles up to the single human queue.
4. **`BUILD_FROM_SCRATCH.md`**: numbered stages, exact commands, a checkpoint proving each stage, and an appendix of what actually broke *while you built it*.
5. **`NEXT_STEP.md`** arguing for project #5, analogies first.
6. **`.mcp.json`**
7. **Heavily commented code.** The delegation and approval-bubbling logic especially should read like a lesson.
8. **A "this is part of a series" section and forward/backward links**, matching projects #1–#3.

## Verification discipline — I care about this

- **Render every Mermaid diagram** through `npx @mermaid-js/mermaid-cli` before committing, across **all** markdown files, in **both** `-t dark` and `-t default`.
- Use **translucent `rgba()`** for sequence-diagram `rect` bands so they read in both GitHub themes.
- **Check that internal links and TOC anchors resolve** — and that they point at the section their label claims. GitHub converts *each* space to a hyphen without collapsing runs. ⚠️ If you write a link checker, normalise `\r` first: a fresh Windows clone has CRLF and a naive `\n` regex will report dozens of false failures.
- **Run `npx tsc --noEmit`, `npx eslint .`, and `npm run build`** before the first push.
- **Verify the deployed URL by exercising the actual feature.** "It deployed and the page loads" is not verification.

## Match the house style

These four projects should look like siblings. Project #3's landing page is the reference: `slate-950` background, amber/orange accent, `5xl`/`7xl` gradient hero with a blurred glow, `rounded-3xl` cards on `white/10` borders, alternating section backgrounds, a footer. Structure it as a scrolling lesson page with the interactive demo embedded partway down.

## How to work with me

- Explain each concept **before** the code that implements it. Analogies first, then the real terms.
- Tell me plainly when something doesn't work. Show the error.
- Don't pad summaries with things you didn't verify.
- Make routine calls yourself; only ask me when a decision genuinely changes the outcome.
- When you hit a wall, **show me how you figured it out** — reading the `.d.ts`, checking which process holds the port, comparing two numbers. That's the part I can't get from a tutorial.

Start by reading projects #1–#3, then set up permissions, then tell me your plan before you build.
