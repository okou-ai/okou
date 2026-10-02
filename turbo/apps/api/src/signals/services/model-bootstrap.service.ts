import { computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { db$ } from "../external/db";
import { createModelCatalog } from "./model-catalog.service";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { orgModelPolicyFactsFromSnapshot } from "./model-policy.service";
import { memberModelRouteContextFromAccounts } from "./effective-model-route.service";

export type OrgModelBootstrap = Awaited<
  ReturnType<ReturnType<typeof createModelFacts>["read"]>
>;
export type MemberModelBootstrap = Awaited<
  ReturnType<ReturnType<typeof createMemberModelBootstrap>["read"]>
>;

export interface RunOrgMetadata {
  readonly credits: number;
  readonly modelMode: string;
  readonly defaultAgentId: string | null;
}

export function createModelFacts(
  orgId: string,
  capabilities: OrgPlanCapabilities | null,
  org: RunOrgMetadata | null,
) {
  const catalog$ = createModelCatalog();
  return computed(async (get) => {
    const [catalog, policies] = await Promise.all([
      get(catalog$),
      get(db$)
        .select()
        .from(orgModelPolicies)
        .where(eq(orgModelPolicies.orgId, orgId)),
    ]);
    return {
      orgId,
      org,
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
    const rows = await get(db$)
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
