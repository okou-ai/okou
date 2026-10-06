import {
  artifacts,
  artifactCatalogPendingFiles,
  imageArtifacts,
  presentationArtifacts,
  videoArtifacts,
} from "@okouai/db/schema/artifact";
import { hostedSites } from "@okouai/db/schema/hosted-site";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { sharedThreadArtifactAuthorUserId } from "../../lib/shared-thread-artifact";

/** Clean both hosted kinds before the site and presentation cascade. */
export async function deleteArtifactCatalogForHostedSiteId(
  tx: Tx,
  siteId: string,
): Promise<void> {
  // The hosted projector takes the same site lock before writing either kind.
  const [site] = await tx
    .select({ id: hostedSites.id })
    .from(hostedSites)
    .where(eq(hostedSites.id, siteId))
    .for("update")
    .limit(1);
  if (!site) {
    return;
  }
  const presentationIds = tx
    .select({ id: presentationArtifacts.id })
    .from(presentationArtifacts)
    .where(eq(presentationArtifacts.hostedSiteId, siteId));
  await tx
    .delete(artifacts)
    .where(
      or(
        and(eq(artifacts.kind, "hosted-site"), eq(artifacts.entityId, siteId)),
        and(
          eq(artifacts.kind, "presentation"),
          inArray(artifacts.entityId, presentationIds),
        ),
      ),
    );
}

/** Account erasure follows file/catalog ownership, never Run provenance. */
export async function deleteOwnedArtifactFiles(
  tx: Tx,
  scope:
    | { readonly kind: "user"; readonly userId: string }
    | { readonly kind: "organization"; readonly orgId: string },
): Promise<void> {
  const catalogScope =
    scope.kind === "organization"
      ? eq(artifacts.orgId, scope.orgId)
      : inArray(artifacts.authorUserId, [
          scope.userId,
          sharedThreadArtifactAuthorUserId(scope.userId),
        ]);
  const ownedProjections = tx
    .select({ id: artifacts.projectionFileId })
    .from(artifacts)
    .where(catalogScope);
  const ownedPendingFiles = tx
    .select({ id: artifactCatalogPendingFiles.fileId })
    .from(artifactCatalogPendingFiles)
    .where(
      scope.kind === "organization"
        ? eq(artifactCatalogPendingFiles.orgId, scope.orgId)
        : eq(artifactCatalogPendingFiles.authorUserId, scope.userId),
    );
  const fileScope = or(
    scope.kind === "organization"
      ? eq(runUploadedFiles.orgId, scope.orgId)
      : eq(runUploadedFiles.userId, scope.userId),
    scope.kind === "user"
      ? inArray(
          runUploadedFiles.chatThreadId,
          tx
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .where(eq(chatThreads.userId, scope.userId)),
        )
      : undefined,
    inArray(runUploadedFiles.id, ownedProjections),
    inArray(runUploadedFiles.id, ownedPendingFiles),
  );

  for (;;) {
    // Match the projector's file-first lock order. Deleting the actual file
    // also drains its pending queue, media and delivery children by ownership.
    const files = await tx
      .select({ id: runUploadedFiles.id })
      .from(runUploadedFiles)
      .where(fileScope)
      .orderBy(asc(runUploadedFiles.id))
      .limit(500)
      .for("update");
    if (files.length === 0) {
      break;
    }
    const fileIds = files.map((file) => {
      return file.id;
    });
    const imageIds = tx
      .select({ id: imageArtifacts.id })
      .from(imageArtifacts)
      .where(inArray(imageArtifacts.fileId, fileIds));
    const videoIds = tx
      .select({ id: videoArtifacts.id })
      .from(videoArtifacts)
      .where(inArray(videoArtifacts.fileId, fileIds));
    await tx
      .delete(artifacts)
      .where(
        or(
          inArray(artifacts.projectionFileId, fileIds),
          and(eq(artifacts.kind, "file"), inArray(artifacts.entityId, fileIds)),
          and(
            eq(artifacts.kind, "image"),
            inArray(artifacts.entityId, imageIds),
          ),
          and(
            eq(artifacts.kind, "video"),
            inArray(artifacts.entityId, videoIds),
          ),
        ),
      );
    await tx
      .delete(runUploadedFiles)
      .where(inArray(runUploadedFiles.id, fileIds));
  }
  await tx.delete(artifacts).where(catalogScope);
}
