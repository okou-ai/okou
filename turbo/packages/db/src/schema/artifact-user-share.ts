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
 *
 * Staging table during Release 1–2 while legacy `artifact_shares` remains the
 * immutable R2 share-policy index. Consolidates `artifact_file_shares` and
 * `hosted_site_shares` and will be renamed to `artifact_shares` when legacy
 * `artifact_shares` is retired in Release 2 / cleanup DDL.
 */
export const artifactUserShares = pgTable(
  "artifact_user_shares",
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
        name: "artifact_user_shares_pk",
        columns: [table.userId, table.orgId, table.artifactId],
      }),
      index("artifact_user_shares_artifact_idx").on(table.artifactId),
    ];
  },
);
