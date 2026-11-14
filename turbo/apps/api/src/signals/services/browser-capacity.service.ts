import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { browserOwnerProfiles } from "@okouai/db/schema/browser-owner";
import { db$ } from "../external/db";
import type { BrowserServiceError } from "./browser-error";
import {
  loadActivePaidConcurrencySlots$,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";

const browserAvailableConcurrency$ = command(
  async ({ get, set }, orgId: string): Promise<number> => {
    const [capabilities, paidSlots] = await Promise.all([
      set(loadOrgPlanCapabilities$, orgId),
      set(loadActivePaidConcurrencySlots$, orgId),
    ]);
    if (!capabilities) {
      return 0;
    }
    const limit = totalConcurrencyLimit({
      baseLimit: cappedBaseConcurrencyLimit(capabilities.baseConcurrencyLimit),
      paidSlots,
    });
    if (!Number.isFinite(limit) || limit === 0) {
      return limit;
    }
    const browsers = await get(db$).$count(
      browserOwnerProfiles,
      and(
        eq(browserOwnerProfiles.orgId, orgId),
        inArray(browserOwnerProfiles.status, [
          "creating",
          "active",
          "stopping",
        ]),
      ),
    );
    return limit - browsers;
  },
);

/** Enforce the Browser owner concurrency entitlement. */
export const ensureBrowserCapacity$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<BrowserServiceError | null> => {
    const available = await set(browserAvailableConcurrency$, orgId);
    signal.throwIfAborted();
    if (!Number.isFinite(available) || available > 0) {
      return null;
    }
    return {
      kind: "error",
      status: 409,
      code: "BROWSER_CONCURRENCY_LIMIT",
      message: "This organization has no managed browser concurrency available",
    };
  },
);
