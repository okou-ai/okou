import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  EmailOutboxAddresses,
  EmailOutboxHeaders,
  EmailOutboxProviderRequest,
  EmailOutboxTemplate,
} from "@okouai/db/jsonb-contracts/email-outbox";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

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
    id: uuid("id").defaultRandom().primaryKey(),

    // Email envelope
    fromAddress: text("from_address").notNull(),
    toAddresses: jsonb("to_addresses").$type<EmailOutboxAddresses>().notNull(),
    ccAddresses: jsonb("cc_addresses").$type<EmailOutboxAddresses>(),
    subject: text("subject").notNull(),
    replyTo: text("reply_to"),
    headers: jsonb("headers").$type<EmailOutboxHeaders>(),
    publicBrand: text("public_brand")
      .$type<PublicBrand>()
      .default("vm0")
      .notNull(),

    // Template (discriminated union stored as JSONB)
    template: jsonb("template").$type<EmailOutboxTemplate>().notNull(),

    // Durable producer identity. The pair is intentionally not foreign-keyed:
    // deleting a completed Run or Automation must not discard queued email.
    sourceRunId: uuid("source_run_id"),
    sourceWorkflowAutomationId: uuid("source_workflow_automation_id"),

    // Committed provider identity and payload. Both are null until the first
    // delivery attempt prepares them; rows enqueued by a producer never set
    // them, and rows written before this column existed prepare them on their
    // next attempt. The request is cleared once the row is delivered, so the
    // rendered message is retained only while a replay can still need it.
    providerIdempotencyKey: text("provider_idempotency_key"),
    providerRequest:
      jsonb("provider_request").$type<EmailOutboxProviderRequest>(),

    // Queue status
    status: text("status").notNull().default("pending"), // pending | sending | sent | failed
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // Retry backoff for a pending item, and the recovery lease of a `sending`
    // item whose provider outcome was never recorded.
    nextRetryAt: timestamp("next_retry_at"),
    resendId: text("resend_id"), // Resend internal ID (filled after send)

    createdAt: timestamp("created_at").defaultNow().notNull(),
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
        table.sourceRunId,
        table.sourceWorkflowAutomationId,
      ),
      // Two rows must never replay each other's provider request. Unprepared
      // rows keep a NULL key, which PostgreSQL treats as distinct.
      uniqueIndex("email_outbox_provider_idempotency_key_unique").on(
        table.providerIdempotencyKey,
      ),
      check(
        "email_outbox_source_identity_check",
        sql`(
          ${table.sourceRunId} IS NULL
          AND ${table.sourceWorkflowAutomationId} IS NULL
        ) OR (
          ${table.sourceRunId} IS NOT NULL
          AND ${table.sourceWorkflowAutomationId} IS NOT NULL
        )`,
      ),
    ];
  },
);
