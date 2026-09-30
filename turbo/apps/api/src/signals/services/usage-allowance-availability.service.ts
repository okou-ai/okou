import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { safeSync } from "../utils";
import { recordBillingOperationTimings } from "../external/sandbox-op-log";
import { prepareUsageAllowanceRefresh$ } from "./usage-allowance.service";
import {
  entitlementQuery,
  planPreparedAllowanceEntitlement,
} from "./usage-allowance-settlement-plan";
import {
  allowanceAvailabilityQuery,
  allowanceAvailability,
  currentAllowanceEntitlement,
  type AllowanceAvailability,
} from "./usage-allowance-availability-plan";

export const resolveUsageAllowanceAvailability$ = command(
  async (
    { set },
    orgId: string,
    signal?: AbortSignal,
  ): Promise<AllowanceAvailability | null> => {
    const db = set(writeDb$);
    const startedAt = performance.now();
    const observedAt = nowDate();
    let availability = allowanceAvailability(
      await db.select().from(allowanceAvailabilityQuery(orgId, observedAt)),
      observedAt,
    );
    signal?.throwIfAborted();
    if (availability === "allowance_refresh_required") {
      const refresh = await set(
        prepareUsageAllowanceRefresh$,
        { orgId },
        signal,
      );
      signal?.throwIfAborted();
      availability = await db.transaction(async (tx) => {
        const [owned] = await tx.select().from(entitlementQuery(orgId));
        signal?.throwIfAborted();
        const at = nowDate();
        const prepared = planPreparedAllowanceEntitlement(
          currentAllowanceEntitlement(owned, at),
          refresh,
          at,
        );
        if (prepared.update && owned) {
          const [published] = await tx
            .update(orgUsageAllowanceEntitlements)
            .set(prepared.update)
            .where(
              and(
                eq(orgUsageAllowanceEntitlements.id, owned.id),
                sql`${orgUsageAllowanceEntitlements}::text = ${owned.snapshot}`,
              ),
            )
            .returning({ id: orgUsageAllowanceEntitlements.id });
          signal?.throwIfAborted();
          if (!published) {
            throw new Error(
              "Usage allowance changed during refresh publication",
            );
          }
        }
        if (!prepared.entitlement) {
          return null;
        }
        const rows = await tx
          .select()
          .from(allowanceAvailabilityQuery(orgId, at));
        const current = allowanceAvailability(rows, at);
        if (current === "allowance_refresh_required") {
          throw new Error("Prepared usage allowance is still expired");
        }
        signal?.throwIfAborted();
        return current;
      });
      signal?.throwIfAborted();
    }
    safeSync(() => {
      recordBillingOperationTimings([
        {
          actionType: "api_billing_allowance_availability",
          durationMs: Math.round(performance.now() - startedAt),
          success: true,
          dimensions: { available: availability !== null },
        },
      ]);
    });
    return availability;
  },
);
