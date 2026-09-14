import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const erasureOutcomes = [
  "pending",
  "retryable_failure",
  "capability_unresolved",
  "verified_erased",
  "verified_no_applicable_data",
] as const;

// No foreign key to Clerk, users, organizations, memberships, or resource roots.
// These are temporary local projections, not the independent recovery authority.
export const accountErasureJobs = pgTable(
  "account_erasure_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectKind: varchar("subject_kind", {
      length: 16,
      enum: ["user", "organization"],
    }).notNull(),
    subjectId: varchar("subject_id", { length: 192 }).notNull(),
    generation: integer("generation").notNull(),
    authorityId: uuid("authority_id").notNull(),
    decisionRef: uuid("decision_ref").notNull(),
    decisionSequence: bigint("decision_sequence", { mode: "bigint" }).notNull(),
    confirmationRef: uuid("confirmation_ref").notNull(),
    previousDecisionRef: uuid("previous_decision_ref"),
    dispositionVersion: integer("disposition_version").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    captureRevision: integer("capture_revision").notNull().default(1),
    inventoryRevision: integer("inventory_revision").notNull().default(1),
    sealedCaptureRevision: integer("sealed_capture_revision"),
    producerBoundaryRef: uuid("producer_boundary_ref"),
    retirementReleaseRef: uuid("retirement_release_ref"),
    state: varchar("state", { length: 32, enum: erasureOutcomes })
      .notNull()
      .default("pending"),
  },
  (t) => {
    return [
      uniqueIndex("account_erasure_subject_generation").on(
        t.subjectKind,
        t.subjectId,
        t.generation,
      ),
      uniqueIndex("account_erasure_decision").on(t.decisionRef),
      uniqueIndex("account_erasure_authority_sequence").on(
        t.authorityId,
        t.decisionSequence,
      ),
      check(
        "account_erasure_positive_versions",
        sql`${t.generation} > 0 AND ${t.decisionSequence} > 0 AND ${t.dispositionVersion} > 0 AND ${t.captureRevision} > 0 AND ${t.inventoryRevision} > 0`,
      ),
      check(
        "account_erasure_subject_kind",
        sql`${t.subjectKind} IN ('user', 'organization')`,
      ),
      check(
        "account_erasure_job_outcome",
        sql`${t.state} IN ('pending', 'retryable_failure', 'capability_unresolved', 'verified_erased', 'verified_no_applicable_data')`,
      ),
    ];
  },
);

export const accountErasureSinks = pgTable(
  "account_erasure_sinks",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => {
        return accountErasureJobs.id;
      }),
    sinkId: uuid("sink_id").notNull(),
    domain: varchar("domain", {
      length: 24,
      enum: [
        "relational",
        "objects",
        "providers",
        "telemetry",
        "recovery",
        "client",
      ],
    }).notNull(),
    inventoryRevision: integer("inventory_revision").notNull(),
    collectorVersion: uuid("collector_version").notNull(),
  },
  (t) => {
    return [
      primaryKey({ columns: [t.jobId, t.sinkId] }),
      check(
        "account_erasure_sink_domain",
        sql`${t.domain} IN ('relational', 'objects', 'providers', 'telemetry', 'recovery', 'client')`,
      ),
    ];
  },
);

export const accountErasureWork = pgTable(
  "account_erasure_work",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => {
        return accountErasureJobs.id;
      }),
    sinkId: uuid("sink_id").notNull(),
    itemKey: uuid("item_key").notNull(),
    generation: integer("generation").notNull(),
    kind: varchar("kind", {
      length: 16,
      enum: ["inventory", "erase", "recovery"],
    }).notNull(),
    selectorCiphertext: text("selector_ciphertext"),
    selectorDigest: varchar("selector_digest", { length: 64 }).notNull(),
    selectorCaptureRevision: integer("selector_capture_revision").notNull(),
    cursorCiphertext: text("cursor_ciphertext"),
    cursorDigest: varchar("cursor_digest", { length: 64 }),
    captureComplete: boolean("capture_complete").notNull().default(false),
    enumerationRef: uuid("enumeration_ref"),
    state: varchar("state", { length: 32, enum: erasureOutcomes })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    errorCode: varchar("error_code", {
      length: 32,
      enum: [
        "handler_missing",
        "selector_missing",
        "permission_missing",
        "ownership_unknown",
        "boundary_unproven",
        "verification_failed",
        "deadline_exceeded",
        "retry_exhausted",
      ],
    }),
    requestRef: uuid("request_ref"),
    evidenceRef: uuid("evidence_ref"),
    proofCaptureRevision: integer("proof_capture_revision"),
    proofInventoryRevision: integer("proof_inventory_revision"),
    proofBoundaryRef: uuid("proof_boundary_ref"),
    proofReaderRef: uuid("proof_reader_ref"),
    proofObservedAt: timestamp("proof_observed_at", { withTimezone: true }),
  },
  (t) => {
    return [
      uniqueIndex("account_erasure_work_identity").on(
        t.jobId,
        t.sinkId,
        t.itemKey,
        t.generation,
      ),
      index("account_erasure_work_claim").on(t.jobId, t.availableAt, t.id),
      foreignKey({
        name: "account_erasure_work_sink_fk",
        columns: [t.jobId, t.sinkId],
        foreignColumns: [accountErasureSinks.jobId, accountErasureSinks.sinkId],
      }),
      index("account_erasure_work_capture").on(
        t.jobId,
        t.selectorCaptureRevision,
      ),
      check(
        "account_erasure_work_outcome",
        sql`${t.state} IN ('pending', 'retryable_failure', 'capability_unresolved', 'verified_erased', 'verified_no_applicable_data')`,
      ),
      check(
        "account_erasure_work_kind",
        sql`${t.kind} IN ('inventory', 'erase', 'recovery')`,
      ),
      check(
        "account_erasure_terminal_proof",
        sql`${t.state} NOT IN ('verified_erased', 'verified_no_applicable_data') OR (${t.evidenceRef} IS NOT NULL AND ${t.proofCaptureRevision} IS NOT NULL AND ${t.proofInventoryRevision} IS NOT NULL AND ${t.proofBoundaryRef} IS NOT NULL AND ${t.proofReaderRef} IS NOT NULL AND ${t.proofObservedAt} IS NOT NULL AND ${t.enumerationRef} IS NOT NULL)`,
      ),
      check(
        "account_erasure_capture_version",
        sql`${t.selectorCaptureRevision} > 0 AND ${t.generation} > 0 AND ${t.attemptCount} >= 0`,
      ),
      check(
        "account_erasure_lease_pair",
        sql`(${t.leaseId} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
      ),
      check(
        "account_erasure_selector_size",
        sql`${t.selectorCiphertext} IS NULL OR octet_length(${t.selectorCiphertext}) <= 16384`,
      ),
      check(
        "account_erasure_cursor_size",
        sql`${t.cursorCiphertext} IS NULL OR octet_length(${t.cursorCiphertext}) <= 16384`,
      ),
      check(
        "account_erasure_cursor_pair",
        sql`(${t.cursorCiphertext} IS NULL) = (${t.cursorDigest} IS NULL)`,
      ),
      check(
        "account_erasure_complete_enumeration",
        sql`NOT ${t.captureComplete} OR ${t.enumerationRef} IS NOT NULL`,
      ),
    ];
  },
);

export const accountErasurePages = pgTable(
  "account_erasure_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workId: uuid("work_id")
      .notNull()
      .references(() => {
        return accountErasureWork.id;
      }),
    captureRevision: integer("capture_revision").notNull(),
    pageKey: uuid("page_key").notNull(),
    digest: varchar("digest", { length: 64 }).notNull(),
    inputCursorDigest: varchar("input_cursor_digest", { length: 64 }),
  },
  (t) => {
    return [
      uniqueIndex("account_erasure_page_identity").on(
        t.workId,
        t.captureRevision,
        t.pageKey,
      ),
    ];
  },
);

// No FK on dependency keys: a later bounded page may capture the dependency.
// Absence therefore blocks retirement instead of implicitly completing it.
export const accountErasureSelectorDependencies = pgTable(
  "account_erasure_selector_dependencies",
  {
    workId: uuid("work_id")
      .notNull()
      .references(() => {
        return accountErasureWork.id;
      }),
    sinkId: uuid("sink_id").notNull(),
    itemKey: uuid("item_key").notNull(),
    obligation: varchar("obligation", {
      length: 16,
      enum: ["erasure", "recovery"],
    }).notNull(),
  },
  (t) => {
    return [primaryKey({ columns: [t.workId, t.sinkId, t.itemKey] })];
  },
);
