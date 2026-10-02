import { computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { db$ } from "../external/db";
import { createModelCatalog, type ModelCatalog } from "./model-catalog.service";
import {
  orgPlanCapabilitiesFromRow,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgModelPolicyFactsFromSnapshot } from "./model-policy.service";
import { memberModelRouteContextFromAccounts } from "./effective-model-route.service";

/** Request-scoped captured facts; matching prefetch is authoritative, including nulls. */
export interface PrefetchedModelBootstrap {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly org: Promise<OrgModelBootstrap>;
  readonly member: Promise<MemberModelBootstrap>;
}
export type OrgModelBootstrap = Awaited<
  ReturnType<ReturnType<typeof createOrgModelBootstrap>["read"]>
>;
export type MemberModelBootstrap = Awaited<
  ReturnType<ReturnType<typeof createMemberModelBootstrap>["read"]>
>;

export function createOrgModelBootstrap(
  orgId: string,
  supplied: {
    readonly capabilities?: OrgPlanCapabilities | null;
    readonly catalog?: ModelCatalog;
  } = {},
) {
  const catalog$ = createModelCatalog();
  const capabilities$ = computed(async (get) => {
    const database = get(db$);
    const [row] = await database
      .select({
        planKey: orgPlanEntitlements.planKey,
        status: orgPlanEntitlements.status,
        baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
        canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
        canBuyCredits: orgPlanEntitlements.canBuyCredits,
        showUsagePack: orgPlanEntitlements.showUsagePack,
        autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
        supportByok: orgPlanEntitlements.supportByok,
        restrictedBuiltInModels: orgPlanEntitlements.restrictedBuiltInModels,
        workflowWebhookAutomationAllowed:
          orgPlanEntitlements.workflowWebhookTriggerAllowed,
        audioLifetimeLimit: orgPlanEntitlements.audioLifetimeLimit,
        audioDailyRateLimit: orgPlanEntitlements.audioDailyRateLimit,
        audioDailyDurationSeconds:
          orgPlanEntitlements.audioDailyDurationSeconds,
      })
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId))
      .limit(1);
    if (row) {
      return orgPlanCapabilitiesFromRow(row, orgId);
    }
    const [org] = await database
      .select({ id: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    if (org) {
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    return null;
  });
  return computed(async (get) => {
    const database = get(db$);
    const [orgRows, capabilities, catalog, policies] = await Promise.all([
      database
        .select({
          credits: orgMetadata.credits,
          modelMode: orgMetadata.modelMode,
        })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1),
      supplied.capabilities === undefined
        ? get(capabilities$)
        : supplied.capabilities,
      supplied.catalog ?? get(catalog$),
      database
        .select()
        .from(orgModelPolicies)
        .where(eq(orgModelPolicies.orgId, orgId)),
    ]);
    return {
      orgId,
      org: orgRows[0] ?? null,
      capabilities,
      catalog,
      policies,
      policyFacts: orgModelPolicyFactsFromSnapshot({
        catalog,
        orgId,
        orgPlanCapabilities: capabilities,
        stored: policies,
      }),
    };
  });
}

export function createMemberModelBootstrap(orgId: string, userId: string) {
  return computed(async (get) => {
    const database = get(db$);
    const rows = await database
      .select({
        account: modelProviderAccounts,
        configuredModel: modelProviders.selectedModel,
        secret: {
          name: modelProviderAccountSecrets.name,
          encryptedValue: modelProviderAccountSecrets.encryptedValue,
        },
      })
      .from(modelProviderAccounts)
      .innerJoin(
        modelProviders,
        eq(modelProviderAccounts.modelProviderId, modelProviders.id),
      )
      .leftJoin(
        modelProviderAccountSecrets,
        eq(
          modelProviderAccountSecrets.modelProviderAccountId,
          modelProviderAccounts.id,
        ),
      )
      .where(
        and(
          eq(modelProviderAccounts.orgId, orgId),
          eq(modelProviderAccounts.userId, userId),
          isNull(modelProviderAccounts.disconnectedAt),
        ),
      );
    const accounts = [
      ...new Map(
        rows.map((row) => {
          return [row.account.id, row.account];
        }),
      ).values(),
    ];
    const member = memberModelRouteContextFromAccounts(
      userId,
      accounts.map((account) => {
        return {
          ...account,
          providerId: account.modelProviderId,
        };
      }),
    );
    return { orgId, userId, rows, accounts, member };
  });
}
