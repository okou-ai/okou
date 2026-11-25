#!/usr/bin/env tsx

/**
 * Store the managed OpenRouter key for platform-paid Official Runs from the
 * deployment secret. Production releases run this after migrations and before
 * promoting the API, so the API that routes those Runs never starts without
 * its key. Updating the secret takes effect on the next API release.
 *
 * Environment (both required): DATABASE_URL, OPENROUTER_PROACTIVE_API_KEY.
 * The key value is never printed.
 */
import { PROACTIVE_RUN_KEY_VENDOR } from "@okouai/core/auto-run-model";
import postgres from "postgres";

async function syncProactiveModelKey() {
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.OPENROUTER_PROACTIVE_API_KEY?.trim();
  if (!databaseUrl) {
    throw new Error("invalid DATABASE_URL");
  }
  if (!apiKey) {
    throw new Error("OPENROUTER_PROACTIVE_API_KEY is not configured");
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ inserted: boolean }[]>`
      INSERT INTO built_in_model_keys (vendor, api_key, label)
      VALUES (${PROACTIVE_RUN_KEY_VENDOR}, ${apiKey}, 'okou-proactive')
      ON CONFLICT (vendor) DO UPDATE
        SET api_key = EXCLUDED.api_key,
          label = EXCLUDED.label,
          updated_at = EXCLUDED.updated_at
        WHERE built_in_model_keys.api_key IS DISTINCT FROM EXCLUDED.api_key
          OR built_in_model_keys.label IS DISTINCT FROM EXCLUDED.label
      RETURNING (xmax = 0) AS inserted
    `;
    const [changed] = rows;
    console.log(
      changed === undefined
        ? "Proactive model key unchanged"
        : changed.inserted
          ? "Proactive model key created"
          : "Proactive model key updated",
    );
  } finally {
    await sql.end();
  }
}

await syncProactiveModelKey();
