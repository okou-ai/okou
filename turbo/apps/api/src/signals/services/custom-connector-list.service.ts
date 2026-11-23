import { computed, type Computed } from "ccstate";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import {
  normaliseCustomConnectorRow,
  serialiseCustomConnector,
} from "./custom-connector.service";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import {
  createCustomConnectorConnectedConnections,
  customConnectorDefinitionConnectedAccount,
  createCustomConnectorValueMarkers,
} from "./custom-connector-credential-access.service";

export function createCustomConnectorList(
  scope$: Computed<{
    readonly orgId: string;
    readonly userId: string;
  }>,
): Computed<Promise<readonly CustomConnectorResponse[]>> {
  const definitions$ = computed(async (get) => {
    const args = get(scope$);
    const db = get(db$);
    const connectorRows = await db
      .select({
        connector: customConnectorDefinitionSelection(),
        oauthConfig: {
          providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
          clientId: orgCustomConnectorOauthConfigs.clientId,
          authorizationUrl: orgCustomConnectorOauthConfigs.authorizationUrl,
          tokenUrl: orgCustomConnectorOauthConfigs.tokenUrl,
          tokenEndpointAuthMethod:
            orgCustomConnectorOauthConfigs.tokenEndpointAuthMethod,
          pkceMethod: orgCustomConnectorOauthConfigs.pkceMethod,
          scopes: orgCustomConnectorOauthConfigs.scopes,
          authorizationParams:
            orgCustomConnectorOauthConfigs.authorizationParams,
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
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(eq(orgCustomConnectors.orgId, args.orgId))
      .orderBy(orgCustomConnectors.displayName);
    return connectorRows.map((row) => {
      return normaliseCustomConnectorRow(row.connector, row.oauthConfig);
    });
  });
  const managedOwner$ = computed(async (get) => {
    const args = get(scope$);
    const definitions = await get(definitions$);
    return {
      orgId: args.orgId,
      userId: args.userId,
      connectorIds: definitions
        .filter(isIntegrationManagedCustomConnector)
        .map((definition) => {
          return definition.id;
        }),
    };
  });
  const markers$ = createCustomConnectorValueMarkers(managedOwner$);
  const connectedConnections$ =
    createCustomConnectorConnectedConnections(managedOwner$);
  return computed(async (get): Promise<readonly CustomConnectorResponse[]> => {
    const [definitions, markers, connectedConnections] = await Promise.all([
      get(definitions$),
      get(markers$),
      get(connectedConnections$),
    ]);
    return definitions.map((definition) => {
      if (!isIntegrationManagedCustomConnector(definition)) {
        return serialiseCustomConnector({ row: definition });
      }
      const connectedAccount = customConnectorDefinitionConnectedAccount({
        connectedConnections,
        definition,
      });
      return serialiseCustomConnector({
        row: definition,
        managedStatus: {
          valueMarkers: markers,
          connectedAccountId: connectedAccount?.id ?? null,
          connectedAccountUpdatedAt: connectedAccount?.updatedAt,
        },
      });
    });
  });
}
