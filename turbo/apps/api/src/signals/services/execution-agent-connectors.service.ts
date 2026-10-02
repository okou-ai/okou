import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { computed, type Computed } from "ccstate";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db$ } from "../external/db";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
  pgInt8ToSafeIntegerDecoder,
  zodDriverValueDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";

export interface AgentConnectorSelectionScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

export interface SelectedCustomConnector {
  readonly customConnectorId: string;
  readonly connectorSlug: string;
  readonly permissionNames: readonly string[];
  readonly storageVersion: number;
  readonly skillStorageVersionId: string | null;
  readonly permissionBundleRef: string | null;
  readonly isMcp: boolean;
}

export interface AgentConnectorSelection {
  readonly builtinConnectorSlugs: readonly string[];
  readonly customConnectors: readonly SelectedCustomConnector[];
}

const kindDecoder = zodEnumDriverValueDecoder(z.enum(["builtin", "custom"]));
const nullableTextDecoder = nullableDriverValueDecoder(pgTextDecoder);
const permissionsDecoder = nullableDriverValueDecoder(
  zodDriverValueDecoder(z.array(z.string())),
);
const versionDecoder = nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder);
const mcpDecoder = nullableDriverValueDecoder(pgBooleanDecoder);

/** Batch scoped selections; no account resolution, credential reads or repairs. */
export function createAgentConnectorSelection(
  scope: AgentConnectorSelectionScope,
): Computed<Promise<AgentConnectorSelection>> {
  return computed(async (get) => {
    const db = get(db$);
    const builtinQuery = db
      .select({
        kind: sql`'builtin'`.mapWith(kindDecoder).as("kind"),
        connectorSlug: userBuiltinConnectors.connectorSlug,
        customConnectorId: sql`NULL::text`
          .mapWith(nullableTextDecoder)
          .as("custom_connector_id"),
        permissionNames: sql`NULL::text[]`
          .mapWith(permissionsDecoder)
          .as("permission_names"),
        storageVersion: sql`NULL::bigint`
          .mapWith(versionDecoder)
          .as("storage_version"),
        skillStorageVersionId: sql`NULL::text`
          .mapWith(nullableTextDecoder)
          .as("skill_storage_version_id"),
        permissionBundleRef: sql`NULL::text`
          .mapWith(nullableTextDecoder)
          .as("permission_bundle_ref"),
        isMcp: sql`NULL::boolean`.mapWith(mcpDecoder).as("is_mcp"),
      })
      .from(userBuiltinConnectors)
      .where(
        and(
          eq(userBuiltinConnectors.orgId, scope.orgId),
          eq(userBuiltinConnectors.userId, scope.userId),
          eq(userBuiltinConnectors.agentId, scope.agentId),
        ),
      );
    const rows = await builtinQuery.unionAll(
      db
        .select({
          kind: sql`'custom'`.mapWith(kindDecoder).as("kind"),
          connectorSlug: orgCustomConnectors.slug,
          customConnectorId:
            sql`${userCustomConnectors.customConnectorId}::text`
              .mapWith(pgTextDecoder)
              .as("custom_connector_id"),
          permissionNames: userCustomConnectors.permissionNames,
          storageVersion: orgCustomConnectors.storageVersion,
          skillStorageVersionId: orgCustomConnectors.skillStorageVersionId,
          permissionBundleRef: orgCustomConnectors.permissionBundleRef,
          isMcp: isNotNull(orgCustomConnectors.mcpEndpoint).mapWith(
            pgBooleanDecoder,
          ),
        })
        .from(userCustomConnectors)
        .innerJoin(
          orgCustomConnectors,
          and(
            eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
            eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
          ),
        )
        .where(
          and(
            eq(userCustomConnectors.orgId, scope.orgId),
            eq(userCustomConnectors.userId, scope.userId),
            eq(userCustomConnectors.agentId, scope.agentId),
            eq(orgCustomConnectors.enabled, true),
          ),
        ),
    );
    const builtinConnectorSlugs: string[] = [];
    const customConnectors: SelectedCustomConnector[] = [];
    for (const row of rows) {
      if (row.kind === "builtin") {
        builtinConnectorSlugs.push(row.connectorSlug);
      } else {
        if (
          row.customConnectorId === null ||
          row.permissionNames === null ||
          row.storageVersion === null ||
          row.isMcp === null
        ) {
          throw new Error("Invalid saved custom connector selection");
        }
        customConnectors.push({
          customConnectorId: row.customConnectorId,
          connectorSlug: row.connectorSlug,
          permissionNames: [...row.permissionNames].sort(),
          storageVersion: row.storageVersion,
          skillStorageVersionId: row.skillStorageVersionId,
          permissionBundleRef: row.permissionBundleRef,
          isMcp: row.isMcp,
        });
      }
    }
    return {
      builtinConnectorSlugs: builtinConnectorSlugs.sort(),
      customConnectors: customConnectors.sort((a, b) => {
        return a.customConnectorId.localeCompare(b.customConnectorId);
      }),
    };
  });
}
