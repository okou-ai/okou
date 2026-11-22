#!/usr/bin/env tsx

import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

import { migrationTimestamp } from "./migration-timestamp";

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error("invalid DATABASE_URL");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const options = process.argv.slice(2);
    if (
      options.length > 1 ||
      (options.length === 1 && options[0] !== "--before-agent-retirement")
    ) {
      throw new Error("Unknown database migration option");
    }
    const beforeMillis = options.length
      ? await migrationTimestamp("1616_retire_agents_table")
      : undefined;
    await applyPendingMigrations(sql, { beforeMillis });
    console.log("Migrations complete");
  } finally {
    await sql.end();
  }
}

await runMigrations();
