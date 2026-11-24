import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { computed, type Computed } from "ccstate";
import {
  type ConnectorMember,
  memberConnectorRuleColumns,
  memberConnectorSelectionQueries,
} from "./member-connector-selection";
import { array, boolean, object, string, unknown as zUnknown } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { contextJsonRows, contextProjectionSchema } from "./context-rowset";
import { executionConnectorSelectionFromRows } from "./execution-connector-selection";
import {
  customConnectorExecutionDefinitionSelection,
  customConnectorExecutionOAuthSelection,
} from "./custom-connector-definition-selection";
import { customConnectorNetworkMetadataSchema } from "@okouai/api-contracts/validators/custom-connector-network";

const { networkBinding: _networkBinding, ...connectorDefinitionColumns } =
  customConnectorExecutionDefinitionSelection();
const connectorColumns = Object.freeze({
  ...connectorDefinitionColumns,
  skillContentBundle: orgCustomConnectors.skillContentBundle,
});
const oauthColumns = customConnectorExecutionOAuthSelection();
const connectorSlugRow = object({ connectorSlug: string() });
const permissionGrantRow = connectorSlugRow.and(
  contextProjectionSchema(memberConnectorRuleColumns),
);

/** These related selections are included in the first account/environment statement. */
export function memberConnectorContextColumns(
  member: ConnectorMember,
  at: Date,
) {
  const { custom, permissions } = memberConnectorSelectionQueries(member, at);
  return {
    custom: contextJsonRows(custom).mapWith(zodDriverValueDecoder(zUnknown())),
    permissions: contextJsonRows(permissions).mapWith(
      zodDriverValueDecoder(zUnknown()),
    ),
  };
}

export function createExecutionConnectorContext(
  raw$: Computed<
    Promise<{
      readonly accounts: readonly { readonly connectorSlug: string | null }[];
      readonly custom: unknown;
      readonly permissions: unknown;
    }>
  >,
  orgId: string,
) {
  const connectorSelection$ = computed(async (get) => {
    const row = await get(raw$);
    const custom = array(
      object({
        connector: contextProjectionSchema(connectorColumns).and(
          object({
            networkBinding: customConnectorNetworkMetadataSchema.nullable(),
            hasSkill: boolean(),
          }),
        ),
        oauthConfig: contextProjectionSchema(oauthColumns).nullable(),
      }),
    ).parse(row.custom);
    return executionConnectorSelectionFromRows(
      row.accounts,
      custom.map(({ connector, oauthConfig }) => {
        return { connector: { ...connector, orgId }, oauthConfig };
      }),
    );
  });
  const permissionGrants$ = computed(async (get) => {
    return array(permissionGrantRow).parse((await get(raw$)).permissions);
  });
  return { connectorSelection$, permissionGrants$ };
}
