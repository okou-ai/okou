import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import {
  orgCustomConnectorOauthConfigs,
  type OrgCustomConnectorOAuthProviderAdapter,
} from "@okouai/db/schema/org-custom-connector-oauth-config";
import { and, eq } from "drizzle-orm";
import type { ConnectorCatalogArtifact } from "@okouai/connectors/connector-catalog/artifacts/artifacts";

import type { CustomConnectorPermissionBundle } from "./custom-connector-permission-bundle.service";
import { effectiveCustomConnectorPermissionBundleRef } from "./feishu-custom-connector-permissions";
import type { ConnectorRuntimeWakeupBusinessArgs } from "./connector-runtime-wakeup.service";
import { createAcceptedConnectorServerFirewallCatalog } from "./connector-server-firewall-catalog.service";

type CustomConnectorWakeupRow = Pick<
  typeof orgCustomConnectors.$inferSelect,
  | "id"
  | "orgId"
  | "slug"
  | "authMode"
  | "prefixTemplates"
  | "permissionBundleRef"
> & {
  readonly oauthProviderAdapter: OrgCustomConnectorOAuthProviderAdapter | null;
};

export function customCatalogWakeupReadPlan(
  artifact: ConnectorCatalogArtifact,
) {
  return {
    catalog: createAcceptedConnectorServerFirewallCatalog({
      artifact,
      runtimeMethodsForSlug: () => {
        return [];
      },
    }),
    columns: {
      id: orgCustomConnectors.id,
      orgId: orgCustomConnectors.orgId,
      slug: orgCustomConnectors.slug,
      authMode: orgCustomConnectors.authMode,
      prefixTemplates: orgCustomConnectors.prefixTemplates,
      permissionBundleRef: orgCustomConnectors.permissionBundleRef,
      oauthProviderAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    },
    oauthCondition: and(
      eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
      eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
    ),
    condition: eq(orgCustomConnectors.enabled, true),
  };
}

export function catalogWakeupRunColumns() {
  return { runId: agentRuns.id, runnerGroup: agentRuns.runnerGroup };
}

export function customCatalogWakeup(
  orgId: string,
  customConnectorIds: readonly string[],
): ConnectorRuntimeWakeupBusinessArgs {
  return {
    scope: { orgId },
    targets: customConnectorIds.map((customConnectorId) => {
      return { kind: "custom" as const, customConnectorId };
    }),
  };
}

export function builtinCatalogWakeup(
  orgId: string,
  slugs: readonly string[],
): ConnectorRuntimeWakeupBusinessArgs {
  return {
    scope: { orgId },
    targets: slugs.map((connectorSlug) => {
      return { kind: "builtin" as const, connectorSlug };
    }),
  };
}

export function customCatalogWakeupSummary(
  permissionBundleRefCount: number,
  affectedByOrg: ReadonlyMap<string, readonly string[]>,
) {
  return {
    permissionBundleRefCount,
    affectedOrgCount: affectedByOrg.size,
    affectedCustomConnectorCount: [...affectedByOrg.values()].reduce(
      (count, connectorIds) => {
        return count + connectorIds.length;
      },
      0,
    ),
  };
}

export function customCatalogWakeupConnectorsByRef(
  rows: readonly CustomConnectorWakeupRow[],
) {
  const connectorIdsByRef = new Map<
    string,
    { readonly orgId: string; readonly connectorId: string }[]
  >();
  for (const row of rows) {
    const ref = effectiveCustomConnectorPermissionBundleRef({
      slug: row.slug,
      authMode: row.authMode,
      oauthProviderAdapter: row.oauthProviderAdapter,
      prefixTemplates: row.prefixTemplates,
      permissionBundleRef: row.permissionBundleRef,
    });
    if (!ref) {
      continue;
    }
    const connectors = connectorIdsByRef.get(ref) ?? [];
    connectors.push({ orgId: row.orgId, connectorId: row.id });
    connectorIdsByRef.set(ref, connectors);
  }
  return connectorIdsByRef;
}

export function customConnectorPermissionBundleFingerprint(
  bundle: CustomConnectorPermissionBundle | null,
): string | null {
  if (!bundle) {
    return null;
  }
  return JSON.stringify({
    connectorSlug: bundle.connectorSlug,
    permissions: bundle.permissions,
    defaultPolicies: Object.entries(bundle.defaultPolicies).sort(
      ([left], [right]) => {
        return left.localeCompare(right);
      },
    ),
  });
}
