import { command } from "ccstate";
import { and, eq, exists, inArray, or } from "drizzle-orm";
import type { ArtifactCatalogDeleteRouteResponse } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifacts,
  imageArtifacts,
  presentationArtifacts,
  videoArtifacts,
} from "@okouai/db/schema/artifact";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { hostedSites } from "@okouai/db/runtime/hosted-site";

import { badRequestMessage, notConfigured, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import {
  isSharedThreadArtifactLogicalKey,
  sharedThreadArtifactAuthorUserId,
} from "../../lib/shared-thread-artifact";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { deleteS3Objects } from "../external/s3";
import { resolveOwnedPublicArtifactKey$ } from "./artifact-storage.service";
import { revokeDeletedFileArtifactShare$ } from "./artifact-shares.service";
import { deleteHostedSite$ } from "./host.service";

interface ArtifactOwner {
  readonly userId: string;
  readonly orgId: string;
}
interface ArtifactWithdrawalArgs extends ArtifactOwner {
  readonly artifact: typeof artifacts.$inferSelect;
}

function ownedArtifactFilter(artifactId: string, owner: ArtifactOwner) {
  return and(
    eq(artifacts.id, artifactId),
    eq(artifacts.orgId, owner.orgId),
    inArray(artifacts.authorUserId, [
      owner.userId,
      sharedThreadArtifactAuthorUserId(owner.userId),
    ]),
  );
}

const withdrawHostedArtifact$ = command(
  async (
    { get, set },
    { artifact, ...owner }: ArtifactWithdrawalArgs,
    signal: AbortSignal,
  ): Promise<Exclude<
    ArtifactCatalogDeleteRouteResponse,
    { readonly status: 200 }
  > | null> => {
    const db = get(db$);
    let siteId = artifact.entityId;
    if (artifact.kind === "presentation") {
      const [presentation] = await db
        .select({ siteId: presentationArtifacts.hostedSiteId })
        .from(presentationArtifacts)
        .where(eq(presentationArtifacts.id, artifact.entityId))
        .limit(1);
      signal.throwIfAborted();
      if (!presentation) {
        return notFound("Artifact not found");
      }
      siteId = presentation.siteId;
    }
    const [site] = await db
      .select({ publicSlug: hostedSites.publicSlug })
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, siteId),
          eq(hostedSites.userId, owner.userId),
          eq(hostedSites.orgId, owner.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return notFound("Artifact not found");
    }
    const result = await set(
      deleteHostedSite$,
      { ...owner, publicSlug: site.publicSlug },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "bad_request") {
      return badRequestMessage(result.message);
    }
    if (result.status === "config_error") {
      return notConfigured(result.message);
    }
    return result.status === "not_found"
      ? notFound("Artifact not found")
      : null;
  },
);

const withdrawFileArtifact$ = command(
  async (
    { get, set },
    { artifact, ...owner }: ArtifactWithdrawalArgs,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    let fileId = artifact.projectionFileId;
    if (!fileId) {
      if (artifact.kind === "file") {
        fileId = artifact.entityId;
      } else {
        const table =
          artifact.kind === "image" ? imageArtifacts : videoArtifacts;
        const [entity] = await db
          .select({ fileId: table.fileId })
          .from(table)
          .where(eq(table.id, artifact.entityId))
          .limit(1);
        signal.throwIfAborted();
        fileId = entity?.fileId ?? null;
      }
    }
    if (!fileId) {
      return;
    }
    const files = await db
      .update(runUploadedFiles)
      .set({ deletedAt: nowDate() })
      .where(
        and(
          exists(
            db
              .select({ id: artifacts.id })
              .from(artifacts)
              .where(ownedArtifactFilter(artifact.id, owner)),
          ),
          eq(runUploadedFiles.userId, owner.userId),
          eq(runUploadedFiles.orgId, owner.orgId),
          or(
            eq(runUploadedFiles.id, fileId),
            artifact.sourceUrl
              ? eq(runUploadedFiles.url, artifact.sourceUrl)
              : undefined,
          ),
        ),
      )
      .returning({ id: runUploadedFiles.id });
    signal.throwIfAborted();
    for (const file of files) {
      await set(
        revokeDeletedFileArtifactShare$,
        { ...owner, fileId: file.id },
        signal,
      );
      signal.throwIfAborted();
    }
    // Old public files have no private policy. Withdraw only an object whose
    // own storage metadata proves it belongs to this user.
    if (artifact.sourceUrl) {
      const key = await set(
        resolveOwnedPublicArtifactKey$,
        { userId: owner.userId, url: artifact.sourceUrl },
        signal,
      );
      signal.throwIfAborted();
      if (key) {
        await get(
          deleteS3Objects(env("R2_USER_ARTIFACTS_BUCKET_NAME"), [key], signal),
        );
        signal.throwIfAborted();
      }
    }
  },
);

/** Keep the catalog identity as a tombstone so delayed projections cannot restore it. */
export const deleteArtifact$ = command(
  async (
    { set },
    args: ArtifactOwner & { readonly artifactId: string },
    signal: AbortSignal,
  ): Promise<ArtifactCatalogDeleteRouteResponse> => {
    const db = set(writeDb$);
    const ownership = ownedArtifactFilter(args.artifactId, args);
    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(ownership)
      .limit(1);
    signal.throwIfAborted();
    if (!artifact) {
      return notFound("Artifact not found");
    }
    const deletedAt = artifact.deletedAt ?? nowDate();
    const hosted =
      artifact.kind === "hosted-site" || artifact.kind === "presentation";
    const withdrawal = { artifact, userId: args.userId, orgId: args.orgId };
    if (hosted && !artifact.deletedAt) {
      const denied = await set(withdrawHostedArtifact$, withdrawal, signal);
      signal.throwIfAborted();
      if (denied) {
        return denied;
      }
    }
    // Removing a saved conversation must never revoke the original author's link.
    if (!hosted && !isSharedThreadArtifactLogicalKey(artifact.logicalKey)) {
      await set(withdrawFileArtifact$, withdrawal, signal);
      signal.throwIfAborted();
    }
    // Keep the card available for retry until every withdrawal has succeeded.
    // File tombstones already deny new owner URLs and sharing during recovery.
    await db
      .update(artifacts)
      .set({ deletedAt })
      .where(
        and(
          ownership,
          hosted && artifact.projectionFileId
            ? eq(artifacts.projectionFileId, artifact.projectionFileId)
            : undefined,
        ),
      );
    signal.throwIfAborted();
    return { status: 200, body: { deleted: true } };
  },
);
