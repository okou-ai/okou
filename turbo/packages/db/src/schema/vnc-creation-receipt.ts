import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  text,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Retain creation identities after deletion so delayed retries cannot recreate
// a removed resource or reset its authority generation.
export const vncCreationReceipts = pgTable(
  "vnc_creation_receipts",
  {
    resourceKind: varchar("resource_kind", {
      length: 16,
      enum: ["vnc_credentials", "vnc_connections"],
    }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    ownerKey: text("owner_key").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "vnc_creation_receipts_pk",
        columns: [table.resourceKind, table.resourceId],
      }),
      check(
        "chk_vnc_creation_receipts_kind",
        sql`${table.resourceKind} IN ('vnc_credentials', 'vnc_connections')`,
      ),
      check(
        "chk_vnc_creation_receipts_owner_key",
        sql`${table.ownerKey} ~ '^[0-9a-f]{64}$'`,
      ),
    ];
  },
);
