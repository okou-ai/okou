import { computed, type Computed } from "ccstate";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
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
  customConnectorConnectedConnections,
  customConnectorDefinitionConnectedAccount,
  customConnectorValueMarkers,
} from "./custom-connector-credential-access.service";

export function customConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly CustomConnectorResponse[]>> {
  return computed(async (get): Promise<readonly CustomConnectorResponse[]> => {
    const db = get(db$);
    const [connectorRows, markers, connectedConnections] = await Promise.all([
      db
        .select({
          connector: customConnectorDefinitionSelection(),
          oauthConfig: orgCustomConnectorOauthConfigs,
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
        .orderBy(orgCustomConnectors.displayName),
      get(customConnectorValueMarkers(args)),
      get(customConnectorConnectedConnections(args)),
    ]);
    return connectorRows.map((row) => {
      const connectedAccount = customConnectorDefinitionConnectedAccount({
        connectedConnections,
        definition: row.connector,
      });
      return serialiseCustomConnector({
        row: normaliseCustomConnectorRow(row.connector, row.oauthConfig),
        valueMarkers: markers,
        connectedAccountId: connectedAccount?.id ?? null,
        connectedAccountUpdatedAt: connectedAccount?.updatedAt,
      });
    });
  });
}
