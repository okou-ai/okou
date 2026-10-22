#!/usr/bin/env tsx

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error("invalid DATABASE_URL");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const { values } = parseArgs({
    options: {
      defer: { type: "string" },
      "result-file": { type: "string" },
    },
  });

  try {
    const result = await applyPendingMigrations(sql, {
      deferMigration: values.defer,
    });
    if (values["result-file"]) {
      writeFileSync(values["result-file"], `${JSON.stringify(result)}\n`);
    }
    console.log(
      result.deferredMigration
        ? `Pre-promotion migrations complete; deferred ${result.deferredMigration}`
        : "Migrations complete",
    );
  } finally {
    await sql.end();
  }
}

await runMigrations();
