import type { LinkLayoutSegment } from "@okouai/api-contracts/contracts/link-layout";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Durable ownership/index only. The R2 policy object is the single authority
// for audience and selected version, shared by the API and edge delivery.
export const artifactShares = pgTable(
  "artifact_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    // Link-layout segment inherited from the shared content.
    linkLayoutSegment: text("link_layout_segment")
      .$type<LinkLayoutSegment>()
      .notNull()
      .default("okou"),
    targetKind: text("target_kind").$type<"file" | "html">().notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_artifact_shares_target").on(
        table.targetKind,
        table.targetId,
      ),
    ];
  },
);
