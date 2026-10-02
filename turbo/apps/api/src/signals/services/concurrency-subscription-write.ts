import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { sql } from "drizzle-orm";

import { timestampWithoutTimeZone } from "../../lib/time";

/** Advance the existing modification timestamp, including same-clock writes. */
export function concurrencySubscriptionUpdatedAt(at: Date) {
  return sql`GREATEST(
    ${orgConcurrencySubscriptions.updatedAt} + interval '1 microsecond',
    ${timestampWithoutTimeZone(at)}::timestamp
  )`;
}
