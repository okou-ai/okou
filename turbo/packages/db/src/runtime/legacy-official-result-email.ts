import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type {
  EmailOutboxAddresses,
  EmailOutboxHeaders,
  EmailOutboxTemplate,
} from "@okouai/db/jsonb-contracts/email-outbox";

// Drain-only mappings for the retired platform completion email (#39524).
// Release-1 APIs (1.729.0 and earlier) can register its Run callback until they
// stop executing, so release 2 keeps one bounded consumer that finishes those
// captured callbacks under their permanent claim and outbox source identity.
// No current producer uses them, and the generic runtime mappings stay free of
// this storage. Release 3 of #39378 deletes this module with the consumer, then
// drops the physical storage, after no producer-capable API serves or is a
// rollback target and no retryable legacy callback or outbox entry remains.

/** The permanent per-source dedupe claim. It has no foreign keys. */
export const legacyOfficialResultEmailClaims = pgTable(
  "official_automation_result_email_claims",
  {
    runId: uuid("run_id").notNull(),
    workflowAutomationId: uuid("workflow_automation_id").notNull(),
    emailOutboxId: uuid("email_outbox_id").defaultRandom().notNull(),
  },
);

/** The columns the consumer writes, including the outbox source pair. */
export const legacyOfficialResultEmailOutbox = pgTable("email_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  fromAddress: text("from_address").notNull(),
  toAddresses: jsonb("to_addresses").$type<EmailOutboxAddresses>().notNull(),
  subject: text("subject").notNull(),
  headers: jsonb("headers").$type<EmailOutboxHeaders>(),
  template: jsonb("template").$type<EmailOutboxTemplate>().notNull(),
  sourceRunId: uuid("source_run_id"),
  sourceWorkflowAutomationId: uuid("source_workflow_automation_id"),
});
