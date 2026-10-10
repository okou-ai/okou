import { computed, type Computed } from "ccstate";
import type { OfficialWorkflowAcceptedRevision } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import {
  storageVersionCacheKeySql,
  cacheRowsFromProjection,
} from "./execution-storage-cache-read.service";
import {
  officialWorkflowCatalogState,
  officialWorkflowCatalogReleases,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { db$ } from "../external/db";
import { storageIndexKey, type StorageIndex } from "./storage-index.service";
import type { SelectedAgentWorkflow } from "./execution-agent-workflows.service";
import {
  acceptedRevisionFromRow,
  acceptedOfficialWorkflowCatalogReadPlan,
  acceptedCatalogFromRow,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  acceptedDefinitionForName,
  OfficialWorkflowRunAdmissionError,
} from "./official-workflow-run.service";

export function createOfficialWorkflowCatalog() {
  return computed(async (get) => {
    const plan = acceptedOfficialWorkflowCatalogReadPlan();
    const [row] = await get(db$)
      .select(plan.columns)
      .from(officialWorkflowCatalogState)
      .innerJoin(officialWorkflowCatalogReleases, plan.join)
      .where(plan.condition)
      .limit(1);
    return acceptedCatalogFromRow(row);
  });
}

/** Catalog and exact published revisions are independent of model routing/mount paths. */
export function createOfficialWorkflowFacts(
  workflows$: Computed<Promise<readonly SelectedAgentWorkflow[]>>,
  catalog$: ReturnType<typeof createOfficialWorkflowCatalog>,
) {
  return computed(async (get) => {
    const workflows = await get(workflows$);
    const names = [
      ...new Set(
        workflows.flatMap((workflow) => {
          return workflow.officialDefinitionName === null
            ? []
            : [workflow.officialDefinitionName];
        }),
      ),
    ].sort();
    if (names.length === 0) {
      return null;
    }
    const catalog = await get(catalog$);
    if (!catalog) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    const definitions = names.map((name) => {
      const definition = acceptedDefinitionForName(
        catalog.payload.definitions,
        name,
      );
      if (!definition) {
        throw new OfficialWorkflowRunAdmissionError();
      }
      return definition;
    });
    const rows = await get(db$)
      .select({
        definitionName: officialWorkflowDefinitionRevisions.definitionName,
        revision: officialWorkflowDefinitionRevisions.revision,
        payload: officialWorkflowDefinitionRevisions.payload,
        storageName: officialWorkflowDefinitionRevisions.storageName,
        storageId: officialWorkflowDefinitionRevisions.storageId,
        storageVersion: officialWorkflowDefinitionRevisions.storageVersion,
        headVersionId: storages.headVersionId,
        s3Prefix: storages.s3Prefix,
        s3Key: storageVersions.s3Key,
        archiveSize: storageVersions.archiveSize,
        fileCount: storageVersions.fileCount,
        cacheKey: systemStoragePresignedUrlCache.cacheKey,
        cacheScope: systemStoragePresignedUrlCache.scope,
        presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
        expiresAt: systemStoragePresignedUrlCache.expiresAt,
      })
      .from(officialWorkflowDefinitionRevisions)
      .innerJoin(
        storages,
        and(
          eq(storages.id, officialWorkflowDefinitionRevisions.storageId),
          eq(storages.name, officialWorkflowDefinitionRevisions.storageName),
          eq(storages.orgId, SYSTEM_ORG_ID),
          eq(storages.userId, VOLUME_ORG_USER_ID),
        ),
      )
      .innerJoin(
        storageVersions,
        and(
          eq(
            storageVersions.id,
            officialWorkflowDefinitionRevisions.storageVersion,
          ),
          eq(
            storageVersions.storageId,
            officialWorkflowDefinitionRevisions.storageId,
          ),
        ),
      )
      .leftJoin(
        systemStoragePresignedUrlCache,
        eq(
          systemStoragePresignedUrlCache.cacheKey,
          storageVersionCacheKeySql({
            orgId: sql`${storages.orgId}`,
            userId: sql`${storages.userId}`,
            name: sql`${storages.name}`,
            versionId: sql`${storageVersions.id}`,
            s3Key: sql`${storageVersions.s3Key}`,
          }),
        ),
      )
      .where(
        or(
          ...definitions.map((definition) => {
            return and(
              eq(
                officialWorkflowDefinitionRevisions.definitionName,
                definition.name,
              ),
              eq(
                officialWorkflowDefinitionRevisions.revision,
                definition.revision,
              ),
            );
          }),
        ),
      )
      .orderBy(
        asc(officialWorkflowDefinitionRevisions.definitionName),
        asc(officialWorkflowDefinitionRevisions.revision),
      );
    return {
      catalog,
      storageIndex: publishedStorageIndex(rows),
      revisions: new Map(
        rows.map((revision) => {
          return [
            JSON.stringify([revision.definitionName, revision.revision]),
            acceptedRevisionFromRow(revision),
          ];
        }),
      ),
    };
  });
}

type PublishedRevisionStorage = Pick<
  typeof officialWorkflowDefinitionRevisions.$inferSelect,
  "storageName" | "storageId" | "storageVersion"
> &
  Pick<typeof storages.$inferSelect, "headVersionId" | "s3Prefix"> &
  Pick<
    typeof storageVersions.$inferSelect,
    "s3Key" | "archiveSize" | "fileCount"
  > &
  Parameters<typeof cacheRowsFromProjection>[0];

function publishedStorageIndex(
  rows: readonly PublishedRevisionStorage[],
): StorageIndex {
  return new Map(
    rows.map((revision) => {
      const version = {
        id: revision.storageVersion,
        s3Key: revision.s3Key,
        archiveSize: revision.archiveSize,
        fileCount: revision.fileCount,
      };
      return [
        storageIndexKey(
          SYSTEM_ORG_ID,
          VOLUME_ORG_USER_ID,
          revision.storageName,
        ),
        {
          storageId: revision.storageId,
          headVersionId: revision.headVersionId,
          s3Prefix: revision.s3Prefix,
          headVersion:
            revision.headVersionId === revision.storageVersion ? version : null,
          exactVersions: new Map([[revision.storageVersion, version]]),
          cachedUrls: cacheRowsFromProjection(revision),
        },
      ];
    }),
  );
}

export type OfficialWorkflowContextFacts = {
  readonly catalog: AcceptedOfficialWorkflowCatalog;
  readonly storageIndex: StorageIndex;
  readonly revisions: ReadonlyMap<
    string,
    OfficialWorkflowAcceptedRevision | null
  >;
} | null;
