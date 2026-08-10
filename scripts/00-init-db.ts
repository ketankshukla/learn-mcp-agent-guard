/**
 * scripts/00-init-db.ts — PHASE 1 CHECKPOINT
 *
 *     npm run db:init
 *
 * Creates every table, then proves the connection actually round-trips by
 * writing a row and reading it back. "It connected" is not the same as "it
 * works" — this checks the second one.
 */

import { db, initSchema } from "../lib/db";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "\n  DATABASE_URL is not set.\n\n" +
        "    npx vercel install neon      # provision one\n" +
        "    npx vercel env pull .env.local\n",
    );
    process.exit(1);
  }

  const sql = db();

  console.log("\n======================================================================");
  console.log("  Creating schema");
  console.log("======================================================================\n");

  await initSchema();

  const tables = (await sql`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
     order by table_name
  `) as { table_name: string }[];

  for (const t of tables) console.log(`  ✓ ${t.table_name}`);

  // -------------------------------------------------------------------
  // The part that actually proves something: write, read, delete.
  // -------------------------------------------------------------------
  console.log("\n----------------------------------------------------------------------");
  console.log("  ROUND TRIP");
  console.log("----------------------------------------------------------------------\n");

  const [convo] = (await sql`
    insert into conversations (title) values ('db:init smoke test')
    returning id, created_at
  `) as { id: string; created_at: string }[];
  console.log(`  wrote conversation  ${convo.id}`);

  const [readBack] = (await sql`
    select title from conversations where id = ${convo.id}
  `) as { title: string }[];
  console.log(`  read it back        "${readBack.title}"`);

  await sql`delete from conversations where id = ${convo.id}`;
  console.log(`  cleaned up`);

  const [jar] = (await sql`select cookies from jar_state where id = 'default'`) as {
    cookies: number;
  }[];
  console.log(`\n  the jar currently holds ${jar.cookies} cookie(s)`);
  console.log(
    `  ...and unlike project #1's, that number will still be there tomorrow.\n`,
  );

  console.log("PASS: schema created and the database round-trips.\n");
}

main().catch((error) => {
  console.error("\nFAILED:", (error as Error).message, "\n");
  process.exit(1);
});
