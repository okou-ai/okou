import { integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  EmailOutboxAddresses,
  EmailOutboxHeaders,
  EmailOutboxProviderRequest,
  EmailOutboxTemplate,
} from "@okouai/db/jsonb-contracts/email-outbox";

/**
 * Shared physical and runtime `email_outbox` column builders. The retired
 * completion-email source pair is declared only by the physical schema.
 */
export function emailOutboxColumns() {
  return {
    id: uuid("id").defaultRandom().primaryKey(),

    // Email envelope
    fromAddress: text("from_address").notNull(),
    toAddresses: jsonb("to_addresses").$type<EmailOutboxAddresses>().notNull(),
    ccAddresses: jsonb("cc_addresses").$type<EmailOutboxAddresses>(),
    subject: text("subject").notNull(),
    replyTo: text("reply_to"),
    headers: jsonb("headers").$type<EmailOutboxHeaders>(),

    // Template (discriminated union stored as JSONB)
    template: jsonb("template").$type<EmailOutboxTemplate>().notNull(),

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
  };
}
