import { readFileSync } from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type postgres from "postgres";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";

type DbMigration = {
  readonly id: number;
  readonly hash: string;
  readonly created_at: string | number | null;
};

export const NON_TRANSACTIONAL_MIGRATION_MARKER = "-- vm0:non-transactional";
export const UUID_BATCH_MIGRATION_MARKER = "-- vm0:batch-by-uuid";

const batchCursorSchema = z.tuple([
  z.object({ next_cursor: z.guid().nullable() }),
]);

export interface ApplyPendingMigrationsOptions {
  /**
   * Stop before the first migration whose journal `when` is at or after this
   * value. Migration tests use it to seed data in the preceding schema.
   */
  readonly beforeMillis?: number;
}

export async function applyPendingMigrations(
  sql: postgres.Sql,
  options: ApplyPendingMigrationsOptions = {},
): Promise<void> {
  const migrations = readMigrationFiles({
    migrationsFolder: DRIZZLE_MIGRATE_OUT,
  });

  const journal = z
    .object({
      entries: z.array(z.object({ tag: z.string(), when: z.number() })),
    })
    .parse(
      JSON.parse(
        readFileSync(
          path.join(DRIZZLE_MIGRATE_OUT, "meta/_journal.json"),
          "utf8",
        ),
      ),
    );
  const migrationFiles = new Map(
    journal.entries.map((entry) => {
      return [entry.when, `${entry.tag}.sql`];
    }),
  );

  await sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
  await sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  const dbMigrations = await sql<DbMigration[]>`
    SELECT id, hash, created_at
    FROM "drizzle"."__drizzle_migrations"
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const lastDbMigration = dbMigrations[0];

  for (const migration of migrations) {
    if (
      options.beforeMillis !== undefined &&
      migration.folderMillis >= options.beforeMillis
    ) {
      break;
    }
    if (
      lastDbMigration &&
      Number(lastDbMigration.created_at) >= migration.folderMillis
    ) {
      continue;
    }

    const file = migrationFiles.get(migration.folderMillis);
    if (file === undefined) {
      throw new Error(
        `Migration ${migration.folderMillis} is missing from the journal`,
      );
    }
    const startedAt = performance.now();
    let progress: {
      phase: "transaction_start" | "setup" | "execute" | "journal" | "commit";
      statement: number | null;
      batch: number | null;
      startedAt: number;
    } = { phase: "transaction_start", statement: null, batch: null, startedAt };
    console.error(JSON.stringify({ event: "migration_started", file }));
    try {
      if (
        migration.sql.some((statement) => {
          return statement.includes(NON_TRANSACTIONAL_MIGRATION_MARKER);
        })
      ) {
        for (const [index, statement] of migration.sql.entries()) {
          if (statement.trim().length === 0) {
            continue;
          }
          progress = {
            phase: "execute",
            statement: index + 1,
            batch: null,
            startedAt: performance.now(),
          };
          if (statement.includes(UUID_BATCH_MIGRATION_MARKER)) {
            throw new Error("UUID batches require a transactional migration");
          }
          await sql.unsafe(statement);
        }

        progress = {
          phase: "journal",
          statement: null,
          batch: null,
          startedAt: performance.now(),
        };
        await sql`
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES (${migration.hash}, ${migration.folderMillis})
        `;
      } else {
        // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0357; new non-billing transactions are prohibited.
        await sql.begin(async (transaction) => {
          progress = {
            phase: "setup",
            statement: null,
            batch: null,
            startedAt: performance.now(),
          };
          await transaction`SET LOCAL lock_timeout = '1s'`;
          await transaction`SET LOCAL statement_timeout = '10s'`;

          for (const [index, statement] of migration.sql.entries()) {
            if (statement.trim().length === 0) {
              continue;
            }
            progress = {
              phase: "execute",
              statement: index + 1,
              batch: null,
              startedAt: performance.now(),
            };
            if (statement.includes(UUID_BATCH_MIGRATION_MARKER)) {
              let batch = 0;
              let cursor: string | null = null;
              while (true) {
                progress.batch = ++batch;
                progress.startedAt = performance.now();
                const [{ next_cursor: nextCursor }] = batchCursorSchema.parse(
                  await transaction.unsafe(statement, [cursor]),
                );
                if (nextCursor === null) {
                  break;
                }
                if (cursor !== null && nextCursor <= cursor) {
                  throw new Error(
                    `Batch cursor did not advance in migration ${migration.folderMillis}`,
                  );
                }
                cursor = nextCursor;
              }
              continue;
            }
            await transaction.unsafe(statement);
          }

          progress = {
            phase: "journal",
            statement: null,
            batch: null,
            startedAt: performance.now(),
          };
          await transaction`
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES (${migration.hash}, ${migration.folderMillis})
        `;
          progress = {
            phase: "commit",
            statement: null,
            batch: null,
            startedAt: performance.now(),
          };
        });
      }
    } catch (error) {
      // Add the missing work-unit identity without replacing the database error.
      console.error(
        JSON.stringify({
          event: "migration_failed",
          file,
          phase: progress.phase,
          statement: progress.statement,
          statementCount: migration.sql.length,
          batch: progress.batch,
          elapsedMs: Math.round(performance.now() - progress.startedAt),
          sqlstate:
            error instanceof Error &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : null,
        }),
      );
      throw error;
    }
    console.error(
      JSON.stringify({
        event: "migration_completed",
        file,
        elapsedMs: Math.round(performance.now() - startedAt),
      }),
    );
  }
}
