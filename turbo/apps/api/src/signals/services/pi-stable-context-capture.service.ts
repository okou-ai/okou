import { z } from "zod";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { connectorCatalogEntries } from "@okouai/db/schema/connector-catalog";
import { connectorCatalogArtifactConnectorSchema } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import type { PiStableContextOwner } from "@okouai/db/jsonb-contracts/pi-stable-context";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { workflows } from "@okouai/db/schema/workflow";
import {
  officialWorkflowCatalogState,
  officialWorkflowCatalogReleases,
} from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import { OFFICIAL_WORKFLOW_CATALOG_AUTHORITY } from "./official-workflow-catalog-read.service";

/** Raw JSON aggregates are decoded here, not asserted with execute<Row>. */
export const piCatalogEntriesReceiptSchema = z.object({
  entries: z.array(connectorCatalogArtifactConnectorSchema),
});
export function piCatalogEntriesSql(
  hash: string | null,
  slugs: readonly string[],
) {
  return sql`select coalesce(jsonb_agg(${connectorCatalogEntries.payload}), '[]'::jsonb) AS entries
    from ${connectorCatalogEntries} where ${hash === null ? sql`false` : and(eq(connectorCatalogEntries.hash, hash), inArray(connectorCatalogEntries.slug, [...slugs]))}`;
}

export const piSourceFactsReceiptSchema = z.object({
  facts: z.object({
    agent: z.object({
      id: z.string(),
      defaultAgentId: z.string().nullable(),
      displayName: z.string().nullable(),
      description: z.string().nullable(),
      sound: z.string().nullable(),
    }),
    email: z.string().nullable(),
    features: z.array(
      z.object({
        userId: z.string(),
        switches: z.record(z.string(), z.boolean()),
      }),
    ),
    builtin: z.array(z.object({ connectorSlug: z.string() })),
    custom: z.array(
      z.object({
        customConnectorId: z.string(),
        permissionNames: z.array(z.string()),
        connectorSlug: z.string(),
        storageVersion: pgInt8ToSafeIntegerSchema,
        skillStorageVersionId: z.string().nullable(),
        permissionBundleRef: z.string().nullable(),
        isMcp: z.boolean(),
      }),
    ),
    workflows: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        visibility: z.enum(["public", "private"]),
        ownerUserId: z.string(),
        officialDefinitionName: z.string().nullable(),
        createdAt: z.coerce.date(),
      }),
    ),
    grants: z.array(
      z.object({
        connectorSlug: z.string(),
        permission: z.string(),
        action: z.enum(["allow", "deny"]),
        expiresAt: z.coerce.date().nullable(),
      }),
    ),
    official: z
      .object({ releaseId: z.string(), payload: z.unknown() })
      .nullable(),
  }),
});

/** One post-lock statement captures the complete source/metadata cohort. */
export function piSourceFactsSql(owner: PiStableContextOwner, checkedAt: Date) {
  return sql`select jsonb_build_object(
    'agent', jsonb_build_object('id', ${agents.id}, 'defaultAgentId', ${orgMetadata.defaultAgentId},
      'displayName', ${agents.displayName}, 'description', ${agents.description}, 'sound', ${agents.sound}),
    'email', (select ${userCache.email} from ${userCache} where ${eq(userCache.userId, owner.userId)} limit 1),
    'features', coalesce((select jsonb_agg(jsonb_build_object('userId', ${userFeatureSwitches.userId}, 'switches', ${userFeatureSwitches.switches}))
      from ${userFeatureSwitches} where ${and(eq(userFeatureSwitches.orgId, owner.orgId), inArray(userFeatureSwitches.userId, [owner.userId, ORG_SENTINEL_USER_ID]))}), '[]'::jsonb),
    'builtin', coalesce((select jsonb_agg(jsonb_build_object('connectorSlug', ${userBuiltinConnectors.connectorSlug}))
      from ${userBuiltinConnectors} where ${and(eq(userBuiltinConnectors.orgId, owner.orgId), eq(userBuiltinConnectors.userId, owner.userId), eq(userBuiltinConnectors.agentId, owner.agentId))}), '[]'::jsonb),
    'custom', coalesce((select jsonb_agg(jsonb_build_object('customConnectorId', ${userCustomConnectors.customConnectorId},
      'permissionNames', ${userCustomConnectors.permissionNames}, 'connectorSlug', ${orgCustomConnectors.slug},
      'storageVersion', ${orgCustomConnectors.storageVersion}::text, 'skillStorageVersionId', ${orgCustomConnectors.skillStorageVersionId},
      'permissionBundleRef', ${orgCustomConnectors.permissionBundleRef}, 'isMcp', ${isNotNull(orgCustomConnectors.mcpEndpoint)}))
      from ${userCustomConnectors} inner join ${orgCustomConnectors} on ${and(eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId), eq(orgCustomConnectors.orgId, userCustomConnectors.orgId))}
      where ${and(eq(userCustomConnectors.orgId, owner.orgId), eq(userCustomConnectors.userId, owner.userId), eq(userCustomConnectors.agentId, owner.agentId), eq(orgCustomConnectors.enabled, true))}), '[]'::jsonb),
    'workflows', coalesce((select jsonb_agg(jsonb_build_object('id', ${workflows.id}, 'name', ${workflows.name}, 'visibility', ${workflows.visibility},
      'ownerUserId', ${workflows.ownerUserId}, 'officialDefinitionName', ${workflows.officialDefinitionName}, 'createdAt', ${workflows.createdAt})) from ${workflows}
      where ${and(
        eq(workflows.orgId, owner.orgId),
        eq(workflows.agentId, owner.agentId),
        or(
          isNull(workflows.officialDefinitionName),
          eq(workflows.officialInstallationState, "installed"),
        ),
        or(
          eq(workflows.visibility, "public"),
          eq(workflows.ownerUserId, owner.userId),
        ),
      )}), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('connectorSlug', ${userPermissionGrants.connectorSlug}, 'permission', ${userPermissionGrants.permission},
      'action', ${userPermissionGrants.action}, 'expiresAt', ${userPermissionGrants.expiresAt}) order by ${asc(userPermissionGrants.connectorSlug)}, ${asc(userPermissionGrants.permission)})
      from ${userPermissionGrants} where ${and(eq(userPermissionGrants.orgId, owner.orgId), eq(userPermissionGrants.userId, owner.userId), eq(userPermissionGrants.agentId, owner.agentId))}
      and ${or(isNull(userPermissionGrants.expiresAt), gt(userPermissionGrants.expiresAt, checkedAt))}), '[]'::jsonb),
    'official', (select jsonb_build_object('releaseId', ${officialWorkflowCatalogState.acceptedReleaseId}, 'payload', ${officialWorkflowCatalogReleases.payload})
      from ${officialWorkflowCatalogState} inner join ${officialWorkflowCatalogReleases} on ${eq(officialWorkflowCatalogReleases.id, officialWorkflowCatalogState.acceptedReleaseId)}
      where ${eq(officialWorkflowCatalogState.authority, OFFICIAL_WORKFLOW_CATALOG_AUTHORITY)} limit 1)
  ) AS facts from ${agents} left join ${orgMetadata} on ${eq(orgMetadata.orgId, agents.orgId)}
  where ${and(eq(agents.id, owner.agentId), eq(agents.orgId, owner.resourceOwner.orgId), eq(agents.owner, owner.resourceOwner.userId))} limit 1`;
}

export interface PiStorageReadRequest {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly storageId?: string;
  readonly versionId?: string;
}
export const piStorageFactsReceiptSchema = z.object({
  facts: z.array(
    z.object({
      orgId: z.string(),
      userId: z.string(),
      name: z.string(),
      storageId: z.string(),
      versionId: z.string(),
      archiveSize: pgInt8ToSafeIntegerSchema,
      fileCount: pgInt8ToSafeIntegerSchema,
      isHead: z.boolean(),
    }),
  ),
});
export type PiStorageFact = z.infer<
  typeof piStorageFactsReceiptSchema
>["facts"][number];

/** Pure SQL only; transaction ownership stays at the caller's execute statement. */
function requiredPiReadCondition(condition: SQL | undefined): SQL {
  if (!condition) {throw new Error("Pi storage read condition is empty");}
  return condition;
}

export function piStorageFactsSql(requests: readonly PiStorageReadRequest[]) {
  const requested = requests.map((request) => {
    return and(
      eq(storages.orgId, request.orgId),
      eq(storages.userId, request.userId),
      eq(storages.name, request.name),
      request.storageId ? eq(storages.id, request.storageId) : undefined,
      request.versionId
        ? eq(storageVersions.id, request.versionId)
        : eq(storageVersions.id, storages.headVersionId),
    );
  });
  const condition: SQL = requiredPiReadCondition(
    requested.length ? or(...requested) : sql`false`,
  );
  return sql`select coalesce(jsonb_agg(jsonb_build_object('orgId', ${storages.orgId}, 'userId', ${storages.userId}, 'name', ${storages.name},
    'storageId', ${storages.id}, 'versionId', ${storageVersions.id}, 'archiveSize', ${storageVersions.archiveSize}::text,
    'fileCount', ${storageVersions.fileCount}::text, 'isHead', coalesce(${eq(storageVersions.id, storages.headVersionId)}, false))), '[]'::jsonb) AS facts
    from ${storages} inner join ${storageVersions} on ${eq(storageVersions.storageId, storages.id)}
    where ${condition}`;
}
