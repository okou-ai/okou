import { readMigrationFiles } from "drizzle-orm/migrator";
import type postgres from "postgres";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";

type DbMigration = {
  readonly id: number;
  readonly hash: string;
  readonly created_at: string | number | null;
};

export const NON_TRANSACTIONAL_MIGRATION_MARKER = "-- vm0:non-transactional";

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

    if (
      migration.sql.some((statement) => {
        return statement.includes(NON_TRANSACTIONAL_MIGRATION_MARKER);
      })
    ) {
      for (const statement of migration.sql) {
        if (statement.trim().length === 0) {
          continue;
        }
        await sql.unsafe(statement);
      }

      await sql`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES (${migration.hash}, ${migration.folderMillis})
      `;
      continue;
    }

    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL lock_timeout = '1s'`;
      await transaction`SET LOCAL statement_timeout = '10s'`;

      for (const statement of migration.sql) {
        if (statement.trim().length === 0) {
          continue;
        }
        await transaction.unsafe(statement);
      }

      await transaction`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES (${migration.hash}, ${migration.folderMillis})
      `;
    });
  }
}
