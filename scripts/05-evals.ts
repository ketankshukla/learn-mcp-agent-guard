/**
 * scripts/05-evals.ts — PHASE 3 CHECKPOINT: the report card, with a diff.
 *
 *     npm run evals                    # 3 attempts per case
 *     npm run evals -- --attempts 5
 *     npm run evals -- --label "after prompt tweak"
 *     npm run evals -- --case gate-fires
 *
 * Every run is stored in Postgres and compared against the previous one, so
 * the output ends with the only line that actually matters:
 *
 *     83% -> 100%   (+17)
 *
 * ⚠️ The suite snapshots the cookie jar before it starts and restores it after.
 * An eval suite that corrupts the state it measures is a bad eval suite — you'd
 * get different results depending on what you ran last.
 */

import { EVAL_CASES, observeOnce, type EvalCase } from "../lib/evals";
import { buildToolbox } from "../lib/toolbox";
import { getServerConfigs } from "../lib/servers";
import { MODEL } from "../lib/agent-loop";
import { db } from "../lib/db";

type Arg = { attempts: number; label: string | null; only: string | null };

function parseArgs(): Arg {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    attempts: Number(get("--attempts") ?? 3),
    label: get("--label") ?? null,
    only: get("--case") ?? null,
  };
}

async function snapshotJar() {
  const sql = db();
  const rows = (await sql`select cookies from jar_state where id = 'default'`) as {
    cookies: number;
  }[];
  return rows[0]?.cookies ?? 12;
}

async function restoreJar(cookies: number) {
  const sql = db();
  await sql`update jar_state set cookies = ${cookies}, updated_at = now() where id = 'default'`;
}

async function main() {
  const { attempts, label, only } = parseArgs();
  const cases: EvalCase[] = only ? EVAL_CASES.filter((c) => c.id === only) : EVAL_CASES;

  if (cases.length === 0) {
    console.log(`\n  No case with id "${only}". Available: ${EVAL_CASES.map((c) => c.id).join(", ")}\n`);
    process.exit(1);
  }

  const sql = db();
  const toolbox = await buildToolbox(getServerConfigs());

  console.log("\n======================================================================");
  console.log(`  EVALS — ${cases.length} case(s) x ${attempts} attempt(s) = ${cases.length * attempts} runs`);
  console.log(`  model: ${MODEL}`);
  console.log("======================================================================\n");
  for (const s of toolbox.servers) {
    if (!s.ok) console.log(`  ⚠️  ${s.label} is DOWN — results will be misleading: ${s.error}\n`);
  }

  const jarBefore = await snapshotJar();

  // Create the eval_run row first so results can reference it.
  const [runRow] = (await sql`
    insert into eval_runs (label, model, effort, attempts, total, passed, pass_rate)
    values (${label}, ${MODEL}, 'medium', ${attempts}, 0, 0, 0)
    returning id
  `) as { id: string }[];
  const evalRunId = runRow.id;

  let total = 0;
  let passed = 0;
  const perCase: { id: string; passed: number; attempts: number; failures: string[] }[] = [];

  for (const evalCase of cases) {
    process.stdout.write(`  ${evalCase.id.padEnd(24)} `);
    let casePassed = 0;
    const failures: string[] = [];

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let failure: string | null = null;
      let observation;
      try {
        observation = await observeOnce(toolbox, evalCase.prompt);
        failure = evalCase.check(observation);
      } catch (error) {
        failure = `threw: ${(error as Error).message}`;
      }

      total += 1;
      if (!failure) {
        casePassed += 1;
        passed += 1;
        process.stdout.write("✓");
      } else {
        failures.push(failure);
        process.stdout.write("✗");
      }

      await sql`
        insert into eval_results (eval_run_id, case_id, attempt, passed, expectation, actual, detail)
        values (
          ${evalRunId}, ${evalCase.id}, ${attempt}, ${!failure},
          ${evalCase.expectation},
          ${JSON.stringify(observation?.calls ?? [])}::jsonb,
          ${failure}
        )
      `;
    }

    const rate = Math.round((casePassed / attempts) * 100);
    console.log(`  ${String(rate).padStart(3)}%  ${casePassed}/${attempts}`);
    perCase.push({ id: evalCase.id, passed: casePassed, attempts, failures });
  }

  const passRate = total > 0 ? passed / total : 0;

  await sql`
    update eval_runs set total = ${total}, passed = ${passed}, pass_rate = ${passRate}
     where id = ${evalRunId}
  `;

  await restoreJar(jarBefore);

  // -------------------------------------------------------------------
  // Failures, in detail. A red tick with no explanation is useless.
  // -------------------------------------------------------------------
  const failing = perCase.filter((c) => c.passed < c.attempts);
  if (failing.length > 0) {
    console.log("\n----------------------------------------------------------------------");
    console.log("  WHAT WENT WRONG");
    console.log("----------------------------------------------------------------------\n");
    for (const c of failing) {
      const evalCase = cases.find((x) => x.id === c.id)!;
      console.log(`  ${c.id}  (${c.passed}/${c.attempts})`);
      console.log(`      expected: ${evalCase.expectation}`);
      for (const f of [...new Set(c.failures)]) console.log(`      actual:   ${f}`);
      console.log("");
    }
  }

  // -------------------------------------------------------------------
  // THE DIFF. The reason this file exists.
  // -------------------------------------------------------------------
  const previous = (await sql`
    select id, label, pass_rate, passed, total, created_at
      from eval_runs
     where id <> ${evalRunId} and total > 0
     order by created_at desc
     limit 1
  `) as {
    id: string;
    label: string | null;
    pass_rate: number;
    passed: number;
    total: number;
    created_at: string;
  }[];

  console.log("======================================================================");
  console.log(`  SCORE: ${Math.round(passRate * 100)}%   (${passed}/${total})`);

  if (previous.length === 0) {
    console.log("  No previous run to compare against — this is your baseline.");
  } else {
    const prev = previous[0];
    const delta = Math.round(passRate * 100) - Math.round(prev.pass_rate * 100);
    const arrow = delta > 0 ? "improved" : delta < 0 ? "REGRESSED" : "unchanged";
    console.log(
      `  PREVIOUS: ${Math.round(prev.pass_rate * 100)}%   (${prev.passed}/${prev.total})` +
        (prev.label ? `  "${prev.label}"` : ""),
    );
    console.log(
      `  ${arrow}: ${delta >= 0 ? "+" : ""}${delta} points`,
    );

    // Per-case diff is what tells you WHERE it moved.
    const prevPerCase = (await sql`
      select case_id, sum(case when passed then 1 else 0 end)::int as passed, count(*)::int as total
        from eval_results where eval_run_id = ${prev.id} group by case_id
    `) as { case_id: string; passed: number; total: number }[];
    const prevMap = new Map(prevPerCase.map((r) => [r.case_id, r.passed / r.total]));

    const moved = perCase.filter((c) => {
      const before = prevMap.get(c.id);
      return before !== undefined && Math.abs(before - c.passed / c.attempts) > 0.001;
    });

    if (moved.length > 0) {
      console.log("\n  per case:");
      for (const c of moved) {
        const before = Math.round((prevMap.get(c.id) ?? 0) * 100);
        const after = Math.round((c.passed / c.attempts) * 100);
        const sign = after > before ? "+" : "";
        console.log(
          `    ${c.id.padEnd(24)} ${String(before).padStart(3)}% -> ${String(after).padStart(3)}%  (${sign}${after - before})`,
        );
      }
    }
  }
  console.log("======================================================================");
  console.log(`\n  jar restored to ${jarBefore} cookie(s). eval run ${evalRunId}\n`);
}

main().catch((error) => {
  console.error("\nFAILED:", (error as Error).message, "\n");
  process.exit(1);
});
