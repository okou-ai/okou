import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Local recoverable work only. No business-root FK, payload JSON or independent
// authority claim. G2d1b owns finite retirement before production activation.
export const accountErasureIngress = pgTable(
  "account_erasure_ingress",
  {
    confirmationRef: uuid("confirmation_ref").primaryKey(),
    audience: varchar("audience", { length: 192 }).notNull(),
    eventId: varchar("event_id", { length: 192 }).notNull(),
    authorityId: uuid("authority_id").notNull(),
    subjectKind: varchar("subject_kind", {
      length: 16,
      enum: ["user", "organization"],
    }).notNull(),
    subjectId: varchar("subject_id", { length: 192 }).notNull(),
    generation: integer("generation").notNull(),
    decisionRef: uuid("decision_ref").notNull(),
    previousDecisionRef: uuid("previous_decision_ref"),
    dispositionVersion: integer("disposition_version").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    decisionSequence: bigint("decision_sequence", { mode: "bigint" }),
    state: varchar("state", {
      length: 32,
      enum: [
        "pending",
        "external_committed",
        "projection_committed",
        "unresolved",
      ],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseId: uuid("lease_id"),
  },
  (t) => {
    return [
      uniqueIndex("account_erasure_ingress_event").on(t.audience, t.eventId),
      index("account_erasure_ingress_retry")
        .on(t.authorityId, t.audience, t.availableAt, t.confirmationRef)
        .where(
          sql`${t.state} IN ('pending', 'external_committed') AND ${t.attempts} < 5`,
        ),
      check(
        "account_erasure_ingress_shape",
        sql`${t.subjectKind} IN ('user', 'organization') AND octet_length(${t.subjectId}) BETWEEN 1 AND 192 AND octet_length(${t.audience}) BETWEEN 1 AND 192 AND octet_length(${t.eventId}) BETWEEN 1 AND 192 AND ${t.generation} > 0 AND ${t.dispositionVersion} > 0 AND ${t.deadlineAt} > ${t.requestedAt} AND ${t.attempts} BETWEEN 0 AND 5 AND (${t.decisionSequence} IS NULL OR ${t.decisionSequence} > 0)`,
      ),
      check(
        "account_erasure_ingress_state",
        sql`${t.state} IN ('pending', 'external_committed', 'projection_committed', 'unresolved') AND (${t.state} NOT IN ('external_committed', 'projection_committed') OR ${t.decisionSequence} IS NOT NULL)`,
      ),
    ];
  },
);

// A pass is explicitly bound to a target incarnation. Every new pass starts at
// zero; an old forward cursor cannot attest that restored projections survive.
export const accountErasureReplay = pgTable(
  "account_erasure_replay",
  {
    authorityId: uuid("authority_id").notNull(),
    audience: varchar("audience", { length: 192 }).notNull(),
    targetId: uuid("target_id").notNull(),
    replayGeneration: uuid("replay_generation").notNull(),
    watermark: bigint("watermark", { mode: "bigint" }).notNull(),
    cursor: bigint("cursor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    state: varchar("state", {
      length: 16,
      enum: ["pending", "complete", "unresolved"],
    })
      .notNull()
      .default("pending"),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  },
  (t) => {
    return [
      primaryKey({ columns: [t.authorityId, t.targetId, t.replayGeneration] }),
      check(
        "account_erasure_replay_shape",
        sql`${t.watermark} >= 0 AND ${t.cursor} >= 0 AND ${t.cursor} <= ${t.watermark} AND octet_length(${t.audience}) BETWEEN 1 AND 192 AND ${t.state} IN ('pending', 'complete', 'unresolved') AND (${t.state} <> 'complete' OR ${t.cursor} = ${t.watermark}) AND ((${t.leaseId} IS NULL) = (${t.leaseExpiresAt} IS NULL))`,
      ),
    ];
  },
);
