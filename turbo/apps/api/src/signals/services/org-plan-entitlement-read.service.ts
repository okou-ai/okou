import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { computed, type Computed } from "ccstate";
import { eq } from "drizzle-orm";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$, type Db } from "../external/db";

type ReadDb = Pick<Db, "select">;

export interface OrgPlanCapabilities {
  readonly planKey: string;
  readonly status: "active" | "suspended";
  readonly baseConcurrencyLimit: number;
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly showUsagePack: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedBuiltInModels: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
  readonly audioLifetimeLimit: number | null;
  readonly audioDailyRateLimit: number;
  readonly audioDailyDurationSeconds: number;
}

export const ORG_PLAN_CAPABILITY_SELECTION = {
  planKey: orgPlanEntitlements.planKey,
  status: orgPlanEntitlements.status,
  baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
  canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
  canBuyCredits: orgPlanEntitlements.canBuyCredits,
  showUsagePack: orgPlanEntitlements.showUsagePack,
  autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
  supportByok: orgPlanEntitlements.supportByok,
  restrictedBuiltInModels: orgPlanEntitlements.restrictedBuiltInModels,
  videoGenerationAllowed: orgPlanEntitlements.videoGenerationAllowed,
  workflowWebhookAutomationAllowed:
    orgPlanEntitlements.workflowWebhookTriggerAllowed,
  audioLifetimeLimit: orgPlanEntitlements.audioLifetimeLimit,
  audioDailyRateLimit: orgPlanEntitlements.audioDailyRateLimit,
  audioDailyDurationSeconds: orgPlanEntitlements.audioDailyDurationSeconds,
} as const;

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

export async function loadOrgPlanCapabilities(
  db: ReadDb,
  orgId: string,
  options?: { readonly forUpdate?: boolean },
): Promise<OrgPlanCapabilities | null> {
  const query = db
    .select(ORG_PLAN_CAPABILITY_SELECTION)
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  const [capabilities] = options?.forUpdate
    ? await query.for("update")
    : await query;
  if (!capabilities) {
    const orgQuery = db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    const [org] = options?.forUpdate
      ? await orgQuery.for("update")
      : await orgQuery;
    if (!org) {
      return null;
    }
    throw new Error(`Missing org plan entitlement for ${orgId}`);
  }

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

/**
 * The authenticated organization's plan, request-scoped so one request reads
 * it once. Only for decisions about that organization; locking reads stay on
 * `loadOrgPlanCapabilities`.
 */
export const organizationPlanCapabilities$: Computed<
  Promise<OrgPlanCapabilities | null>
> = computed(async (get) => {
  return await loadOrgPlanCapabilities(
    get(db$),
    get(organizationAuthContext$).orgId,
  );
});
