import { pgTable, check, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usageEventColumns } from "../columns/usage-event";
import { agentRuns } from "./agent-run";

/**
 * Per-event usage record for billable resources.
 *
 * One row per billable event (connector API call, model token usage, image
 * generation, future external-API call, etc.). Resource is identified by a
 * three-level classification — `kind` / `provider` / `category` — so queries
 * can filter at any level without string-parsing.
 *
 *   kind      provider                     category
 *   --------  ---------------------------  ------------------
 *   connector x                            tweet.read
 *   connector github                       issue.write
 *   model     claude-sonnet-4-6            tokens.input
 *   model     claude-sonnet-4-6            tokens.output
 *   image     fal-ai/nano-banana-2         output_image
 *   image     gpt-image-2                  tokens.output.image
 *   image     fal-ai/qwen-image            output_megapixel
 *   video     fal-ai/veo3.1/fast           output_video_seconds.audio
 *   video     bytedance/seedance-2.0       output_video_tokens
 *
 * Charging is applied by the billing processor, which looks up the
 * `(kind, provider, category)` pricing-table entry and writes `creditsCharged`.
 * Settlement is credit-only and never reprices processed usage.
 *
 * `billingError` is a short code naming a billing-time problem on the
 * row. NULL on healthy rows. Ops queries `WHERE billing_error IS NOT
 * NULL` to find revenue leaks and classification gaps. Known codes:
 *   - `missing_pricing`  — no row in `usage_pricing` matched either
 *     the exact `(kind, provider, category)` triple or the provider's
 *     `__fallback__` row; billed as `creditsCharged = 0` (revenue leak).
 *   - `fallback_pricing` — the exact `(kind, provider, category)` was
 *     unseeded, but the provider's `(kind, provider, "__fallback__")`
 *     row matched; billed at that fallback rate (classification gap).
 *
 * `idempotencyKey` is a caller-provided UUID for exactly-once semantics.
 * Writers must keep the same UUID across retries of the same logical
 * event; the UNIQUE index blocks duplicate insertions.
 * Zero quantities are discarded without an idempotency receipt. Transactional
 * writers may reserve a zero placeholder, but must remove it before commit if
 * its final quantity is zero. Positive usage is retained even when its charge
 * resolves to zero credits.
 *
 * Healthy usage remains `processed` for at least four days before hourly
 * rollup replacement, after which the source event is deleted.
 */
export const usageEvent = pgTable(
  "usage_event",
  {
    ...usageEventColumns(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "no action" },
    ),
  },
  (table) => {
    return [
      index("idx_usage_event_billing_run").on(table.billingRunId),
      check(
        "usage_event_billing_context_check",
        sql`(
        (${table.billingContext} = 'run' AND ${table.billingRunId} IS NOT NULL AND ${table.billingAnchorAt} IS NOT NULL)
        OR (${table.billingContext} = 'runless' AND ${table.billingRunId} IS NULL AND ${table.billingAnchorAt} IS NOT NULL)
        OR (${table.billingContext} = 'pi_memory_stage1' AND ${table.billingRunId} IS NULL AND ${table.runId} IS NULL AND ${table.billingAnchorAt} IS NOT NULL AND ${table.kind} = 'model' AND ${table.billingAnchorAt} = ${table.createdAt})
        OR (${table.billingContext} = 'missing_run' AND ${table.billingRunId} IS NOT NULL AND ${table.billingAnchorAt} IS NULL)
        OR (${table.billingContext} = 'legacy_unknown' AND ${table.billingRunId} IS NULL AND ${table.billingAnchorAt} IS NULL)
      )`,
      ),
      uniqueIndex("uq_usage_event_idempotency_key").on(table.idempotencyKey),
      index("idx_usage_event_run_id").on(table.runId),
      index("idx_usage_event_org_status").on(table.orgId, table.status),
      index("idx_usage_event_org_created").on(
        table.orgId,
        table.createdAt.desc(),
      ),
      index("idx_usage_event_model_created")
        .on(table.createdAt.desc())
        .where(sql`${table.kind} = 'model'`),
      index("idx_usage_event_org_user_status_processed").on(
        table.orgId,
        table.userId,
        table.status,
        table.processedAt,
      ),
      // Supports finalized usage reads over processed ledger windows.
      index("idx_usage_event_processed_org_user")
        .on(table.processedAt.desc(), table.orgId, table.userId)
        .where(
          sql`${table.status} = 'processed' AND ${table.processedAt} IS NOT NULL`,
        ),
    ];
  },
);
