import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { FeatureGuideContent } from "../jsonb-contracts/feature-guide";

export const featureGuideEditions = pgTable(
  "feature_guide_editions",
  {
    id: text("id").primaryKey(),
    publishedRevisionId: uuid("published_revision_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return [
      index("idx_feature_guide_editions_published").on(table.publishedAt),
      foreignKey({
        name: "feature_guide_published_revision_fk",
        columns: [table.id, table.publishedRevisionId],
        foreignColumns: [
          featureGuideRevisions.editionId,
          featureGuideRevisions.id,
        ],
      }),
    ];
  },
);

export const featureGuideRevisions = pgTable(
  "feature_guide_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    editionId: text("edition_id")
      .notNull()
      .references((): AnyPgColumn => {
        return featureGuideEditions.id;
      }),
    content: jsonb("content").$type<FeatureGuideContent>().notNull(),
    contentHash: text("content_hash").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return [
      unique("feature_guide_revision_edition_identity").on(
        table.editionId,
        table.id,
      ),
      unique("feature_guide_revision_content_hash").on(
        table.editionId,
        table.contentHash,
      ),
    ];
  },
);

export const featureGuideReceipts = pgTable(
  "feature_guide_receipts",
  {
    userId: text("user_id").notNull(),
    editionId: text("edition_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.userId, table.editionId] }),
      foreignKey({
        name: "feature_guide_receipt_revision_fk",
        columns: [table.editionId, table.revisionId],
        foreignColumns: [
          featureGuideRevisions.editionId,
          featureGuideRevisions.id,
        ],
      }),
    ];
  },
);
