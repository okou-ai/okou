import { pgTable, uuid, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { emailOutboxColumns } from "../columns/email-outbox";

/**
 * Email Outbox table
 * Queues outbound emails for rate-limited delivery via Resend.
 * Stores template name + props (not pre-rendered HTML) so the first delivery
 * attempt renders the template with the then-current version.
 *
 * The first attempt commits that rendered provider request and a provider
 * idempotency key derived from this row's id before any network send. Every
 * later attempt replays the committed request under the same key, so a provider
 * acceptance whose local completion is lost resolves to the same delivery
 * instead of a second email.
 *
 * Drain worker processes pending items at ≤2 req/s.
 * Items are retried up to 3 times with exponential backoff.
 *
 * `createdAt` alone fixes a row's 15-minute deadline. The drain admits a row
 * against that deadline while preparing it and rechecks the same deadline
 * immediately before calling the provider, so preparation work cannot carry an
 * item past its own lifetime; a row that crosses it in between fails locally
 * without a provider request. Expired items are then cleaned up by cron.
 */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    ...emailOutboxColumns(),
    // Migration-only producer identity of the retired platform completion
    // email. The runtime mapping omits it; release 3 of #39378 drops the pair,
    // its index and check after outgoing APIs drain and rollback excludes them.
    legacySourceRunId: uuid("source_run_id"),
    legacySourceWorkflowAutomationId: uuid("source_workflow_automation_id"),
  },
  (table) => {
    return [
      // Drain query: pending items ready to send, FIFO order
      index("email_outbox_drain_idx").on(
        table.status,
        table.nextRetryAt,
        table.createdAt,
      ),
      // TTL cleanup
      index("email_outbox_created_at_idx").on(table.createdAt),
      uniqueIndex("email_outbox_source_run_automation_unique").on(
        table.legacySourceRunId,
        table.legacySourceWorkflowAutomationId,
      ),
      // Two rows must never replay each other's provider request. Unprepared
      // rows keep a NULL key, which PostgreSQL treats as distinct.
      uniqueIndex("email_outbox_provider_idempotency_key_unique").on(
        table.providerIdempotencyKey,
      ),
      check(
        "email_outbox_source_identity_check",
        sql`(
          ${table.legacySourceRunId} IS NULL
          AND ${table.legacySourceWorkflowAutomationId} IS NULL
        ) OR (
          ${table.legacySourceRunId} IS NOT NULL
          AND ${table.legacySourceWorkflowAutomationId} IS NOT NULL
        )`,
      ),
    ];
  },
);
