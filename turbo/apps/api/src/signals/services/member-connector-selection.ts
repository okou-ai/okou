import { connectors } from "@okouai/db/schema/connector";
import { connectorPermissionGrants } from "@okouai/db/schema/connector-permission-grant";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import {
  and,
  asc,
  eq,
  exists,
  getTableColumns,
  gt,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { unknown as zUnknown } from "zod";

import {
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { contextJsonProjection } from "./context-rowset";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import { customConnectorSkillBundleSelection } from "./custom-connector-skill-bundle-columns";

/** The storage identity is a connector target, never an Agent or account. */
export function memberConnectorPermissionColumns() {
  return {
    connectorSlug:
      sql`CASE WHEN ${connectorPermissionGrants.connectorSlug} IS NOT NULL
      THEN ${connectorPermissionGrants.connectorSlug}
      ELSE 'custom_connector_' || replace(${connectorPermissionGrants.customConnectorId}::text, '-', '') END`.mapWith(
        pgTextDecoder,
      ),
    permission: connectorPermissionGrants.permission,
    action: connectorPermissionGrants.action,
    expiresAt: connectorPermissionGrants.expiresAt,
  };
}

export function activeMemberConnectorPermissionCondition(
  owner: { readonly orgId: string; readonly userId: string },
  at: Date,
) {
  return and(
    eq(connectorPermissionGrants.orgId, owner.orgId),
    eq(connectorPermissionGrants.userId, owner.userId),
    or(
      isNull(connectorPermissionGrants.expiresAt),
      gt(connectorPermissionGrants.expiresAt, at),
    ),
  );
}

/** Pure builders share the existing bootstrap capture and its decoders. */
export function memberConnectorSelectionQueries(
  owner: { readonly orgId: string; readonly userId: string },
  at: Date,
) {
  const builder = new QueryBuilder();
  const ownedAccount = and(
    eq(connectors.orgId, owner.orgId),
    eq(connectors.userId, owner.userId),
  );
  const builtin = builder
    .selectDistinct({
      payload: contextJsonProjection({
        connectorSlug: connectors.connectorSlug,
      })
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(connectors)
    .where(and(ownedAccount, isNotNull(connectors.connectorSlug)));
  const { networkBinding, ...definitionColumns } =
    customConnectorDefinitionSelection();
  const connectorColumns = {
    ...definitionColumns,
    ...customConnectorSkillBundleSelection(),
  };
  const oauthColumns = getTableColumns(orgCustomConnectorOauthConfigs);
  const custom = builder
    .select({
      payload: sql`jsonb_build_object(
      'connector', ${contextJsonProjection(connectorColumns)} || jsonb_build_object('networkBinding', ${networkBinding.sql}),
      'oauthConfig', CASE WHEN ${orgCustomConnectorOauthConfigs.connectorId} IS NULL THEN NULL ELSE ${contextJsonProjection(oauthColumns)} END,
      'permissionNames', '[]'::jsonb)`
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(orgCustomConnectors.orgId, owner.orgId),
        eq(orgCustomConnectors.enabled, true),
        exists(
          builder
            .select({ id: connectors.id })
            .from(connectors)
            .where(
              and(
                ownedAccount,
                eq(connectors.customConnectorId, orgCustomConnectors.id),
              ),
            ),
        ),
      ),
    );
  const permissionColumns = memberConnectorPermissionColumns();
  const permissions = builder
    .select({
      payload:
        sql`${contextJsonProjection({ permission: connectorPermissionGrants.permission, action: connectorPermissionGrants.action, expiresAt: connectorPermissionGrants.expiresAt })} || jsonb_build_object('connectorSlug', ${permissionColumns.connectorSlug})`
          .mapWith(zodDriverValueDecoder(zUnknown()))
          .as("payload"),
    })
    .from(connectorPermissionGrants)
    .where(activeMemberConnectorPermissionCondition(owner, at))
    .orderBy(
      asc(connectorPermissionGrants.connectorSlug),
      asc(connectorPermissionGrants.customConnectorId),
      asc(connectorPermissionGrants.permission),
    );
  return { builtin, custom, permissions };
}
