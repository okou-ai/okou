import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Content is deduplicated globally; authorization is always per subject. */
export const marketingContentGrants = pgTable(
  "marketing_content_grants",
  {
    resourceType: text("resource_type").$type<"manifest" | "file">().notNull(),
    resourceHash: text("resource_hash").notNull(),
    subject: text("subject").notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.resourceType, table.resourceHash, table.subject],
      }),
      check(
        "marketing_content_grant_type",
        sql`${table.resourceType} IN ('manifest', 'file')`,
      ),
      check(
        "marketing_content_grant_hash",
        sql`${table.resourceHash} ~ '^[a-f0-9]{64}$'`,
      ),
      check(
        "marketing_content_grant_subject",
        sql`${table.subject} = 'public' OR ${table.subject} LIKE 'user:%' OR ${table.subject} LIKE 'session:%'`,
      ),
    ];
  },
);

/** Atomic, cross-instance upload budgets; an anonymous session cannot reset an IP budget. */
export const marketingHandoffLimits = pgTable("marketing_handoff_limits", {
  subject: text("subject").primaryKey(),
  windowStart: timestamp("window_start").notNull(),
  requests: integer("requests").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
});
