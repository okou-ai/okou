import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Retained after the DCF-552 runtime rollback for deployed data, old API
// compatibility, and account deletion. These tables have no active writers.
type PrivacyDecision = "granted" | "denied" | "unknown";

// Personal choices are independent of organization membership. Browser tokens
// authorize only this preference; no raw token or advertising ID is retained.
export const privacyChoices = pgTable(
  "privacy_choices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").unique(),
    tokenHash: text("token_hash").unique(),
    linkedUserId: text("linked_user_id"),
    revision: uuid("revision").notNull().defaultRandom(),
    advertisingEpoch: uuid("advertising_epoch").notNull().defaultRandom(),
    marketingAnalyticsEpoch: uuid("marketing_analytics_epoch")
      .notNull()
      .defaultRandom(),
    saleSharing: text("sale_sharing")
      .$type<PrivacyDecision>()
      .notNull()
      .default("unknown"),
    advertising: text("advertising")
      .$type<PrivacyDecision>()
      .notNull()
      .default("unknown"),
    marketingAnalytics: text("marketing_analytics")
      .$type<PrivacyDecision>()
      .notNull()
      .default("unknown"),
    source: text("source").$type<"explicit" | "gpc">(),
    policyVersion: text("policy_version").notNull(),
    updatedAt: timestamp("updated_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      index("privacy_choices_linked_user_idx").on(table.linkedUserId),
      check(
        "privacy_choices_owner_check",
        sql`(${table.userId} IS NOT NULL AND ${table.tokenHash} IS NULL AND ${table.linkedUserId} IS NULL) OR (${table.userId} IS NULL AND ${table.tokenHash} IS NOT NULL)`,
      ),
    ];
  },
);

// Immutable evidence for event-time consent. Delivery must also consult the
// current subject (and its linked person); a historical revision is not a grant.
export const privacyChoiceRevisions = pgTable(
  "privacy_choice_revisions",
  {
    revision: uuid("revision").primaryKey(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(
        () => {
          return privacyChoices.id;
        },
        { onDelete: "cascade" },
      ),
    saleSharing: text("sale_sharing").$type<PrivacyDecision>().notNull(),
    advertising: text("advertising").$type<PrivacyDecision>().notNull(),
    marketingAnalytics: text("marketing_analytics")
      .$type<PrivacyDecision>()
      .notNull(),
    source: text("source").$type<"explicit" | "gpc">().notNull(),
    policyVersion: text("policy_version").notNull(),
    recordedAt: timestamp("recorded_at").notNull(),
  },
  (table) => {
    return [index("privacy_choice_revisions_subject_idx").on(table.subjectId)];
  },
);

// Server-issued capture evidence. A purpose epoch changes on withdrawal, so an
// old capture cannot become eligible again after a later grant.
export const marketingPrivacyReceipts = pgTable("marketing_privacy_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  subjectId: uuid("subject_id")
    .notNull()
    .references(
      () => {
        return privacyChoices.id;
      },
      { onDelete: "cascade" },
    ),
  privacyRevision: uuid("privacy_revision")
    .notNull()
    .references(
      () => {
        return privacyChoiceRevisions.revision;
      },
      { onDelete: "cascade" },
    ),
  advertisingEpoch: uuid("advertising_epoch"),
  marketingAnalyticsEpoch: uuid("marketing_analytics_epoch"),
  policyVersion: text("policy_version").notNull(),
  capturedAt: timestamp("captured_at").notNull(),
});
