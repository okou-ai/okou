import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { hostedSites } from "./hosted-site";

/** A one-use authorization becomes a site-only session; raw credentials are never stored. */
export const hostedSiteBrowserSessions = pgTable(
  "hosted_site_browser_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(
        () => {
          return hostedSites.id;
        },
        { onDelete: "cascade" },
      ),
    origin: text("origin").notNull(),
    userId: text("user_id").notNull(),
    clerkSessionId: text("clerk_session_id").notNull(),
    codeHash: text("code_hash").unique(),
    codeChallenge: text("code_challenge"),
    tokenHash: text("token_hash").unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => {
    return [
      index("idx_hosted_site_browser_sessions_expiry").on(table.expiresAt),
      check(
        "hosted_site_browser_sessions_credential",
        sql`(${table.codeHash} IS NOT NULL AND ${table.codeChallenge} IS NOT NULL AND ${table.tokenHash} IS NULL) OR (${table.codeHash} IS NULL AND ${table.codeChallenge} IS NULL AND ${table.tokenHash} IS NOT NULL)`,
      ),
    ];
  },
);
