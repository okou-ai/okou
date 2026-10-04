/* eslint-disable no-restricted-imports, api/no-package-variable -- Catalog lifecycle tests alone own an in-process PGlite database (target-state v5, N1-N5). */
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";

let postgres: PGlite | undefined;

beforeEach(async () => {
  postgres = new PGlite();
  const migration = await readFile(
    new URL(
      "../../../../../../packages/db/src/migrations/1319_fair_doctor_spectrum.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await postgres.exec(migration);
});

afterEach(async () => {
  await postgres?.close();
  postgres = undefined;
});

// Subsequent sync/reader PRs exercise their real entry points against this
// connection. No production DB override or new reader is introduced by P2.
export function catalogMechanismDatabase() {
  if (!postgres) {
    throw new Error("Catalog mechanism database is not initialized");
  }
  return drizzle(postgres, {
    schema: { connectorCatalog, connectorCatalogEntries },
  });
}

describe("immutable connector catalog lifecycle", () => {
  it.todo("N1: rejects downloaded bytes whose hash differs from the pointer");
  it.todo(
    "N2: prepares before activation and resumes partial preparation idempotently",
  );
  it.todo("N3: only the CAS winner attempts activation side effects");
  it.todo(
    "N4: reads the old immutable entries after switching back to their hash",
  );
  it.todo(
    "N5: distinguishes unknown slugs from missing entries without fallback",
  );
});
