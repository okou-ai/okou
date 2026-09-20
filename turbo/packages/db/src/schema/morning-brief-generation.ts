import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { MorningBriefRetainedSources } from "../jsonb-contracts/morning-brief-generation";
import { morningBriefCollectionOccurrences } from "./morning-brief-collection-occurrence";

/**
 * A SQL literal list built from a program constant.
 *
 * The enumerations below are compile-time constants with no caller input, and
 * the database has to reject an unexpected value itself: a TypeScript union is
 * a claim about writers this process controls, not a guarantee about the text
 * already stored in a column.
 */
function sqlLiterals(values: readonly string[]): string {
  return values
    .map((value) => {
      return `'${value}'`;
    })
    .join(", ");
}

/**
 * The prompt and result-schema contracts one generation was produced under.
 *
 * They are provenance: a stored result records exactly which prompt and which
 * validated shape produced it. They are deliberately **not** part of the
 * generation's logical identity, so bumping either can never open a second
 * provider invocation for an occurrence that already has one.
 */
export const MORNING_BRIEF_GENERATION_PROMPT_VERSION = 1;
export const MORNING_BRIEF_GENERATION_RESULT_SCHEMA_VERSION = 1;

/**
 * Why a generation exists, and who may consume its result.
 *
 * `preview` is the explicitly invoked, production-unreachable path. A later
 * production delivery reads results by purpose, so a preview result can never
 * be delivered merely because it shares an owner and an anchor with a
 * production occurrence. Purpose is recorded on the row rather than keyed into
 * it, which keeps one occurrence to one generation.
 */
export const MORNING_BRIEF_GENERATION_PURPOSES = [
  "preview",
  "production",
] as const;

/**
 * Where one generation stopped.
 *
 * `reserved` is the only non-terminal state and is deliberately ambiguous: it
 * is committed *before* the provider request, so a crash, a lost response or a
 * failed result commit all leave it. Nothing may re-send for a reserved
 * occurrence; an expired reservation resolves to `invocation_outcome_unknown`.
 *
 * - `succeeded` — a validated deliver or model skip was accepted.
 * - `output_rejected` — the provider answered and was billed, but the output
 *   failed validation. Never a skip, and never an accepted result.
 * - `provider_failed` — the provider returned an error or its response could
 *   not be read within the response budget.
 * - `not_invoked` — the reservation was committed but a deterministic check
 *   stopped the request before any provider contact. This is a
 *   failure-before-contact and is deliberately distinct from unknown.
 * - `result_discarded` — a result was observed, but this attempt no longer held
 *   the reservation when it tried to accept it, so no owner content was stored.
 * - `invocation_outcome_unknown` — the request may have reached the provider
 *   and no outcome could be recorded. This is not a failure-before-contact.
 * - `skipped_empty` — every applicable read succeeded with zero candidates.
 *   Zero model calls.
 * - `skipped_incomplete` — a bounded or partial read produced zero candidates.
 *   Zero model calls, and deliberately distinct from a healthy empty day.
 */
export const MORNING_BRIEF_GENERATION_STATES = [
  "reserved",
  "succeeded",
  "output_rejected",
  "provider_failed",
  "not_invoked",
  "result_discarded",
  "invocation_outcome_unknown",
  "skipped_empty",
  "skipped_incomplete",
] as const;

/** The accepted decision a validated model result carries. */
export const MORNING_BRIEF_GENERATION_DECISIONS = ["deliver", "skip"] as const;

/** Bounded, enumerated reasons an observed result produced no owner content. */
export const MORNING_BRIEF_GENERATION_FAILURE_REASONS = [
  "not_configured",
  "provider_error",
  "response_unreadable",
  "transport_failed",
  "output_truncated",
  "unexpected_tool_calls",
  "invalid_json",
  "invalid_shape",
  "unknown_source_reference",
  "empty_deliver",
  "result_too_large",
  "reservation_expired",
  "owner_revoked",
  "binding_changed",
  "persistence_failed",
] as const;

/**
 * The collected coverage a generation was produced from.
 *
 * It mirrors the collector's own vocabulary because the distinction between a
 * healthy empty read and a bounded one is exactly what this pipeline must never
 * lose.
 */
export const MORNING_BRIEF_GENERATION_SOURCE_COVERAGES = [
  "complete",
  "partial",
  "empty",
] as const;

/**
 * How the generation language was resolved.
 *
 * `agent-instructions` records that the admitted Agent's complete instruction
 * text travelled in the one request and was allowed to steer the output
 * language. It is deliberately not a claim that the text contained a language
 * directive: that decision belongs to the same call, and the fallback locale
 * travels with it.
 */
export const MORNING_BRIEF_GENERATION_LANGUAGE_SOURCES = [
  "agent-instructions",
  "member-locale",
  "default",
] as const;

/**
 * The states that prove this attempt never reached the provider.
 *
 * Everything else — including `reserved`, which is committed before the request
 * — means a request may already have been sent and must never be sent again.
 * The partial unique index below is built from exactly this list, so the
 * database itself decides the question rather than a caller's judgement.
 */
export const MORNING_BRIEF_GENERATION_UNINVOKED_STATES = [
  "not_invoked",
  "skipped_empty",
  "skipped_incomplete",
] as const;

/**
 * One owner-scoped Morning Brief generation and its accepted result.
 *
 * Its logical identity is exactly one collection occurrence, so an occurrence
 * can admit at most one provider invocation and hold at most one accepted
 * result. Purpose, prompt version, result-schema version and model are
 * provenance columns for that single slot; changing any of them cannot create a
 * second slot for the same occurrence.
 *
 * Durable ownership is inherited rather than re-invented. The composite key to
 * `morning_brief_collection_occurrences` cascades, and that table is itself
 * keyed to the member's `org_members_metadata` row and to the installation's
 * Agent. Membership, user and organization cleanup, Agent deletion and the
 * collection's own explicit revocation therefore remove these rows too, with no
 * detached result left behind.
 *
 * It stores no raw source body, no prompt, no provider payload and no
 * credential. What it keeps is the accepted, program-rendered result plus the
 * bounded facts needed to interpret it. `input_digest` describes what was sent;
 * it is not a checkpoint and cannot reproduce a bundle.
 */
export const morningBriefGenerations = pgTable(
  "morning_brief_generations",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    scheduledFor: timestamp("scheduled_for").notNull(),
    collectionKind: text("collection_kind").notNull(),
    collectionVersion: integer("collection_version").notNull(),

    /** Who may consume this result. Never a key column. */
    executionPurpose: text("execution_purpose", {
      enum: MORNING_BRIEF_GENERATION_PURPOSES,
    }).notNull(),
    /** The opaque attempt this slot admitted. Shared with the platform receipt. */
    attemptId: uuid("attempt_id").notNull(),
    state: text("state", { enum: MORNING_BRIEF_GENERATION_STATES }).notNull(),

    /** The membership generation that must still hold to accept content. */
    membershipId: text("membership_id").notNull(),
    /** The installation Agent pinned at admission, for provenance. */
    agentId: uuid("agent_id").notNull(),
    /**
     * The complete canonical binding that authorized an all-source request.
     *
     * Nullable only for historical Slack-only rows written before retained
     * source proof existed. A current all-source writer always sets both ids;
     * `chat_thread_id` itself remains nullable because email-only is valid.
     */
    installationId: uuid("installation_id"),
    automationId: uuid("automation_id"),
    chatThreadId: uuid("chat_thread_id"),

    /** The exact model this slot requested. Never a generic default. */
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    resultSchemaVersion: integer("result_schema_version").notNull(),
    language: text("language").notNull(),
    languageSource: text("language_source", {
      enum: MORNING_BRIEF_GENERATION_LANGUAGE_SOURCES,
    }).notNull(),

    /** SHA-256 of the exact normalized model input. Not a checkpoint. */
    inputDigest: text("input_digest").notNull(),
    /** Candidates the bundle offered, and how many actually travelled. */
    inputItems: integer("input_items").notNull(),
    includedItems: integer("included_items").notNull(),
    /** True when deterministic reduction dropped candidates before sending. */
    inputReduced: boolean("input_reduced").notNull(),
    /** The collected coverage this generation was produced from. */
    sourceCoverage: text("source_coverage", {
      enum: MORNING_BRIEF_GENERATION_SOURCE_COVERAGES,
    }).notNull(),

    /**
     * The frozen provenance of the instruction text that travelled, if any.
     *
     * The text itself is ephemeral and never stored. What is kept is the exact
     * version the request was assembled from and its digest, so a later
     * instruction-only edit is detectable without being able to reproduce
     * either version, and without becoming a reason to send a second request.
     */
    instructionsVersionId: text("instructions_version_id"),
    instructionsDigest: text("instructions_digest"),
    /**
     * The output-language tag the invocation reported for itself.
     *
     * Provenance, not verification: it records what the answer claimed to be
     * written in. An unrecognized tag is stored as null rather than coerced to
     * the fallback, which would assert a language nothing observed.
     */
    reportedLanguage: text("reported_language"),
    /**
     * The bounded, credential-free proof that each supplied input was
     * authorized, cited or not.
     *
     * It identifies the inputs a later phase must revalidate; it can never
     * fetch them again, and it holds no source body, prompt or credential.
     */
    retainedSources:
      jsonb("retained_sources").$type<MorningBriefRetainedSources>(),
    /**
     * How long that proof outlives the result body.
     *
     * The body expires on `expires_at`; the proof has to survive at least that
     * long, because an obligation created just before the body expired is
     * still owed a permission check afterwards. It is never reset by a retry.
     */
    retainedUntil: timestamp("retained_until"),

    /** Finite phase ownership: never the collection lease, never unbounded. */
    reservedAt: timestamp("reserved_at").notNull(),
    reservationExpiresAt: timestamp("reservation_expires_at").notNull(),
    /** Bounded preview retention, consumed by the owner-scoped sweep. */
    expiresAt: timestamp("expires_at").notNull(),
    finishedAt: timestamp("finished_at"),
    /** When the accepted body was cleared while its invocation fence survived. */
    contentPurgedAt: timestamp("content_purged_at"),

    decision: text("decision", { enum: MORNING_BRIEF_GENERATION_DECISIONS }),
    /** The model's own validated no-content reason, never a provider failure. */
    skipReason: text("skip_reason"),
    resultTitle: text("result_title"),
    /** Program-rendered safe Markdown. The model never supplies links. */
    resultMarkdown: text("result_markdown"),
    resultBytes: integer("result_bytes"),
    failureReason: text("failure_reason", {
      enum: MORNING_BRIEF_GENERATION_FAILURE_REASONS,
    }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "morning_brief_generations_pk",
        columns: [
          table.orgId,
          table.userId,
          table.scheduledFor,
          table.collectionKind,
          table.collectionVersion,
        ],
      }),
      foreignKey({
        name: "fk_morning_brief_generations_occurrence",
        columns: [
          table.orgId,
          table.userId,
          table.scheduledFor,
          table.collectionKind,
          table.collectionVersion,
        ],
        foreignColumns: [
          morningBriefCollectionOccurrences.orgId,
          morningBriefCollectionOccurrences.userId,
          morningBriefCollectionOccurrences.scheduledFor,
          morningBriefCollectionOccurrences.collectionKind,
          morningBriefCollectionOccurrences.collectionVersion,
        ],
      }).onDelete("cascade"),
      // The bounded retention sweep and the user-wide revocation both scan by
      // owner rather than by the full occurrence key.
      index("idx_morning_brief_generations_owner_expiry").on(
        table.orgId,
        table.userId,
        table.expiresAt,
      ),
      // Physical retention cannot depend on an owner coming back, so the
      // maintenance purge scans every owner's expired rows in deadline order.
      // The owner-prefixed index above cannot serve that scan, so the bounded
      // batch gets its own index range instead of a sequential scan.
      index("idx_morning_brief_generations_expiry").on(table.expiresAt),
      // Every enumerated column is enforced by the database, so a reader never
      // has to guess what an unexpected stored value means.
      check(
        "chk_morning_brief_generation_purpose",
        sql`${table.executionPurpose} IN (${sql.raw(sqlLiterals(MORNING_BRIEF_GENERATION_PURPOSES))})`,
      ),
      check(
        "chk_morning_brief_generation_state",
        sql`${table.state} IN (${sql.raw(sqlLiterals(MORNING_BRIEF_GENERATION_STATES))})`,
      ),
      check(
        "chk_morning_brief_generation_language_source",
        sql`${table.languageSource} IN (${sql.raw(sqlLiterals(MORNING_BRIEF_GENERATION_LANGUAGE_SOURCES))})`,
      ),
      // Coverage decides whether an empty day was healthy, so an unrecognized
      // value must never reach a reader that would have to interpret it.
      check(
        "chk_morning_brief_generation_coverage",
        sql`${table.sourceCoverage} IN (${sql.raw(sqlLiterals(MORNING_BRIEF_GENERATION_SOURCE_COVERAGES))})`,
      ),
      check(
        "chk_morning_brief_generation_failure_reason",
        sql`${table.failureReason} IS NULL
          OR ${table.failureReason} IN (${sql.raw(sqlLiterals(MORNING_BRIEF_GENERATION_FAILURE_REASONS))})`,
      ),
      check(
        "chk_morning_brief_generation_skip_reason",
        sql`(${table.decision} = 'skip') = (${table.skipReason} IS NOT NULL)`,
      ),
      // Only a terminal state carries a finished instant, so a reserved slot
      // can never look settled.
      check(
        "chk_morning_brief_generation_finished",
        sql`(${table.state} = 'reserved') = (${table.finishedAt} IS NULL)`,
      ),
      // An accepted result exists exactly in the succeeded state, and a
      // delivered one always carries rendered content plus its real byte size.
      // The size is stored rather than recomputed, so nothing downstream has to
      // substitute a string length for a UTF-8 byte count.
      check(
        "chk_morning_brief_generation_decision",
        sql`(${table.state} = 'succeeded') = (${table.decision} IS NOT NULL)
          AND (${table.decision} = 'deliver') =
            ((${table.resultMarkdown} IS NOT NULL
              AND ${table.resultTitle} IS NOT NULL
              AND ${table.resultBytes} IS NOT NULL)
             OR (${table.contentPurgedAt} IS NOT NULL
              AND ${table.resultMarkdown} IS NULL
              AND ${table.resultTitle} IS NULL
              AND ${table.resultBytes} IS NULL))
          AND (${table.contentPurgedAt} IS NULL
            OR (${table.state} = 'succeeded' AND ${table.decision} = 'deliver'))
          AND (${table.resultBytes} IS NULL OR ${table.resultBytes} > 0)`,
      ),
      check(
        "chk_morning_brief_generation_included_items",
        sql`${table.includedItems} >= 0 AND ${table.includedItems} <= ${table.inputItems}`,
      ),
      // One anchor, one possible provider invocation — across every collection
      // kind and contract version this owner may have been admitted under.
      //
      // The occurrence primary key alone cannot say this: a source-independent
      // occurrence is a different kind from a Slack-only one, so two rows can
      // legitimately exist for one owner and one morning. What must never
      // happen is a second request for that morning, and a caller-side check
      // cannot guarantee it under concurrency. This index does: a row that may
      // have reached the provider occupies the anchor, and a competing INSERT
      // fails rather than sending again. Rows in a state that proves no contact
      // leave the anchor free, which is what makes an uninvoked reservation
      // legitimately retryable.
      uniqueIndex("uq_morning_brief_generations_invoked_anchor")
        .on(
          table.orgId,
          table.userId,
          table.scheduledFor,
          table.executionPurpose,
        )
        .where(
          sql`${table.state} NOT IN (${sql.raw(sqlLiterals(MORNING_BRIEF_GENERATION_UNINVOKED_STATES))})`,
        ),
      check(
        "chk_morning_brief_generation_reservation",
        sql`${table.reservationExpiresAt} > ${table.reservedAt}
          AND ${table.expiresAt} > ${table.reservedAt}`,
      ),
      // Source proof may outlive the body it was collected for, never the
      // other way round: a row whose proof expired first would leave content
      // that no later check could authorize.
      check(
        "chk_morning_brief_generation_retained_until",
        sql`${table.retainedUntil} IS NULL
          OR ${table.retainedUntil} >= ${table.expiresAt}`,
      ),
      // Provenance is a pair. Half of it would describe a version whose
      // content nothing can be compared against.
      check(
        "chk_morning_brief_generation_instructions",
        sql`(${table.instructionsVersionId} IS NULL) =
          (${table.instructionsDigest} IS NULL)`,
      ),
    ];
  },
);

/** Which request field the stored provider cost was parsed from. */
export const MORNING_BRIEF_PLATFORM_COST_SOURCES = [
  "chat_completion_usage_cost",
  "generation_total_cost",
] as const;

/**
 * Whether the platform knows what this invocation cost.
 *
 * - `reported` — the provider returned a finite, non-negative `usage.cost`. An
 *   explicitly reported zero is a known zero, not a missing value.
 * - `unavailable` — a response was read, but it carried no usable cost. The
 *   generation id is retained so the charge can be reconciled out of band.
 * - `invocation_unknown` — no response was read at all, so whether anything was
 *   charged is unknown.
 *
 * Token counts never imply a known cost, and a token count is never converted
 * into an amount here.
 */
export const MORNING_BRIEF_PLATFORM_COST_STATES = [
  "reported",
  "unavailable",
  "invocation_unknown",
] as const;

/**
 * The exact domain a receipt's token columns can hold.
 *
 * They are `integer`, so PostgreSQL rejects anything above this with
 * `integer out of range` and the whole receipt INSERT fails with it. A parser
 * that accepts a wider range therefore does not record a wider range: it
 * discards the cost, the sibling counts and the invocation record together.
 * Readers and writers import this bound instead of restating it.
 */
export const MORNING_BRIEF_PLATFORM_RECEIPT_MAX_TOKENS = 2_147_483_647;

/**
 * The exact domain `cost_value` can hold, as `numeric(precision, scale)`.
 *
 * `scale` fractional digits are kept and anything finer is *rounded away* by
 * PostgreSQL, which would silently turn a small reported amount into a durable
 * reported zero. `precision - scale` integral digits are permitted and a larger
 * amount fails with `numeric field overflow`. An amount this column cannot hold
 * exactly is unavailable, never rounded and never stored as an approximation.
 */
export const MORNING_BRIEF_PLATFORM_RECEIPT_COST_PRECISION = 24;
export const MORNING_BRIEF_PLATFORM_RECEIPT_COST_SCALE = 12;

/** What the platform observed at the provider boundary. */
export const MORNING_BRIEF_PLATFORM_RECEIPT_OUTCOMES = [
  "response_received",
  "provider_error",
  "response_unreadable",
  "invocation_unknown",
] as const;

/**
 * One anonymous platform spend receipt for one provider invocation.
 *
 * Okou funds these requests, so the record of what they cost belongs to the
 * platform and not to any organization's ledger. Nothing here writes
 * `usage_event`, a credit debit, an allowance or a balance row, and nothing
 * here participates in organization billing.
 *
 * It carries **no** organization, user, Agent, thread, occurrence or source
 * identity, and no prompt, source body or generated text. The only linkage is
 * the opaque `attempt_id` an owner-scoped generation row also records. There is
 * deliberately no foreign key in either direction: a receipt must be writable
 * for an invocation whose owner was erased mid-flight, and a receipt must
 * survive owner deletion. Once the owner row is gone the linkage is gone with
 * it, and what remains is an unattributable cost fact.
 */
export const morningBriefPlatformGenerationReceipts = pgTable(
  "morning_brief_platform_generation_receipts",
  {
    /** The opaque attempt id. Idempotency key: one invocation, one receipt. */
    attemptId: uuid("attempt_id").primaryKey(),
    operation: text("operation").notNull(),
    provider: text("provider").notNull(),
    requestedModel: text("requested_model").notNull(),
    /** What the provider says it served. May differ from the request. */
    returnedModel: text("returned_model"),
    /** The provider's own generation id, when one was returned. */
    providerGenerationId: text("provider_generation_id"),
    outcome: text("outcome", {
      enum: MORNING_BRIEF_PLATFORM_RECEIPT_OUTCOMES,
    }).notNull(),

    costState: text("cost_state", {
      enum: MORNING_BRIEF_PLATFORM_COST_STATES,
    }).notNull(),
    /** The exact reported amount, stored without conversion or rounding. */
    costValue: numeric("cost_value", {
      precision: MORNING_BRIEF_PLATFORM_RECEIPT_COST_PRECISION,
      scale: MORNING_BRIEF_PLATFORM_RECEIPT_COST_SCALE,
    }),
    /** The provider's own unit. Never Okou user credits, never assumed USD. */
    costUnit: text("cost_unit"),
    costSource: text("cost_source", {
      enum: MORNING_BRIEF_PLATFORM_COST_SOURCES,
    }),

    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedTokens: integer("cached_tokens"),
    totalTokens: integer("total_tokens"),

    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_morning_brief_platform_generation_receipts_started").on(
        table.startedAt,
      ),
      check(
        "chk_morning_brief_platform_receipt_outcome",
        sql`${table.outcome} IN (${sql.raw(sqlLiterals(MORNING_BRIEF_PLATFORM_RECEIPT_OUTCOMES))})`,
      ),
      check(
        "chk_morning_brief_platform_receipt_cost_state",
        sql`${table.costState} IN (${sql.raw(sqlLiterals(MORNING_BRIEF_PLATFORM_COST_STATES))})`,
      ),
      check(
        "chk_morning_brief_platform_receipt_cost_source",
        sql`${table.costSource} IS NULL
          OR ${table.costSource} IN (${sql.raw(sqlLiterals(MORNING_BRIEF_PLATFORM_COST_SOURCES))})`,
      ),
      check(
        "chk_morning_brief_platform_receipt_tokens",
        sql`(${table.promptTokens} IS NULL OR ${table.promptTokens} >= 0)
          AND (${table.completionTokens} IS NULL OR ${table.completionTokens} >= 0)
          AND (${table.reasoningTokens} IS NULL OR ${table.reasoningTokens} >= 0)
          AND (${table.cachedTokens} IS NULL OR ${table.cachedTokens} >= 0)
          AND (${table.totalTokens} IS NULL OR ${table.totalTokens} >= 0)`,
      ),
      // An amount exists exactly when one was reported, and it always carries
      // the unit and field it came from.
      check(
        "chk_morning_brief_platform_receipt_cost",
        sql`(${table.costState} = 'reported') =
            (${table.costValue} IS NOT NULL
             AND ${table.costUnit} IS NOT NULL
             AND ${table.costSource} IS NOT NULL)
          AND (${table.costValue} IS NULL OR ${table.costValue} >= 0)`,
      ),
      check(
        "chk_morning_brief_platform_receipt_times",
        sql`${table.finishedAt} >= ${table.startedAt}`,
      ),
    ];
  },
);
