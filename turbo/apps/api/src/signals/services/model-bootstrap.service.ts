import { computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { db$, type ReadonlyDb } from "../external/db";
import { loadModelCatalog, type ModelCatalog } from "./model-catalog.service";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { orgModelPolicyFactsFromSnapshot } from "./model-policy.service";
import { memberModelRouteContextFromAccounts } from "./effective-model-route.service";

/** Request-scoped facts; a matching prefetch is authoritative, including nulls. */
export interface PrefetchedModelBootstrap {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly org: Promise<OrgModelBootstrap>;
  readonly member: Promise<MemberModelBootstrap>;
}

export type OrgModelBootstrap = Awaited<
  ReturnType<typeof loadOrgModelBootstrap>
>;
export type MemberModelBootstrap = Awaited<
  ReturnType<typeof loadMemberModelBootstrap>
>;

async function loadOrgModelBootstrap(
  db: ReadonlyDb,
  orgId: string,
  supplied: {
    readonly capabilities?: OrgPlanCapabilities | null;
    readonly catalog?: ModelCatalog;
  },
) {
  const [orgRows, capabilities, catalog, policies] = await Promise.all([
    db
      .select({
        credits: orgMetadata.credits,
        modelMode: orgMetadata.modelMode,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1),
    supplied.capabilities === undefined
      ? loadOrgPlanCapabilities(db, orgId)
      : supplied.capabilities,
    supplied.catalog ?? loadModelCatalog(db),
    db.select().from(orgModelPolicies).where(eq(orgModelPolicies.orgId, orgId)),
  ]);
  const org = orgRows[0] ?? null;
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
}

export function createOrgModelBootstrap(
  orgId: string,
  supplied: {
    readonly capabilities?: OrgPlanCapabilities | null;
    readonly catalog?: ModelCatalog;
  } = {},
) {
  return computed(async (get) => {
    return loadOrgModelBootstrap(get(db$), orgId, supplied);
  });
}

async function loadMemberModelBootstrap(
  db: Parameters<typeof loadOrgPlanCapabilities>[0],
  orgId: string,
  userId: string,
) {
  const rows = await db
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
}

export function createMemberModelBootstrap(orgId: string, userId: string) {
  return computed(async (get) => {
    return loadMemberModelBootstrap(get(db$), orgId, userId);
  });
}
