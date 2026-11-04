import type {
  ApplyConnectorPermissions,
  ConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import { connectorPermissionGrants } from "@okouai/db/schema/connector-permission-grant";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { command, computed, type Computed } from "ccstate";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { object, uuid } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  connectorAccessAccountOwner,
  type ConnectorAccessOwner,
} from "./connector-access-owner";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeSlugSelectionReadPlan,
  connectorRuntimeSlugSelectionFromRows,
} from "./connector-catalog-slug-source.service";
import {
  customConnectorPermissionBundleDependencySlug,
  loadCustomConnectorPermissionBundle,
} from "./custom-connector-permission-bundle.service";
import {
  connectorPermissionGrantOwner,
  connectorPermissionMutationSql,
} from "./connector-permissions-sql";

/** Only explicit member rules are stored; the catalog supplies default policies. */
export function connectorPermissions(
  scope$: Computed<
    ConnectorAccessOwner | null | Promise<ConnectorAccessOwner | null>
  >,
) {
  return computed(async (get): Promise<ConnectorPermissions | null> => {
    const owner = await get(scope$);
    if (!owner) {
      return null;
    }
    const db = get(db$);
    const [account] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(connectorAccessAccountOwner(owner))
      .limit(1);
    if (!account) {
      return null;
    }
    const rows = await db
      .select({
        permission: connectorPermissionGrants.permission,
        action: connectorPermissionGrants.action,
        expiresAt: connectorPermissionGrants.expiresAt,
      })
      .from(connectorPermissionGrants)
      .where(
        and(
          connectorPermissionGrantOwner(owner),
          or(
            isNull(connectorPermissionGrants.expiresAt),
            gt(connectorPermissionGrants.expiresAt, nowDate()),
          ),
        ),
      )
      .orderBy(asc(connectorPermissionGrants.permission));
    return {
      target: owner.target,
      grants: rows.map((row) => {
        return {
          ...row,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        };
      }),
    };
  });
}

export const applyConnectorPermissions$ = command(
  async (
    { set },
    owner: ConnectorAccessOwner,
    apply: ApplyConnectorPermissions,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [account] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(connectorAccessAccountOwner(owner))
      .limit(1);
    signal.throwIfAborted();
    if (!account) {
      return "not_found" as const;
    }
    const [definition] =
      owner.target.kind === "custom"
        ? await db
            .select({
              permissionBundleRef: orgCustomConnectors.permissionBundleRef,
            })
            .from(orgCustomConnectors)
            .where(
              and(
                eq(orgCustomConnectors.orgId, owner.orgId),
                eq(orgCustomConnectors.id, owner.target.customConnectorId),
              ),
            )
            .limit(1)
        : [];
    signal.throwIfAborted();
    const slug =
      owner.target.kind === "builtin"
        ? owner.target.connectorSlug
        : definition?.permissionBundleRef
          ? customConnectorPermissionBundleDependencySlug(
              definition.permissionBundleRef,
            )
          : null;
    const catalogPlan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: slug === null ? [] : [slug],
    });
    const snapshot = connectorRuntimeSlugSelectionFromRows(
      catalogPlan.selection,
      await db
        .select(catalogPlan.columns)
        .from(connectorCatalog)
        .leftJoin(connectorCatalogEntries, catalogPlan.join)
        .where(connectorCatalogCurrentWhere()),
    );
    signal.throwIfAborted();
    const names =
      owner.target.kind === "builtin"
        ? (
            await snapshot.serverFirewalls.loadPermissionIndex(
              owner.target.connectorSlug,
            )
          )?.permissionNames
        : definition?.permissionBundleRef
          ? (
              await loadCustomConnectorPermissionBundle({
                catalog: snapshot.serverFirewalls,
                ref: definition.permissionBundleRef,
              })
            )?.permissionNames
          : undefined;
    signal.throwIfAborted();
    if (
      apply.grants.some((grant) => {
        return (
          grant.permission !== UNKNOWN_PERMISSION_GRANT &&
          !names?.has(grant.permission)
        );
      })
    ) {
      return "Unknown connector permission";
    }
    const rows = parseRawRows(
      object({ id: uuid() }),
      await db.execute(connectorPermissionMutationSql(owner, apply, nowDate())),
    );
    signal.throwIfAborted();
    return rows.length > 0 ? ("updated" as const) : ("not_found" as const);
  },
);
