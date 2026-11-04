import type { ApplyConnectorPermissions } from "@okouai/api-contracts/contracts/connector-permissions";
import { connectors } from "@okouai/db/schema/connector";
import { connectorPermissionGrants } from "@okouai/db/schema/connector-permission-grant";
import { and, count, eq, notInArray, sql } from "drizzle-orm";

import {
  connectorAccessAccountOwner,
  type ConnectorAccessOwner,
} from "./connector-access-owner";
import { resolveGrantExpiresAt } from "./permission-grant-apply-plan";

export function connectorPermissionGrantOwner(owner: ConnectorAccessOwner) {
  return and(
    eq(connectorPermissionGrants.orgId, owner.orgId),
    eq(connectorPermissionGrants.userId, owner.userId),
    owner.target.kind === "builtin"
      ? eq(connectorPermissionGrants.connectorSlug, owner.target.connectorSlug)
      : eq(
          connectorPermissionGrants.customConnectorId,
          owner.target.customConnectorId,
        ),
  );
}

/** Patch or replace the member's explicit overlay in one owning statement. */
export function connectorPermissionMutationSql(
  owner: ConnectorAccessOwner,
  apply: ApplyConnectorPermissions,
  timestamp: Date,
) {
  const slug =
    owner.target.kind === "builtin" ? owner.target.connectorSlug : null;
  const customId =
    owner.target.kind === "custom" ? owner.target.customConnectorId : null;
  const conflict =
    owner.target.kind === "builtin"
      ? sql`(org_id, user_id, connector_slug, permission) WHERE connector_slug IS NOT NULL`
      : sql`(org_id, user_id, custom_connector_id, permission) WHERE custom_connector_id IS NOT NULL`;
  const values = apply.grants.map((grant) => {
    const expiresAt = resolveGrantExpiresAt(
      grant.action === "allow" ? grant.expiresIn : undefined,
      timestamp,
    );
    return sql`(${owner.orgId}::text, ${owner.userId}::text, ${slug}::varchar, ${customId}::uuid,
      ${grant.permission}::varchar, ${grant.action}::varchar,
      ${sql.param(expiresAt, connectorPermissionGrants.expiresAt)}::timestamp)`;
  });
  const requested = apply.grants.map((grant) => {
    return grant.permission;
  });
  const saved =
    values.length === 0
      ? sql`SELECT ${count()} FROM removed_connector_grants`
      : sql`INSERT INTO ${connectorPermissionGrants}
      (org_id, user_id, connector_slug, custom_connector_id, permission, action, expires_at)
      SELECT requested.* FROM (VALUES ${sql.join(values, sql`, `)})
        AS requested(org_id, user_id, connector_slug, custom_connector_id, permission, action, expires_at)
      WHERE EXISTS (SELECT 1 FROM owned_connector)
        AND (SELECT ${count()} FROM removed_connector_grants) >= 0
      ON CONFLICT ${conflict} DO UPDATE SET action = excluded.action, expires_at = excluded.expires_at
      RETURNING id`;
  return sql`WITH owned_connector AS MATERIALIZED (
    SELECT ${connectors.id} FROM ${connectors} WHERE ${connectorAccessAccountOwner(owner)} LIMIT 1
  ), removed_connector_grants AS (
    DELETE FROM ${connectorPermissionGrants} WHERE ${connectorPermissionGrantOwner(owner)}
      AND ${apply.mode === "replace"}
      AND ${notInArray(connectorPermissionGrants.permission, requested)}
      AND EXISTS (SELECT 1 FROM owned_connector) RETURNING id
  ), saved_connector_grants AS (${saved})
    SELECT id FROM owned_connector WHERE (SELECT ${count()} FROM saved_connector_grants) >= 0`;
}
