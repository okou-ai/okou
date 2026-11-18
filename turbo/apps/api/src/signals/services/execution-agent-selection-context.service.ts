import { computed, type Computed } from "ccstate";
import { memberConnectorSelectionQueries } from "./member-connector-selection";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { workflows } from "@okouai/db/schema/workflow";
import { array, object, string, unknown as zUnknown } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";
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
import { activeUserPermissionGrantCondition } from "./user-permission-grants.service";
import { workflowsForRunFromRows } from "./workflow-data.service";

/** All selections have the same (org,user,agent) authority. */
const builtinColumns = Object.freeze({
  connectorSlug: userBuiltinConnectors.connectorSlug,
});
const {
  networkBinding: connectorNetworkBinding,
  ...connectorDefinitionColumns
} = customConnectorExecutionDefinitionSelection();
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
const workflowColumns = Object.freeze({
  id: workflows.id,
  name: workflows.name,
  visibility: workflows.visibility,
  ownerUserId: workflows.ownerUserId,
  officialDefinitionName: workflows.officialDefinitionName,
  createdAt: workflows.createdAt,
});
function agentSelectionQueries(
  scope: AgentConnectorSelectionScope,
  at: Date,
  chatAccounts: boolean,
) {
  const builder = new QueryBuilder();
  const builtin = builder
    .select({
      payload: contextJsonProjection(builtinColumns)
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(userBuiltinConnectors)
    .where(
      and(
        eq(userBuiltinConnectors.orgId, scope.orgId),
        eq(userBuiltinConnectors.userId, scope.userId),
        eq(userBuiltinConnectors.agentId, scope.agentId),
      ),
    );
  const custom = builder
    .select({
      payload: sql`jsonb_build_object(
      'connector', ${contextJsonProjection(connectorColumns)} || jsonb_build_object('networkBinding', ${connectorNetworkBinding.sql}),
      'oauthConfig', case when ${orgCustomConnectorOauthConfigs.connectorId} is null then null else ${contextJsonProjection(oauthColumns)} end,
      'permissionNames', ${userCustomConnectors.permissionNames})`
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(userCustomConnectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
        eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
      ),
    )
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(userCustomConnectors.orgId, scope.orgId),
        eq(userCustomConnectors.userId, scope.userId),
        eq(userCustomConnectors.agentId, scope.agentId),
        eq(orgCustomConnectors.enabled, true),
      ),
    );
  const permissions = builder
    .select({
      payload: contextJsonProjection(permissionColumns)
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, scope.orgId),
        eq(userPermissionGrants.userId, scope.userId),
        eq(userPermissionGrants.agentId, scope.agentId),
        activeUserPermissionGrantCondition(at),
      ),
    )
    .orderBy(
      asc(userPermissionGrants.connectorSlug),
      asc(userPermissionGrants.permission),
    );
  return chatAccounts
    ? memberConnectorSelectionQueries(scope, at)
    : { builtin, custom, permissions };
}

function agentWorkflowQuery(scope: AgentConnectorSelectionScope) {
  return new QueryBuilder()
    .select({
      payload: contextJsonProjection(workflowColumns)
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, scope.orgId),
        eq(workflows.agentId, scope.agentId),
        isNull(workflows.officialDefinitionName),
        or(
          eq(workflows.visibility, "public"),
          eq(workflows.ownerUserId, scope.userId),
        ),
      ),
    );
}

/** These related selections are included in the first account/environment statement. */
export function agentSelectionColumns(
  scope: AgentConnectorSelectionScope,
  at: Date,
  chatAccounts: boolean,
) {
  const { builtin, custom, permissions } = agentSelectionQueries(
    scope,
    at,
    chatAccounts,
  );
  return {
    builtin: contextJsonRows(builtin).mapWith(
      zodDriverValueDecoder(zUnknown()),
    ),
    custom: contextJsonRows(custom).mapWith(zodDriverValueDecoder(zUnknown())),
    permissions: contextJsonRows(permissions).mapWith(
      zodDriverValueDecoder(zUnknown()),
    ),
    workflows: contextJsonRows(agentWorkflowQuery(scope)).mapWith(
      zodDriverValueDecoder(zUnknown()),
    ),
  };
}

export function createAgentSelectionContext(
  scope$: Computed<Promise<AgentConnectorSelectionScope>>,
  raw$: Computed<
    Promise<{
      readonly builtin: unknown;
      readonly custom: unknown;
      readonly permissions: unknown;
      readonly workflows: unknown;
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
  const workflows$ = computed(async (get) => {
    const scope = await get(scope$);
    return workflowsForRunFromRows(
      array(contextProjectionSchema(workflowColumns)).parse(
        (await get(raw$)).workflows,
      ),
      scope.userId,
    );
  });
  return { connectorSelection$, permissionGrants$, workflows$ };
}
