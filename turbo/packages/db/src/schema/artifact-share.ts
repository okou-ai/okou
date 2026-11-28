import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { artifacts } from "./artifact";

/**
 * Unified per-user Artifact sharing grants (`PK (user_id, org_id, artifact_id)`).
 */
export const artifactShares = pgTable(
  "artifact_shares",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(
        () => {
          return artifacts.id;
        },
        { onDelete: "cascade" },
      ),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "artifact_shares_pk",
        columns: [table.userId, table.orgId, table.artifactId],
      }),
      index("artifact_shares_artifact_idx").on(table.artifactId),
    ];
  },
);
