import { computed, type Computed } from "ccstate";
import { memberConnectorSelectionQueries } from "./member-connector-selection";

import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";

import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { array, object, string, unknown as zUnknown } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { contextJsonRows, contextProjectionSchema } from "./context-rowset";
import {
  agentConnectorSelectionFromRows,
  type AgentConnectorSelectionScope,
} from "./execution-agent-connectors.service";
import {
  customConnectorExecutionDefinitionSelection,
  customConnectorExecutionOAuthSelection,
} from "./custom-connector-definition-selection";
import { customConnectorNetworkMetadataSchema } from "@okouai/api-contracts/validators/custom-connector-network";
import { customConnectorSkillBundleSelection } from "./custom-connector-skill-bundle-columns";

/** These column definitions decode the member account snapshot. */
const builtinColumns = Object.freeze({
  connectorSlug: userBuiltinConnectors.connectorSlug,
});
const { networkBinding: _networkBinding, ...connectorDefinitionColumns } =
  customConnectorExecutionDefinitionSelection();
const connectorColumns = Object.freeze({
  ...connectorDefinitionColumns,
  ...customConnectorSkillBundleSelection(),
});
const oauthColumns = customConnectorExecutionOAuthSelection();
const permissionColumns = Object.freeze({
  connectorSlug: userPermissionGrants.connectorSlug,
  permission: userPermissionGrants.permission,
  action: userPermissionGrants.action,
  expiresAt: userPermissionGrants.expiresAt,
});
/** These related selections are included in the first account/environment statement. */
export function agentSelectionColumns(
  scope: AgentConnectorSelectionScope,
  at: Date,
) {
  const { builtin, custom, permissions } = memberConnectorSelectionQueries(
    scope,
    at,
  );
  return {
    builtin: contextJsonRows(builtin).mapWith(
      zodDriverValueDecoder(zUnknown()),
    ),
    custom: contextJsonRows(custom).mapWith(zodDriverValueDecoder(zUnknown())),
    permissions: contextJsonRows(permissions).mapWith(
      zodDriverValueDecoder(zUnknown()),
    ),
  };
}

export function createAgentSelectionContext(
  raw$: Computed<
    Promise<{
      readonly builtin: unknown;
      readonly custom: unknown;
      readonly permissions: unknown;
    }>
  >,
) {
  const connectorSelection$ = computed(async (get) => {
    const row = await get(raw$);
    const builtin = array(contextProjectionSchema(builtinColumns)).parse(
      row.builtin,
    );
    const custom = array(
      object({
        connector: contextProjectionSchema(connectorColumns).and(
          object({
            networkBinding: customConnectorNetworkMetadataSchema.nullable(),
          }),
        ),
        oauthConfig: contextProjectionSchema(oauthColumns).nullable(),
        permissionNames: array(string()),
      }),
    ).parse(row.custom);
    return agentConnectorSelectionFromRows(builtin, custom);
  });
  const permissionGrants$ = computed(async (get) => {
    return array(contextProjectionSchema(permissionColumns)).parse(
      (await get(raw$)).permissions,
    );
  });
  return { connectorSelection$, permissionGrants$ };
}
