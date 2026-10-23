import { commerceJobs } from "@okouai/db/schema/commerce-job";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { command } from "ccstate";
import { and, eq, or, sql } from "drizzle-orm";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";
import {
  checkManagedCredits$,
  type ManagedUsageCreditCheckArgs,
} from "./managed-usage.service";

// Both priority-2 endpoints cost $0.003 per bounded task.
const PREFLIGHT_MICROS = 3000;

/** Admission accounts for unpaid accepted Commerce tasks. */
export const checkCommerceCredits$ = command(
  async ({ set }, args: ManagedUsageCreditCheckArgs, signal: AbortSignal) => {
    const db = set(writeDb$);
    // A task is already paid at the provider when accepted. Include unsettled
    // tasks, and conservatively unknown submissions, before accepting more work.
    // Round each liability to credits separately, as settlement does. This is
    // still an estimate, not an atomic reservation across concurrent requests.
    const [liability] = await db
      .select({
        credits:
          sql`COALESCE(SUM(CEIL(COALESCE(CEIL(${commerceJobs.providerCostUsd} * 1000000), ${PREFLIGHT_MICROS})::numeric * ${usagePricing.unitPrice}::numeric / ${usagePricing.unitSize}::numeric)), 0)::bigint`.mapWith(
            pgInt8ToSafeIntegerDecoder,
          ),
      })
      .from(commerceJobs)
      .innerJoin(
        usagePricing,
        and(
          eq(usagePricing.kind, args.resource.kind),
          eq(usagePricing.provider, args.resource.provider),
          eq(usagePricing.category, args.resource.category),
        ),
      )
      .where(
        and(
          eq(commerceJobs.orgId, args.orgId),
          or(
            eq(commerceJobs.status, "pending"),
            eq(commerceJobs.status, "running"),
            and(
              eq(commerceJobs.status, "failed"),
              eq(
                sql`${commerceJobs.error}->>'code'`,
                "COMMERCE_SUBMISSION_UNCERTAIN",
              ),
            ),
          ),
        ),
      );
    signal.throwIfAborted();
    if (!liability) {
      throw new Error("Commerce liability aggregate was not returned");
    }
    return await set(
      checkManagedCredits$,
      {
        ...args,
        reservedCredits: (args.reservedCredits ?? 0) + liability.credits,
      },
      signal,
    );
  },
);
