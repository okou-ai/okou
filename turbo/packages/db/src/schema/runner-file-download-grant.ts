import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/** One pending exact-file native-download grant per Run; contains no file bytes. */
export const runnerFileDownloadGrants = pgTable(
  "runner_file_download_grants",
  {
    digest: varchar("digest", { length: 64 }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .unique()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runnerId: uuid("runner_id").notNull(),
    origin: varchar("origin", { length: 300 }).notNull(),
    path: text("path").array().notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => {
    return [
      index("runner_file_download_grants_expiry_idx").on(table.expiresAt),
    ];
  },
);
