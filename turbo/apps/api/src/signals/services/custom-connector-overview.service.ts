import { computed, type Computed } from "ccstate";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import { isIntegrationManagedCustomConnector } from "@okouai/api-contracts/contracts/custom-connectors";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import {
  customConnectorIsConnected,
  customConnectorMissingRequiredFieldKeys,
  effectivePermissionBundleRef,
  normaliseCustomConnectorConnectionDefinition,
} from "./custom-connector.service";
import {
  customConnectorConnectedConnections,
  customConnectorDefinitionConnectedAccount,
  customConnectorValueMarkers,
} from "./custom-connector-credential-access.service";

export function customConnectorOverview(
  owner$: Computed<{ readonly orgId: string; readonly userId: string }>,
  accountSummaries$: Computed<Promise<readonly ConnectorAccountSummary[]>>,
) {
  return computed(async (get) => {
    const args = get(owner$);
    const db = get(db$);
    const [connectorRows, markers, connectedConnections, summaries] =
      await Promise.all([
        db
          .select({
            connector: {
              id: orgCustomConnectors.id,
              orgId: orgCustomConnectors.orgId,
              slug: orgCustomConnectors.slug,
              displayName: orgCustomConnectors.displayName,
              prefixTemplates: orgCustomConnectors.prefixTemplates,
              fields: orgCustomConnectors.fields,
              headerInjections: orgCustomConnectors.headerInjections,
              queryInjections: orgCustomConnectors.queryInjections,
              authMode: orgCustomConnectors.authMode,
              permissionBundleRef: orgCustomConnectors.permissionBundleRef,
              // These remain necessary for persisted protocol validation.
              mcpEndpoint: orgCustomConnectors.mcpEndpoint,
              mcpTransport: orgCustomConnectors.mcpTransport,
              storageVersion: orgCustomConnectors.storageVersion,
            },
            oauthConfig: {
              providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
            },
          })
          .from(orgCustomConnectors)
          .leftJoin(
            orgCustomConnectorOauthConfigs,
            and(
              eq(
                orgCustomConnectorOauthConfigs.connectorId,
                orgCustomConnectors.id,
              ),
              eq(
                orgCustomConnectorOauthConfigs.orgId,
                orgCustomConnectors.orgId,
              ),
            ),
          )
          .where(eq(orgCustomConnectors.orgId, args.orgId))
          .orderBy(orgCustomConnectors.displayName),
        get(customConnectorValueMarkers(args)),
        get(customConnectorConnectedConnections(args)),
        get(accountSummaries$),
      ]);
    const customIdsWithAccounts = new Set(
      summaries.flatMap((summary) => {
        return summary.target.kind === "custom" && summary.accountCount > 0
          ? [summary.target.customConnectorId]
          : [];
      }),
    );
    return connectorRows.flatMap((row) => {
      const connector = normaliseCustomConnectorConnectionDefinition(
        row.connector,
        row.oauthConfig,
      );
      const connectedAccount = customConnectorDefinitionConnectedAccount({
        connectedConnections,
        definition: row.connector,
      });
      const connectorMarkers = markers.filter((marker) => {
        return (
          marker.connectorId === connector.id &&
          marker.authMode === connector.authMode &&
          marker.storageVersion === connector.storageVersion
        );
      });
      const missingRequiredFields = customConnectorMissingRequiredFieldKeys({
        fields: connector.fields,
        markers: connectorMarkers,
      });
      // Saved accounts remain visible even when the default needs reconnect.
      // Visibility does not make an account usable for authentication.
      if (
        !customIdsWithAccounts.has(connector.id) &&
        !customConnectorIsConnected({
          row: connector,
          connectedAccountId: connectedAccount?.id ?? null,
          missingRequiredFields,
        })
      ) {
        return [];
      }
      return [
        {
          id: connector.id,
          slug: connector.slug,
          displayName: connector.displayName,
          permissionBundleRef:
            connector.kind === "http"
              ? effectivePermissionBundleRef(connector)
              : null,
          integrationManaged: isIntegrationManagedCustomConnector(connector),
        },
      ];
    });
  });
}
