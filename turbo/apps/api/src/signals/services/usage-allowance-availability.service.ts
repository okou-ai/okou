import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { recordBillingOperationTimings } from "../external/sandbox-op-log";
import { safeSync } from "../utils";
import {
  allowanceAvailability,
  allowanceAvailabilityQuery,
  type AllowanceAvailability,
} from "./usage-allowance-availability-plan";
import {
  prepareUsageAllowanceRefresh$,
  refreshUsageAllowanceAvailability$,
} from "./usage-allowance.service";

/** One observation, with the shared explicit CAS refresh only when needed. */
export const resolveUsageAllowanceAvailability$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<AllowanceAvailability | null> => {
    const db = set(writeDb$);
    const startedAt = performance.now();
    const observedAt = nowDate();
    let availability = allowanceAvailability(
      await db.select().from(allowanceAvailabilityQuery(orgId, observedAt)),
      observedAt,
    );
    signal.throwIfAborted();
    if (availability === "allowance_refresh_required") {
      const refresh = await set(
        prepareUsageAllowanceRefresh$,
        { orgId },
        signal,
      );
      availability = await set(
        refreshUsageAllowanceAvailability$,
        { orgId, refresh },
        signal,
      );
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
