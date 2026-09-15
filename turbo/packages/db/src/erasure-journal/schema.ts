import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// This module is deliberately outside src/schema and the application schema.
export const journalHead = pgTable(
  "erasure_journal_head",
  {
    slot: integer("slot").primaryKey(),
    authorityId: uuid("authority_id").notNull(),
    committedSequence: bigint("committed_sequence", {
      mode: "bigint",
    }).notNull(),
  },
  (t) => {
    return [
      check("erasure_journal_single_head", sql`${t.slot} = 1`),
      check("erasure_journal_watermark", sql`${t.committedSequence} >= 0`),
    ];
  },
);

export const journalDecisions = pgTable(
  "erasure_journal_decisions",
  {
    decisionSequence: bigint("decision_sequence", {
      mode: "bigint",
    }).primaryKey(),
    authorityId: uuid("authority_id").notNull(),
    decisionRef: uuid("decision_ref").notNull(),
    confirmationRef: uuid("confirmation_ref").notNull(),
    subjectKind: varchar("subject_kind", {
      length: 16,
      enum: ["user", "organization"],
    }).notNull(),
    subjectId: varchar("subject_id", { length: 192 }).notNull(),
    generation: integer("generation").notNull(),
    previousDecisionRef: uuid("previous_decision_ref"),
    dispositionVersion: integer("disposition_version").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  },
  (t) => {
    return [
      uniqueIndex("erasure_journal_decision_ref").on(t.decisionRef),
      uniqueIndex("erasure_journal_confirmation_ref").on(t.confirmationRef),
      uniqueIndex("erasure_journal_subject_generation").on(
        t.subjectKind,
        t.subjectId,
        t.generation,
      ),
      check(
        "erasure_journal_positive_versions",
        sql`${t.decisionSequence} > 0 AND ${t.generation} > 0 AND ${t.dispositionVersion} > 0`,
      ),
      check(
        "erasure_journal_subject",
        sql`${t.subjectKind} IN ('user', 'organization') AND octet_length(${t.subjectId}) BETWEEN 1 AND 192`,
      ),
      check(
        "erasure_journal_deadline",
        sql`isfinite(${t.requestedAt}) AND isfinite(${t.deadlineAt}) AND ${t.deadlineAt} > ${t.requestedAt}`,
      ),
    ];
  },
);
