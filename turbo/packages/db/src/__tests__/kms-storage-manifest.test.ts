import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { recoveryFields } from "../../scripts/migrations/013-kms-account-rotation/fields";
import { schema } from "../index";

function declaredEncryptedColumns(): string[] {
  const declared = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) {
      continue;
    }
    const table = getTableConfig(value);
    for (const column of table.columns) {
      if (column.name.startsWith("encrypted_")) {
        declared.add(`${table.name}.${column.name}`);
      }
    }
  }
  return [...declared].sort();
}

describe("013 KMS account rotation storage manifest", () => {
  // A new encrypted_* column that never reaches this manifest stays invisible
  // until backfill.ts aborts a production run with untracked_encrypted_columns,
  // which is how connector_dcr_registrations.encrypted_client_secret (#35241)
  // slipped through. recoveryFields is the manifest the live verify-target path
  // selects, so it is the one that must track the current schema. Only the
  // schema-to-manifest direction is asserted: the manifest also carries
  // physical tables that have no Drizzle module.
  it("tracks every encrypted column the schema declares", () => {
    const tracked = new Set(
      recoveryFields.map((field) => {
        return `${field.table}.${field.column}`;
      }),
    );

    const untracked = declaredEncryptedColumns().filter((column) => {
      return !tracked.has(column);
    });

    expect(untracked).toEqual([]);
  });
});
