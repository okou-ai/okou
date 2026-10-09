#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { z } from "zod";

const reportSchema = z.object({
  scanned: z.number().int().nonnegative(),
  next_cursor: z.uuid().nullable(),
  updated: z.number().int().nonnegative(),
  classifications: z.record(z.string(), z.number().int().nonnegative()),
});

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      limit: { type: "string", default: "100" },
      migrate: { type: "boolean", default: false },
      "print-sql": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "backfill.ts --mode runs|events|verify --before <UTC-cutoff> [--after <UUID>] [--limit 100] [--migrate] [--print-sql]\nPrint-sql emits reviewable psql statements without connecting. One independently committed bounded SQL statement; dry-run by default. Verify uses cutoff as the new-writer boundary.",
    );
    return;
  }
  const mode = z.enum(["runs", "events", "verify"]).parse(values.mode);
  const before = new Date(
    z.iso.datetime({ offset: true }).parse(values.before),
  ).toISOString();
  const after = values.after ? z.uuid().parse(values.after) : null;
  const limit = z.coerce.number().int().min(1).max(1000).parse(values.limit);
  assert(!(mode === "verify" && values.migrate), "verify_is_read_only");
  const source = await readFile(
    new URL(`${mode}.sql`, import.meta.url),
    "utf8",
  );
  // Preview contains no DML, so a read-only database role can audit the exact candidates.
  const query =
    mode !== "verify" && !values.migrate
      ? source.replace(
          /changed AS \([\s\S]*?\n\)\nSELECT/u,
          "changed AS (SELECT id FROM page WHERE false)\nSELECT",
        )
      : source;
  assert(
    mode === "verify" || values.migrate || query !== source,
    "missing_preview_boundary",
  );
  if (values["print-sql"]) {
    const name = `model_identity_${mode}_page`;
    const types =
      mode === "verify"
        ? "timestamp"
        : values.migrate
          ? "timestamp, uuid, integer, boolean"
          : "timestamp, uuid, integer";
    const argumentsSql =
      mode === "verify"
        ? `'${before}'`
        : `'${before}', ${after === null ? "NULL" : `'${after}'`}, ${limit}${values.migrate ? ", true" : ""}`;
    console.log(
      `SET statement_timeout = '10s';\nPREPARE ${name}(${types}) AS\n${query}\nEXECUTE ${name}(${argumentsSql});\nDEALLOCATE ${name};`,
    );
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  assert(connectionString, "DATABASE_URL_required");
  const db = new Client({ connectionString, statement_timeout: 10_000 });
  try {
    await db.connect();
    const result = await db.query(
      query,
      mode === "verify"
        ? [before]
        : values.migrate
          ? [before, after, limit, true]
          : [before, after, limit],
    );
    if (mode === "verify")
      console.log(
        JSON.stringify(
          z
            .object({ report: z.record(z.string(), z.unknown()) })
            .parse(result.rows[0]).report,
        ),
      );
    else console.log(JSON.stringify(reportSchema.parse(result.rows[0])));
  } finally {
    await db.end();
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    // PostgreSQL error details can contain private row values; never emit them.
    const failure = z
      .object({ code: z.string().regex(/^[0-9A-Z]{5}$/u) })
      .safeParse(error);
    console.error(
      JSON.stringify({
        error: "model_identity_operation_failed",
        sqlState: failure.success ? failure.data.code : null,
      }),
    );
    process.exitCode = 1;
  }
}
