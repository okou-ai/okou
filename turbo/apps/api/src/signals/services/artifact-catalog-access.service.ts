import { command } from "ccstate";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  imageArtifacts,
  presentationArtifacts,
  videoArtifacts,
  type ArtifactKind,
} from "@okouai/db/schema/artifact";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import {
  isSharedThreadArtifactLogicalKey,
  sharedThreadArtifactAuthorUserId,
} from "../../lib/shared-thread-artifact";
import { db$ } from "../external/db";
import { canReadArtifactShareTarget$ } from "./artifact-shares.service";
import { checkHostedSiteAccess$ } from "./hosted-site-access.service";
import { sharedThreadArtifactsReadable$ } from "./shared-thread-artifacts.service";

export interface ArtifactCatalogReadTarget {
  readonly kind: ArtifactKind;
  readonly entityId: string;
  readonly logicalKey: string;
  readonly authorUserId: string;
  readonly projectionFileId: string | null;
}

interface ArtifactCatalogViewer {
  readonly userId: string;
  readonly orgId: string;
}

const readArtifactCatalogFile$ = command(
  async (
    { get },
    artifact: ArtifactCatalogReadTarget,
    orgId: string,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const fileIdentity =
      artifact.kind === "file"
        ? eq(runUploadedFiles.id, artifact.entityId)
        : artifact.kind === "image"
          ? inArray(
              runUploadedFiles.id,
              db
                .select({ id: imageArtifacts.fileId })
                .from(imageArtifacts)
                .where(eq(imageArtifacts.id, artifact.entityId)),
            )
          : artifact.kind === "video"
            ? inArray(
                runUploadedFiles.id,
                db
                  .select({ id: videoArtifacts.fileId })
                  .from(videoArtifacts)
                  .where(eq(videoArtifacts.id, artifact.entityId)),
              )
            : artifact.projectionFileId === null
              ? undefined
              : eq(runUploadedFiles.id, artifact.projectionFileId);
    const [file] =
      fileIdentity === undefined
        ? []
        : await db
            .select({
              id: runUploadedFiles.id,
              metadata: runUploadedFiles.metadata,
              materializationStatus: runUploadedFiles.materializationStatus,
              url: runUploadedFiles.url,
            })
            .from(runUploadedFiles)
            .where(
              and(
                fileIdentity,
                eq(runUploadedFiles.orgId, orgId),
                isNull(runUploadedFiles.deletedAt),
              ),
            )
            .limit(1);
    signal.throwIfAborted();
    return file;
  },
);

type ArtifactCatalogFile = Awaited<
  ReturnType<typeof readArtifactCatalogFile$.write>
>;

const canReadHostedCatalogEntry$ = command(
  async (
    { get, set },
    artifact: ArtifactCatalogReadTarget,
    file: ArtifactCatalogFile,
    viewer: ArtifactCatalogViewer,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = get(db$);
    if (artifact.projectionFileId !== null && !file) {
      return false;
    }
    let siteId = artifact.entityId;
    if (artifact.kind === "presentation") {
      const [presentation] = await db
        .select({ siteId: presentationArtifacts.hostedSiteId })
        .from(presentationArtifacts)
        .where(eq(presentationArtifacts.id, artifact.entityId))
        .limit(1);
      signal.throwIfAborted();
      if (!presentation) {
        return false;
      }
      siteId = presentation.siteId;
    }
    if (file?.metadata.access === "owner-private-v1") {
      const deploymentId = file.metadata.deploymentId;
      if (typeof deploymentId !== "string") {
        return false;
      }
      const [deployment] = await db
        .select({
          id: privateHostedDeployments.id,
          userId: privateHostedDeployments.userId,
        })
        .from(privateHostedDeployments)
        .innerJoin(
          hostedSites,
          eq(hostedSites.id, privateHostedDeployments.siteId),
        )
        .where(
          and(
            eq(privateHostedDeployments.id, deploymentId),
            eq(privateHostedDeployments.siteId, siteId),
            eq(privateHostedDeployments.orgId, viewer.orgId),
            eq(privateHostedDeployments.status, "ready"),
            isNull(hostedSites.deletedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      return (
        !!deployment &&
        (deployment.userId === viewer.userId ||
          (await set(
            canReadArtifactShareTarget$,
            {
              target: { kind: "html", id: deployment.id },
              targetId: siteId,
              ...viewer,
            },
            signal,
          )))
      );
    }
    const [publication] = await db
      .select({ id: hostedSites.id })
      .from(hostedSites)
      .innerJoin(
        hostedDeployments,
        eq(hostedDeployments.id, hostedSites.activeDeploymentId),
      )
      .where(
        and(
          eq(hostedSites.id, siteId),
          eq(hostedSites.orgId, viewer.orgId),
          isNull(hostedSites.deletedAt),
          eq(hostedDeployments.status, "ready"),
          sql`NOT (${hostedDeployments.manifest} ? 'access')`,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return (
      !!publication &&
      (
        await set(
          checkHostedSiteAccess$,
          { siteId, userId: viewer.userId },
          signal,
        )
      ).allowed
    );
  },
);

/** Only library callers use this live read authority; management remains owner-only. */
export const canReadArtifactCatalogEntry$ = command(
  async (
    { get, set },
    artifact: ArtifactCatalogReadTarget,
    viewer: ArtifactCatalogViewer,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const owned =
      artifact.authorUserId === viewer.userId ||
      artifact.authorUserId === sharedThreadArtifactAuthorUserId(viewer.userId);
    if (isSharedThreadArtifactLogicalKey(artifact.logicalKey)) {
      const [thread] = await get(db$)
        .select({
          id: sharedThreads.id,
          userId: sharedThreads.userId,
          orgId: sharedThreads.orgId,
          hasArtifactSnapshot: sharedThreads.hasArtifactSnapshot,
          linkLayoutSegment: sharedThreads.linkLayoutSegment,
        })
        .from(sharedThreads)
        .where(eq(sharedThreads.id, artifact.entityId))
        .limit(1);
      signal.throwIfAborted();
      return (
        !!thread &&
        (thread.orgId === viewer.orgId || (owned && thread.orgId === null)) &&
        (await set(
          sharedThreadArtifactsReadable$,
          thread,
          viewer.userId,
          signal,
        ))
      );
    }

    const file = await set(
      readArtifactCatalogFile$,
      artifact,
      viewer.orgId,
      signal,
    );
    if (
      artifact.kind === "file" ||
      artifact.kind === "image" ||
      artifact.kind === "video"
    ) {
      if (!file?.url) {
        return false;
      }
      if (
        file.metadata.storage !== undefined &&
        file.materializationStatus !== "ready"
      ) {
        return false;
      }
      return (
        owned ||
        (await set(
          canReadArtifactShareTarget$,
          {
            target: { kind: "file", id: file.id },
            targetId: file.id,
            ...viewer,
          },
          signal,
        ))
      );
    }

    return await set(
      canReadHostedCatalogEntry$,
      artifact,
      file,
      viewer,
      signal,
    );
  },
);
