#!/usr/bin/env tsx

import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

// This entry point is exclusively for the disposable production-smoke clone.
// Diagnostics can commit a replayed batch; production uses migrate.ts instead.
if (!process.env.DATABASE_URL) {
  throw new Error("invalid DATABASE_URL");
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await applyPendingMigrations(sql, { diagnoseBatchTimeouts: true });
  console.log("Migrations complete");
} finally {
  await sql.end();
}
