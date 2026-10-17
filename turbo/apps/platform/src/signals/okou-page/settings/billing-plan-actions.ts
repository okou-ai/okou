import type { MemberUsagePack } from "@okouai/api-contracts/contracts/billing";
import { command } from "ccstate";
import {
  closeDowngradeDialog$,
  confirmDowngrade$,
  confirmUsagePackMigration$,
  confirmUsagePackMigrationRevision$,
} from "../billing.ts";
import { dismissBillingPlans$ } from "./settings-dialog.ts";
import { setLockedTarget$ } from "./workspace-settings-state.ts";

export const dismissPlanDowngrade$ = command(({ set }) => {
  set(closeDowngradeDialog$);
  set(setLockedTarget$, null);
});

export const confirmPlanDowngrade$ = command(
  async ({ set }, target: "limited-free-1" | "pro", signal: AbortSignal) => {
    await set(confirmDowngrade$, target, signal);
    set(setLockedTarget$, null);
  },
);

export const confirmBillingMigration$ = command(
  async ({ set }, migrationId: string, signal: AbortSignal) => {
    await set(confirmUsagePackMigration$, migrationId, signal);
    set(dismissBillingPlans$);
  },
);

export const confirmBillingMigrationRevision$ = command(
  async (
    { set },
    request: {
      readonly migrationId: string;
      readonly targetTier: "pro" | "team";
      readonly memberUsagePacks: readonly MemberUsagePack[];
    },
    signal: AbortSignal,
  ) => {
    await set(confirmUsagePackMigrationRevision$, request, signal);
    set(dismissBillingPlans$);
  },
);
