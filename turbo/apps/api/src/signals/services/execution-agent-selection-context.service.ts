import { computed } from "ccstate";
import { and, asc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { workflows } from "@okouai/db/schema/workflow";
import { z } from "zod";
import { db$ } from "../external/db";
import { nowDate } from "../../lib/time";
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
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import { activeUserPermissionGrantCondition } from "./user-permission-grants.service";
import { workflowsForRunFromRows } from "./workflow-data.service";

/** All four selections have the same (org,user,agent) authority. */
const builtinColumns = Object.freeze({
  connectorSlug: userBuiltinConnectors.connectorSlug,
});
const connectorColumns = customConnectorDefinitionSelection();
const oauthColumns = getTableColumns(orgCustomConnectorOauthConfigs);
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
function agentSelectionQueries(scope: AgentConnectorSelectionScope, at: Date) {
  const builder = new QueryBuilder();
  const builtin = builder
    .select({
      payload: contextJsonProjection(builtinColumns)
        .mapWith(zodDriverValueDecoder(z.unknown()))
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
      'connector', ${contextJsonProjection(connectorColumns)},
      'oauthConfig', case when ${orgCustomConnectorOauthConfigs.connectorId} is null then null else ${contextJsonProjection(oauthColumns)} end,
      'permissionNames', ${userCustomConnectors.permissionNames})`
        .mapWith(zodDriverValueDecoder(z.unknown()))
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
        .mapWith(zodDriverValueDecoder(z.unknown()))
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
  const definitions = builder
    .select({
      payload: contextJsonProjection(workflowColumns)
        .mapWith(zodDriverValueDecoder(z.unknown()))
        .as("payload"),
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, scope.orgId),
        eq(workflows.agentId, scope.agentId),
        or(
          isNull(workflows.officialDefinitionName),
          eq(workflows.officialInstallationState, "installed"),
        ),
        or(
          eq(workflows.visibility, "public"),
          eq(workflows.ownerUserId, scope.userId),
        ),
      ),
    );
  return { builtin, custom, permissions, definitions };
}

export function createAgentSelectionContext(
  scope: AgentConnectorSelectionScope,
) {
  const raw$ = computed(async (get) => {
    const { builtin, custom, permissions, definitions } = agentSelectionQueries(
      scope,
      nowDate(),
    );
    const [row] = await get(db$)
      .select({
        builtin: contextJsonRows(builtin).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
        custom: contextJsonRows(custom).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
        permissions: contextJsonRows(permissions).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
        workflows: contextJsonRows(definitions).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
      })
      .from(sql`(values (1)) as context_seed(value)`);
    if (!row) {
      throw new Error("Agent selection context query returned no row");
    }
    return row;
  });
  const connectorSelection$ = computed(async (get) => {
    const row = await get(raw$);
    const builtin = z
      .array(contextProjectionSchema(builtinColumns))
      .parse(row.builtin);
    const custom = z
      .array(
        z.object({
          connector: contextProjectionSchema(connectorColumns),
          oauthConfig: contextProjectionSchema(oauthColumns).nullable(),
          permissionNames: z.array(z.string()),
        }),
      )
      .parse(row.custom);
    return agentConnectorSelectionFromRows(builtin, custom);
  });
  const permissionGrants$ = computed(async (get) => {
    return z
      .array(contextProjectionSchema(permissionColumns))
      .parse((await get(raw$)).permissions);
  });
  const workflows$ = computed(async (get) => {
    return workflowsForRunFromRows(
      z
        .array(contextProjectionSchema(workflowColumns))
        .parse((await get(raw$)).workflows),
      scope.userId,
    );
  });
  return { connectorSelection$, permissionGrants$, workflows$ };
}
