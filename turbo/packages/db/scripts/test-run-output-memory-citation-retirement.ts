import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { array, number, object, string } from "zod";
import { applyPendingMigrations } from "./migration-runner";

const journalSchema = object({
  entries: array(object({ tag: string(), when: number() })),
});

/** Validate the contraction and dependency failures on the preceding schema. */
export async function validateRunOutputMemoryCitationRetirement(
  databaseUrl: string,
): Promise<void> {
  const journal = journalSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const retirement = journal.entries.find((entry) => {
    return entry.tag === "1474_drop_run_output_memory_citations";
  });
  assert.ok(retirement);
  const admin = postgres(databaseUrl, { max: 1 });
  const baselineName = `citation_retirement_base_${randomUUID().replaceAll("-", "")}`;
  const baselineUrl = new URL(databaseUrl);
  baselineUrl.pathname = `/${baselineName}`;
  let baselineCreated = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${baselineName}"`);
    baselineCreated = true;
    const baseline = postgres(baselineUrl.toString(), { max: 1 });
    try {
      await applyPendingMigrations(baseline, { beforeMillis: retirement.when });
      await baseline`
        INSERT INTO agent_runs (id, user_id, org_id, status, prompt, result)
        VALUES ('11111111-1111-4111-8111-111111111111', 'citation-owner',
          'citation-org', 'completed', 'Retain this Run', '{"text":"retained output"}')
      `;
      await baseline`
        INSERT INTO run_output_memory_citations (run_id, sequence_number, citation)
        VALUES ('11111111-1111-4111-8111-111111111111', 1,
          '{"entries":[{"path":"MEMORY.md","lineStart":1,"lineEnd":3}]}')
      `;
    } finally {
      await baseline.end();
    }

    for (const scenario of [
      "success",
      "view",
      "foreign-key",
      "local-index",
      "local-check",
      "unexpected-default",
      "string-bodied-function",
      "local-trigger",
      "inheritance",
    ]) {
      const name = `citation_retirement_${randomUUID().replaceAll("-", "")}`;
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await admin.unsafe(
        `CREATE DATABASE "${name}" TEMPLATE "${baselineName}"`,
      );
      const sql = postgres(url.toString(), { max: 1 });
      try {
        const preserved = async () => {
          return JSON.stringify(
            Array.from(await sql`SELECT * FROM agent_runs ORDER BY id`),
          );
        };
        const original = await preserved();
        const originalJournal = Array.from(
          await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
        );
        if (scenario === "success") {
          await applyPendingMigrations(sql, {
            beforeMillis: retirement.when + 1,
          });
          assert.equal(await preserved(), original);
          const applied = Array.from(
            await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
          );
          assert.equal(applied.length, originalJournal.length + 1);
          assert.equal(applied.at(-1)?.created_at, String(retirement.when));
          await applyPendingMigrations(sql, {
            beforeMillis: retirement.when + 1,
          });
          assert.deepEqual(
            Array.from(
              await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
            ),
            applied,
          );
          assert.equal(await preserved(), original);
          assert.deepEqual(
            Array.from(
              await sql`
              INSERT INTO agent_runs (id, user_id, org_id, status, prompt)
              VALUES ('22222222-2222-4222-8222-222222222222', 'citation-owner',
                'citation-org', 'completed', 'Ordinary Run after contraction')
              RETURNING id
            `,
            ),
            [{ id: "22222222-2222-4222-8222-222222222222" }],
          );
          continue;
        }
        if (scenario === "view")
          await sql`CREATE VIEW citation_consumer AS SELECT * FROM run_output_memory_citations`;
        if (scenario === "foreign-key")
          await sql`CREATE TABLE citation_consumer (
            run_id uuid, sequence_number integer,
            FOREIGN KEY (run_id, sequence_number)
              REFERENCES run_output_memory_citations (run_id, sequence_number)
          )`;
        if (scenario === "local-index")
          await sql`CREATE INDEX citation_consumer ON run_output_memory_citations (created_at)`;
        if (scenario === "local-check")
          await sql`ALTER TABLE run_output_memory_citations ADD CONSTRAINT citation_consumer CHECK (sequence_number >= 0)`;
        if (scenario === "unexpected-default")
          await sql`ALTER TABLE run_output_memory_citations ALTER COLUMN sequence_number SET DEFAULT 0`;
        if (scenario === "string-bodied-function")
          await sql`CREATE FUNCTION citation_count() RETURNS bigint LANGUAGE sql
            AS 'SELECT count(*) FROM public.run_output_memory_citations'`;
        if (scenario === "local-trigger") {
          await sql`CREATE FUNCTION citation_trigger() RETURNS trigger LANGUAGE plpgsql
            AS 'BEGIN RETURN NEW; END'`;
          await sql`CREATE TRIGGER citation_consumer BEFORE INSERT
            ON run_output_memory_citations FOR EACH ROW EXECUTE FUNCTION citation_trigger()`;
        }
        if (scenario === "inheritance")
          await sql`CREATE TABLE citation_consumer () INHERITS (run_output_memory_citations)`;
        const state = async () => {
          return JSON.stringify([
            await preserved(),
            Array.from(
              await sql`SELECT * FROM run_output_memory_citations ORDER BY run_id, sequence_number`,
            ),
            Array.from(
              await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
            ),
          ]);
        };
        const before = await state();
        await assert.rejects(
          applyPendingMigrations(sql, { beforeMillis: retirement.when + 1 }),
          { code: "2BP01" },
        );
        assert.equal(await state(), before, scenario);
      } finally {
        await sql.end();
        await admin.unsafe(`DROP DATABASE "${name}"`);
      }
    }
  } finally {
    try {
      if (baselineCreated)
        await admin.unsafe(`DROP DATABASE "${baselineName}"`);
    } finally {
      await admin.end();
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await validateRunOutputMemoryCitationRetirement(process.env.DATABASE_URL);
  console.log(
    "Run output memory citation retirement, preservation and dependency checks passed",
  );
}
