import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Atomic sharing quotas shared by API instances; keys contain no raw email. */
export const hostedSiteShareRateLimits = pgTable(
  "hosted_site_share_rate_limits",
  {
    key: text("key").primaryKey(),
    windowStartedAt: timestamp("window_started_at").notNull(),
    requests: integer("requests").notNull(),
  },
);
