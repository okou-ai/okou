import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { sql } from "drizzle-orm";

/**
 * Native mail is globally retired. Purge its remaining unsent payloads before
 * any owner cascade can detach the old delivery association. Other templates
 * and completed mail are untouched; no retired relation is needed for cleanup.
 */
export function purgeRetiredMorningBriefEmailSql() {
  return sql`DELETE FROM ${emailOutbox} WHERE status IN ('pending','sending','failed')
    AND template->>'template' = 'morning-brief-result'`;
}
