import {
  artifacts,
  artifactCatalogPendingFiles,
  imageArtifacts,
  videoArtifacts,
} from "@okouai/db/schema/artifact";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { sharedThreadArtifactAuthorUserId } from "../../lib/shared-thread-artifact";

/** Pure ownership predicates; the Clerk command owns every database operation. */
export function artifactFileOwnershipConditions(
  scope:
    | { readonly kind: "user"; readonly userId: string }
    | { readonly kind: "organization"; readonly orgId: string },
) {
  const catalogScope =
    scope.kind === "organization"
      ? eq(artifacts.orgId, scope.orgId)
      : inArray(artifacts.authorUserId, [
          scope.userId,
          sharedThreadArtifactAuthorUserId(scope.userId),
        ]);
  const pendingScope =
    scope.kind === "organization"
      ? eq(artifactCatalogPendingFiles.orgId, scope.orgId)
      : eq(artifactCatalogPendingFiles.authorUserId, scope.userId);
  return {
    catalogScope,
    fileScope: or(
      scope.kind === "organization"
        ? eq(runUploadedFiles.orgId, scope.orgId)
        : eq(runUploadedFiles.userId, scope.userId),
      scope.kind === "user"
        ? inArray(
            runUploadedFiles.chatThreadId,
            sql`(SELECT ${chatThreads.id} FROM ${chatThreads}
              WHERE ${eq(chatThreads.userId, scope.userId)})`,
          )
        : undefined,
      inArray(
        runUploadedFiles.id,
        sql`(SELECT ${artifacts.projectionFileId} FROM ${artifacts}
          WHERE ${catalogScope})`,
      ),
      inArray(
        runUploadedFiles.id,
        sql`(SELECT ${artifactCatalogPendingFiles.fileId} FROM ${artifactCatalogPendingFiles}
          WHERE ${pendingScope})`,
      ),
    ),
  };
}

/** Delete only projections of the already locked file batch, before its files. */
export function artifactCatalogFileBatchCondition(fileIds: readonly string[]) {
  return or(
    inArray(artifacts.projectionFileId, fileIds),
    and(eq(artifacts.kind, "file"), inArray(artifacts.entityId, fileIds)),
    and(
      eq(artifacts.kind, "image"),
      inArray(
        artifacts.entityId,
        sql`(SELECT ${imageArtifacts.id} FROM ${imageArtifacts}
          WHERE ${inArray(imageArtifacts.fileId, fileIds)})`,
      ),
    ),
    and(
      eq(artifacts.kind, "video"),
      inArray(
        artifacts.entityId,
        sql`(SELECT ${videoArtifacts.id} FROM ${videoArtifacts}
          WHERE ${inArray(videoArtifacts.fileId, fileIds)})`,
      ),
    ),
  );
}
