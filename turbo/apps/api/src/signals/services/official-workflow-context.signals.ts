import { computed } from "ccstate";
import type { OfficialWorkflowAcceptedRevision } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { and, asc, eq, or } from "drizzle-orm";
import { officialWorkflowDefinitionRevisions } from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { db$ } from "../external/db";
import { storageIndexKey, type StorageIndex } from "./storage-index.service";
import type { SelectedAgentWorkflow } from "./execution-agent-workflows.service";
import {
  acceptedRevisionFromRow,
  readAcceptedOfficialWorkflowCatalog,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  acceptedDefinitionForName,
  OfficialWorkflowRunAdmissionError,
} from "./official-workflow-run.service";

export function createOfficialWorkflowCatalog() {
  return computed((get) => {
    return readAcceptedOfficialWorkflowCatalog(get(db$));
  });
}

/** Catalog and exact published revisions are independent of model routing/mount paths. */
export function createOfficialWorkflowFacts(
  workflows: readonly SelectedAgentWorkflow[],
  catalog: AcceptedOfficialWorkflowCatalog | null,
) {
  return computed(async (get) => {
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
  >;

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
