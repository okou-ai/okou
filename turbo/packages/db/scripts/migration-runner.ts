import { readMigrationFiles } from "drizzle-orm/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import { array, guid, number, object, string, tuple } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { summarizeMigrationPlan } from "./migration-plan";

type DbMigration = {
  readonly id: number;
  readonly hash: string;
  readonly created_at: string | number | null;
};

export const NON_TRANSACTIONAL_MIGRATION_MARKER = "-- okou:non-transactional";
export const UUID_BATCH_MIGRATION_MARKER = "-- okou:batch-by-uuid";
const EXPLAIN_ON_TIMEOUT_MIGRATION_MARKER = "-- okou:explain-on-timeout";

const batchCursorSchema = tuple([object({ next_cursor: guid().nullable() })]);

export interface ApplyPendingMigrationsOptions {
  /**
   * Stop before the first migration whose journal `when` is at or after this
   * value. Migration tests use it to seed data in the preceding schema.
   */
  readonly beforeMillis?: number;
  /** Disposable smoke clones only: a diagnostic replay can commit its batch. */
  readonly diagnoseBatchTimeouts?: boolean;
}

function migrationSqlstate(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function isStatementTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    migrationSqlstate(error) === "57014" &&
    error.message.includes("statement timeout")
  );
}

function validateDiagnosticMarkers(
  statements: readonly string[],
  nonTransactional: boolean,
): void {
  for (const statement of statements) {
    if (
      statement.includes(EXPLAIN_ON_TIMEOUT_MIGRATION_MARKER) &&
      (!nonTransactional || !statement.includes(UUID_BATCH_MIGRATION_MARKER))
    ) {
      throw new Error(
        "explain-on-timeout requires a non-transactional UUID batch",
      );
    }
  }
}

function diagnosticBatchFor(
  statement: string,
  cursor: string | null,
  enabled: boolean | undefined,
): { statement: string; cursor: string | null } | null {
  return enabled === true &&
    statement.includes(EXPLAIN_ON_TIMEOUT_MIGRATION_MARKER)
    ? { statement, cursor }
    : null;
}

function requiredMigrationFile(
  files: ReadonlyMap<number, string>,
  millis: number,
): string {
  const file = files.get(millis);
  if (file === undefined) {
    throw new Error(`Migration ${millis} is missing from the journal`);
  }
  return file;
}

export async function applyPendingMigrations(
  sql: postgres.Sql,
  options: ApplyPendingMigrationsOptions = {},
): Promise<void> {
  const migrations = readMigrationFiles({
    migrationsFolder: DRIZZLE_MIGRATE_OUT,
  });

  const journal = object({
    entries: array(object({ tag: string(), when: number() })),
  }).parse(
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

    const file = requiredMigrationFile(migrationFiles, migration.folderMillis);
    // Keep shipped bytes/journal identities, but execute canonical, replayable
    // DDL outside TX-0357. Retire each replay with its historical migration.
    const statements = [
      "1462_browser_owner_windows.sql",
      "1496_slippery_sheva_callister.sql",
    ].includes(file)
      ? readFileSync(
          new URL(`./migration-replays/${file}`, import.meta.url),
          "utf8",
        ).split("--> statement-breakpoint")
      : migration.sql;
    const startedAt = performance.now();
    const nonTransactional = statements.some((statement) => {
      return statement.includes(NON_TRANSACTIONAL_MIGRATION_MARKER);
    });
    let diagnosticBatch: { statement: string; cursor: string | null } | null =
      null;
    let progress: {
      phase: "transaction_start" | "setup" | "execute" | "journal" | "commit";
      statement: number | null;
      batch: number | null;
      startedAt: number;
    } = { phase: "transaction_start", statement: null, batch: null, startedAt };
    console.error(JSON.stringify({ event: "migration_started", file }));
    try {
      validateDiagnosticMarkers(statements, nonTransactional);
      if (nonTransactional) {
        for (const [index, statement] of statements.entries()) {
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
              diagnosticBatch = diagnosticBatchFor(
                statement,
                cursor,
                options.diagnoseBatchTimeouts,
              );
              // Each query commits independently. A failed migration restarts
              // at NULL, so the statement must make already-committed work a
              // no-op, including after a lost response or journal failure.
              const [{ next_cursor: nextCursor }] = batchCursorSchema.parse(
                await sql.unsafe(statement, [cursor]),
              );
              diagnosticBatch = null;
              console.error(
                JSON.stringify({
                  event: "migration_batch_completed",
                  file,
                  statement: index + 1,
                  batch,
                  elapsedMs: Math.round(performance.now() - progress.startedAt),
                }),
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

          for (const [index, statement] of statements.entries()) {
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
          statementCount: statements.length,
          batch: progress.batch,
          elapsedMs: Math.round(performance.now() - progress.startedAt),
          sqlstate: migrationSqlstate(error),
        }),
      );
      if (diagnosticBatch !== null && isStatementTimeout(error)) {
        // The failed autocommit statement has rolled back. Diagnose only that
        // batch on the same disposable clone, never replay earlier statements.
        // Regardless of diagnosis, preserve the original failure and stop.
        try {
          await sql.unsafe("SET statement_timeout = '30s'");
          const rows = await sql.unsafe(
            `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON) ${diagnosticBatch.statement}`,
            [diagnosticBatch.cursor],
          );
          console.error(
            JSON.stringify({
              event: "migration_diagnostic_plan",
              file,
              statement: progress.statement,
              batch: progress.batch,
              plan: summarizeMigrationPlan(rows),
            }),
          );
        } catch (diagnosticError) {
          console.error(
            JSON.stringify({
              event: "migration_diagnostic_failed",
              file,
              statement: progress.statement,
              batch: progress.batch,
              sqlstate: migrationSqlstate(diagnosticError),
            }),
          );
        }
      }
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
