#!/usr/bin/env tsx

import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error("invalid DATABASE_URL");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    await applyPendingMigrations(sql);
    console.log("Migrations complete");
  } finally {
    await sql.end();
  }
}

await runMigrations();
