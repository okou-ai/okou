import { computed } from "ccstate";
import type {
  BillingStatusResponse,
  UsagePackMigrationStateResponse,
} from "@okouai/api-contracts/contracts/billing";

import { billingStatusAsync$, usagePackMigrationAsync$ } from "../billing.ts";

type BillingPricingMode =
  | { readonly kind: "pricing"; readonly status: BillingStatusResponse }
  | {
      readonly kind: "migration" | "migration-progress";
      readonly status: BillingStatusResponse;
      readonly migration: UsagePackMigrationStateResponse;
    };

export const billingPricingMode$ = computed(
  async (get): Promise<BillingPricingMode> => {
    const [status, migration] = await Promise.all([
      get(billingStatusAsync$),
      get(usagePackMigrationAsync$),
    ]);

    if (!migration) {
      return { kind: "pricing", status };
    }

    const progressOnly =
      migration.status === "applying" ||
      (migration.status === "scheduled" && !migration.configuration);
    return {
      kind: progressOnly ? "migration-progress" : "migration",
      status,
      migration,
    };
  },
);
