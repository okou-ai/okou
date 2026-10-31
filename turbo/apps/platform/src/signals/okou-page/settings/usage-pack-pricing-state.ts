import { command, computed, state } from "ccstate";
import type {
  UsagePackMigrationPreviewResponse,
  UsagePackMigrationRevisionPreviewResponse,
  UsagePackManagementResponse,
  UsagePackSubscriptionChangePreviewResponse,
  UsagePackUsd,
  MemberUsagePack,
  UsagePackCatalogItem,
} from "@okouai/api-contracts/contracts/billing";
import { USAGE_PACKS_USD } from "@okouai/api-contracts/validators/billing";

import { onRef } from "../../utils.ts";

export const MINIMUM_USAGE_PACK_USD = USAGE_PACKS_USD[0];

export type { UsagePackUsd };
export type UsagePackPlanTier = "pro" | "team";
export type MemberUsageSelection = MemberUsagePack["usagePackUsd"];
export type MemberUsagePackOption = Omit<
  UsagePackCatalogItem,
  "usagePackUsd"
> & {
  readonly usagePackUsd: MemberUsageSelection;
};

type ManagedUsagePackAllocation =
  UsagePackManagementResponse["allocations"][number];

export function managedUsagePackSelection(
  allocation: ManagedUsagePackAllocation,
): MemberUsageSelection {
  const pendingChange = allocation.pendingChange;
  if (
    pendingChange?.kind === "removal" &&
    pendingChange.status === "scheduled"
  ) {
    return 0;
  }
  return pendingChange?.kind === "downgrade" &&
    pendingChange.status === "scheduled" &&
    pendingChange.targetUsagePackUsd !== null
    ? pendingChange.targetUsagePackUsd
    : allocation.usagePackUsd;
}

const internalSelectedUsagePackPlan$ = state<UsagePackPlanTier | null>(null);

const internalMemberUsageSelections$ = state<
  Readonly<Record<string, MemberUsageSelection>>
>({});
const internalUsagePackSubscriptionChangePreview$ =
  state<UsagePackSubscriptionChangePreviewResponse | null>(null);
const internalUsagePackMigrationPreview$ =
  state<UsagePackMigrationPreviewResponse | null>(null);
const internalUsagePackMigrationRevisionPreview$ =
  state<UsagePackMigrationRevisionPreviewResponse | null>(null);

export const memberUsageSelections$ = computed((get) => {
  return get(internalMemberUsageSelections$);
});

export const selectedUsagePackPlan$ = computed((get) => {
  return get(internalSelectedUsagePackPlan$);
});

export const usagePackSubscriptionChangePreview$ = computed((get) => {
  return get(internalUsagePackSubscriptionChangePreview$);
});

export const usagePackMigrationPreview$ = computed((get) => {
  return get(internalUsagePackMigrationPreview$);
});

export const usagePackMigrationRevisionPreview$ = computed((get) => {
  return get(internalUsagePackMigrationRevisionPreview$);
});

export const setSelectedUsagePackPlan$ = command(
  ({ set }, plan: UsagePackPlanTier | null) => {
    set(internalSelectedUsagePackPlan$, plan);
  },
);

export const setUsagePackMigrationPreview$ = command(
  ({ set }, preview: UsagePackMigrationPreviewResponse | null) => {
    set(internalUsagePackMigrationPreview$, preview);
  },
);

export const setUsagePackMigrationRevisionPreview$ = command(
  ({ set }, preview: UsagePackMigrationRevisionPreviewResponse | null) => {
    set(internalUsagePackMigrationRevisionPreview$, preview);
  },
);

export const closeUsagePackMigrationPreview$ = command(({ set }) => {
  set(internalUsagePackMigrationPreview$, null);
});

export const closeUsagePackMigrationRevisionPreview$ = command(({ set }) => {
  set(internalUsagePackMigrationRevisionPreview$, null);
});

export const resetUsagePackPricing$ = command(({ set }) => {
  set(internalSelectedUsagePackPlan$, null);
  set(internalMemberUsageSelections$, {});
  set(internalUsagePackSubscriptionChangePreview$, null);
  set(internalUsagePackMigrationPreview$, null);
  set(internalUsagePackMigrationRevisionPreview$, null);
});

export const setUsagePackSubscriptionChangePreview$ = command(
  ({ set }, preview: UsagePackSubscriptionChangePreviewResponse | null) => {
    set(internalUsagePackSubscriptionChangePreview$, preview);
  },
);

export const usagePackPricingPageRef$ = onRef(
  command((_context, element: HTMLDivElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    element.focus();
  }),
);

export const setMemberUsageSelection$ = command(
  (
    { set },
    selection: {
      readonly memberId: string;
      readonly usage: MemberUsageSelection;
    },
  ) => {
    set(internalMemberUsageSelections$, (current) => {
      return { ...current, [selection.memberId]: selection.usage };
    });
  },
);

export const setMemberUsageSelections$ = command(
  ({ set }, selections: Readonly<Record<string, MemberUsageSelection>>) => {
    set(internalMemberUsageSelections$, selections);
  },
);
