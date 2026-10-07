import { computed } from "ccstate";
import { memberModelRouteContextFromAccounts } from "./effective-model-route.service";
import {
  createModelCatalog,
  modelCatalogForOrg,
  type ModelCatalog,
} from "./model-catalog.service";
import type { memberModelSourcesFromRows } from "./model-source-context.service";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";

export type OrgModelBootstrap = Awaited<
  ReturnType<ReturnType<typeof createModelFacts>["read"]>
>;
export type MemberModelBootstrap = ReturnType<
  typeof memberModelBootstrapFromSources
>;
export interface RunOrgMetadata {
  readonly credits: number;
  readonly defaultAgentId: string | null;
  readonly openrouterPreset: string | null;
}

export function createModelFacts(
  orgId: string,
  capabilities: OrgPlanCapabilities | null,
  org: RunOrgMetadata | null,
) {
  const catalog$ = createModelCatalog();
  return computed(async (get) => {
    return modelFactsFromSnapshot(
      orgId,
      capabilities,
      org,
      await get(catalog$),
    );
  });
}
export function memberModelBootstrapFromSources({
  orgId,
  userId,
  rows,
  providers,
}: ReturnType<typeof memberModelSourcesFromRows>) {
  const accounts = [
    ...new Map(
      rows.map((row) => {
        return [row.account.id, row.account];
      }),
    ).values(),
  ];
  const member = memberModelRouteContextFromAccounts(
    accounts.map((account) => {
      return {
        ...account,
        providerId: account.modelProviderId,
      };
    }),
  );
  return { orgId, userId, rows, accounts, member, providers };
}
export function modelFactsFromSnapshot(
  orgId: string,
  capabilities: OrgPlanCapabilities | null,
  org: RunOrgMetadata | null,
  globalCatalog: ModelCatalog,
) {
  const catalog = modelCatalogForOrg(globalCatalog, org?.openrouterPreset);
  return { orgId, org, capabilities, catalog };
}
