import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
 * the opaque `attempt_id` the retired owner-scoped generation store recorded.
 * There is deliberately no foreign key to that store: receipts survive its
 * retirement and owner deletion as unattributable cost facts.
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
