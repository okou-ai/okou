import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  FollowupEvidenceKind,
  FollowupEvidenceOrigins,
} from "@okouai/db/jsonb-contracts/followup-preference";
import { chatThreads } from "./chat-thread";

/** A bounded excerpt, captured atomically with an accepted web input. */
export const followupEvidence = pgTable(
  "followup_evidence",
  {
    inputEventId: uuid("input_event_id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    text: varchar("text", { length: 1500 }).notNull(),
    kind: text("kind").$type<FollowupEvidenceKind>().notNull(),
    origins: jsonb("origins")
      .$type<FollowupEvidenceOrigins>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      index("followup_evidence_thread_idx").on(table.threadId),
      index("followup_evidence_owner_idx").on(
        table.orgId,
        table.userId,
        table.completedAt,
      ),
      index("followup_evidence_retention_idx").on(table.createdAt),
      check(
        "followup_evidence_origins_bound",
        sql`jsonb_typeof(${table.origins}) = 'array' AND jsonb_array_length(${table.origins}) <= 3`,
      ),
    ];
  },
);

/** The preference cache and its durable, coalescing refresh job share a row. */
export const followupUserProfiles = pgTable(
  "followup_user_profiles",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    preferences: varchar("preferences", { length: 1200 }),
    sourceEventIds: uuid("source_event_ids")
      .array()
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    evidenceVersion: integer("evidence_version").notNull().default(0),
    processedVersion: integer("processed_version").notNull().default(0),
    claimId: uuid("claim_id"),
    claimExpiresAt: timestamp("claim_expires_at"),
    nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId] }),
      index("followup_profiles_pending_idx").on(table.nextAttemptAt),
      index("followup_profiles_user_idx").on(table.userId),
      check(
        "followup_profile_versions",
        sql`${table.processedVersion} >= 0 AND ${table.evidenceVersion} >= ${table.processedVersion}`,
      ),
    ];
  },
);
