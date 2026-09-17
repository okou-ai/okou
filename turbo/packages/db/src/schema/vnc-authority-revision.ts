import { sql } from "drizzle-orm";
import { check, pgTable, text, uuid } from "drizzle-orm/pg-core";

// Retained pseudonymous revisions fence delayed writes after owner cleanup.
export const vncAuthorityRevisions = pgTable(
  "vnc_authority_revisions",
  {
    scopeKey: text("scope_key").primaryKey(),
    revision: uuid("revision").notNull(),
    membershipIdHash: text("membership_id_hash"),
  },
  (table) => {
    return [
      check(
        "chk_vnc_authority_revisions_scope_key",
        sql`${table.scopeKey} ~ '^[0-9a-f]{64}$'`,
      ),
      check(
        "chk_vnc_authority_revisions_membership_hash",
        sql`${table.membershipIdHash} IS NULL OR ${table.membershipIdHash} ~ '^[0-9a-f]{64}$'`,
      ),
    ];
  },
);
