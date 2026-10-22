import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command, computed, type Computed } from "ccstate";
import { eq } from "drizzle-orm";
import { db$ } from "../external/db";

export interface OrgPlanCapabilities {
  readonly planKey: string;
  readonly status: "active" | "suspended";
  readonly baseConcurrencyLimit: number;
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly showUsagePack: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly restrictedBuiltInModels: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
  readonly audioLifetimeLimit: number | null;
  readonly audioDailyRateLimit: number;
  readonly audioDailyDurationSeconds: number;
}

export function orgPlanCapabilitySelection() {
  return {
    planKey: orgPlanEntitlements.planKey,
    status: orgPlanEntitlements.status,
    baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
    canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
    canBuyCredits: orgPlanEntitlements.canBuyCredits,
    showUsagePack: orgPlanEntitlements.showUsagePack,
    autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
    restrictedBuiltInModels: orgPlanEntitlements.restrictedBuiltInModels,
    workflowWebhookAutomationAllowed:
      orgPlanEntitlements.workflowWebhookTriggerAllowed,
    audioLifetimeLimit: orgPlanEntitlements.audioLifetimeLimit,
    audioDailyRateLimit: orgPlanEntitlements.audioDailyRateLimit,
    audioDailyDurationSeconds: orgPlanEntitlements.audioDailyDurationSeconds,
  } as const;
}

export const ORG_PLAN_CAPABILITY_SELECTION = orgPlanCapabilitySelection();

export function runtimeStatusForEntitlement(
  status: string,
): OrgPlanCapabilities["status"] {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "atom_grant":
    case "manual_active": {
      return "active";
    }
    default: {
      return "suspended";
    }
  }
}

export function orgPlanCapabilitiesFromRow(
  capabilities: Omit<
    OrgPlanCapabilities,
    "status" | "restrictedBuiltInModels"
  > & {
    readonly status: string;
    readonly restrictedBuiltInModels: boolean | null;
  },
  orgId: string,
): OrgPlanCapabilities {
  if (capabilities.restrictedBuiltInModels === null) {
    throw new Error(
      `Unexpected NULL restricted_built_in_models for org plan entitlement ${orgId}`,
    );
  }

  // Destructured rather than spread so the non-null narrowing above survives
  // into the returned capability, which is declared as a plain boolean.
  const { restrictedBuiltInModels, ...runtimeCapabilities } = capabilities;
  return {
    ...runtimeCapabilities,
    restrictedBuiltInModels,
    status: runtimeStatusForEntitlement(capabilities.status),
  };
}

export function orgPlanCapabilities(
  orgIdSource: string | Computed<string>,
): Computed<Promise<OrgPlanCapabilities | null>> {
  return computed(async (get): Promise<OrgPlanCapabilities | null> => {
    const orgId =
      typeof orgIdSource === "string" ? orgIdSource : get(orgIdSource);
    const db = get(db$);
    const [capabilities] = await db
      .select(ORG_PLAN_CAPABILITY_SELECTION)
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId))
      .limit(1);
    if (!capabilities) {
      const [org] = await db
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      if (!org) {
        return null;
      }
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    return orgPlanCapabilitiesFromRow(capabilities, orgId);
  });
}

export const loadOrgPlanCapabilities$ = command(
  async (
    { get },
    orgId: string,
    abortSignal?: AbortSignal,
  ): Promise<OrgPlanCapabilities | null> => {
    const db = get(db$);
    const [row] = await db
      .select(ORG_PLAN_CAPABILITY_SELECTION)
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId))
      .limit(1);
    abortSignal?.throwIfAborted();
    if (row) {
      return orgPlanCapabilitiesFromRow(row, orgId);
    }
    const [org] = await db
      .select({ id: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    abortSignal?.throwIfAborted();
    if (org) {
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    return null;
  },
);
