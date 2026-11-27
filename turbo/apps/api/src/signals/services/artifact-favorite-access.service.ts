import { command } from "ccstate";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { uuid } from "zod";
import type { ArtifactCatalogCategory } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ArtifactFavoriteDetail } from "@okouai/api-contracts/contracts/artifact-favorites";
import {
  artifacts,
  imageArtifacts,
  videoArtifacts,
} from "@okouai/db/schema/artifact";
import { artifactShares } from "@okouai/db/schema/artifact-share";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import {
  isSharedThreadArtifactLogicalKey,
  sharedThreadArtifactAuthorUserId,
  sharedThreadArtifactLogicalKey,
} from "../../lib/shared-thread-artifact";
import { db$ } from "../external/db";
import { s3ObjectHead } from "../external/s3";
import {
  artifactCatalogCategory,
  getArtifactCatalogEntry$,
} from "./artifact-catalog.service";
import { artifactReferenceRecord$ } from "./artifact-reference.service";
import { publicArtifactKeyFromUrl } from "./artifact-storage.service";
import { messageArtifactAddress } from "./message-artifact.service";
import { privateArtifactRecord$ } from "./private-artifact-storage.service";
import { resolveInvitedArtifactFile$ } from "./artifact-file-share-access.service";
import {
  resolveArtifactTargetShare$,
  resolvePublicArtifactUrl$,
} from "./artifact-shares.service";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import { uploadedArtifactPreviewImageUrl$ } from "./uploaded-artifact.service";
import { sharedThreadArtifactsReadable$ } from "./shared-thread-artifacts.service";
import { getHostedSiteFiles$ } from "./host.service";
import { readHostedSitePolicy$ } from "./hosted-site-access.service";
import { createHostedSitePreviewGrant$ } from "./private-hosted-preview.service";

interface Viewer {
  readonly userId: string;
  readonly orgId: string;
}

interface CatalogTarget {
  readonly artifact: typeof artifacts.$inferSelect;
  readonly category: ArtifactCatalogCategory;
  readonly metadata: typeof runUploadedFiles.$inferSelect.metadata | null;
}

interface TargetRead extends Viewer {
  readonly target: CatalogTarget;
}

interface ReadableFavorite {
  readonly detail: ArtifactFavoriteDetail;
  readonly category: ArtifactCatalogCategory;
}

function viewerDetail(detail: ArtifactFavoriteDetail): ArtifactFavoriteDetail {
  if (detail.isOwner) {
    return detail;
  }
  const safe = { ...detail };
  // These describe the owner's private conversation/account, not this target.
  delete safe.sourceChatThreadId;
  delete safe.googleDriveConnectionId;
  delete safe.googleDriveSync;
  delete safe.aliasUrl;
  return safe;
}

const readSharedThreadFavorite$ = command(
  async (
    { get, set },
    args: TargetRead,
    signal: AbortSignal,
  ): Promise<ReadableFavorite | null> => {
    const catalog = args.target.artifact;
    const [thread] = await get(db$)
      .select()
      .from(sharedThreads)
      .where(
        and(
          eq(sharedThreads.id, catalog.entityId),
          eq(sharedThreads.orgId, catalog.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !thread ||
      thread.orgId === null ||
      thread.orgId !== catalog.orgId ||
      catalog.authorUserId !==
        sharedThreadArtifactAuthorUserId(thread.userId) ||
      !(await set(sharedThreadArtifactsReadable$, thread, args.userId, signal))
    ) {
      return null;
    }
    const detail = await set(
      getArtifactCatalogEntry$,
      { artifactId: catalog.id, orgId: thread.orgId, userId: thread.userId },
      signal,
    );
    return detail
      ? {
          detail: viewerDetail({
            ...detail,
            isOwner:
              thread.userId === args.userId && thread.orgId === args.orgId,
          }),
          category: args.target.category,
        }
      : null;
  },
);

const favoriteSiteDeployment$ = command(
  async (
    { get, set },
    args: {
      readonly target: CatalogTarget;
      readonly siteId: string;
      readonly owner: Viewer;
    },
    signal: AbortSignal,
  ) => {
    const policy = await set(readHostedSitePolicy$, args.siteId, signal);
    if (
      !policy ||
      policy.site.userId !== args.owner.userId ||
      policy.site.orgId !== args.owner.orgId
    ) {
      return null;
    }
    const privateVersion = args.target.metadata?.access === "owner-private-v1";
    const deploymentId = privateVersion
      ? uuid().parse(args.target.metadata?.deploymentId)
      : policy.site.activeDeploymentId;
    if (!deploymentId) {
      return null;
    }
    const [deployment] = privateVersion
      ? await get(db$)
          .select()
          .from(privateHostedDeployments)
          .where(
            and(
              eq(privateHostedDeployments.id, deploymentId),
              eq(privateHostedDeployments.siteId, args.siteId),
              eq(privateHostedDeployments.userId, args.owner.userId),
              eq(privateHostedDeployments.orgId, args.owner.orgId),
            ),
          )
          .limit(1)
      : await get(db$)
          .select()
          .from(hostedDeployments)
          .where(
            and(
              eq(hostedDeployments.id, deploymentId),
              eq(hostedDeployments.siteId, args.siteId),
              eq(hostedDeployments.userId, args.owner.userId),
              eq(hostedDeployments.orgId, args.owner.orgId),
            ),
          )
          .limit(1);
    signal.throwIfAborted();
    return deployment?.status === "ready" ? { deployment, policy } : null;
  },
);

const readSiteFavorite$ = command(
  async (
    { set },
    args: TargetRead,
    signal: AbortSignal,
  ): Promise<ReadableFavorite | null> => {
    const catalog = args.target.artifact;
    const owner = { orgId: catalog.orgId, userId: catalog.authorUserId };
    const isOwner = owner.userId === args.userId && owner.orgId === args.orgId;
    const siteId = uuid().parse(catalog.logicalKey.slice("site:".length));
    const current = await set(
      favoriteSiteDeployment$,
      { target: args.target, siteId, owner },
      signal,
    );
    if (!current) {
      return null;
    }
    const { deployment, policy } = current;
    const deploymentId = deployment.id;
    if (!isOwner) {
      // The production files authority checks exact-version grants as well as
      // current visibility and direct/channel recipients. An old HTML share
      // cannot authorize a newer owner-private deployment of the same Site.
      const access = await set(
        getHostedSiteFiles$,
        {
          publicSlug: `dpl-${deploymentId}`,
          userId: args.userId,
          orgId: args.orgId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (access.status === "not_found") {
        return null;
      }
      if (access.status !== "ok") {
        throw new Error(access.message);
      }
      if (access.body.deploymentId !== deploymentId) {
        throw new Error(
          "Authorized website does not match the current version",
        );
      }
    }
    // This owner-only helper projects metadata AFTER the viewer is authorized.
    const detail = await set(
      getArtifactCatalogEntry$,
      { artifactId: catalog.id, ...owner },
      signal,
    );
    if (
      !detail ||
      !("site" in detail) ||
      detail.site.id !== siteId ||
      detail.site.deploymentVersion !==
        (deployment.manifest.deploymentVersion ?? null)
    ) {
      return null;
    }
    const preview = await set(
      createHostedSitePreviewGrant$,
      {
        siteId,
        deploymentId,
        prefix: deployment.r2Prefix,
        revision: policy.revision,
        ...(deployment.manifest.immutableContent === true
          ? { immutableContent: true as const }
          : {}),
      },
      signal,
    );
    const cover =
      catalog.projectionFileId &&
      args.target.metadata?.deploymentId === deploymentId
        ? await set(
            uploadedArtifactPreviewImageUrl$,
            { id: catalog.projectionFileId, ...owner },
            signal,
          )
        : undefined;
    signal.throwIfAborted();
    return {
      detail: viewerDetail({
        ...detail,
        thumbnail: cover ? { url: cover } : null,
        sourceUrl: isOwner ? detail.sourceUrl : preview.url,
        site: { ...detail.site, url: preview.url },
        isOwner,
      }),
      category: args.target.category,
    };
  },
);

const favoriteFileSource$ = command(
  async (
    { get },
    catalog: typeof artifacts.$inferSelect,
    signal: AbortSignal,
  ) => {
    let fileId = catalog.projectionFileId;
    if (!fileId && (catalog.kind === "image" || catalog.kind === "video")) {
      const [media] =
        catalog.kind === "image"
          ? await get(db$)
              .select({ fileId: imageArtifacts.fileId })
              .from(imageArtifacts)
              .where(eq(imageArtifacts.id, catalog.entityId))
              .limit(1)
          : await get(db$)
              .select({ fileId: videoArtifacts.fileId })
              .from(videoArtifacts)
              .where(eq(videoArtifacts.id, catalog.entityId))
              .limit(1);
      signal.throwIfAborted();
      fileId = media?.fileId ?? null;
    } else if (!fileId && catalog.kind === "file") {
      fileId = catalog.entityId;
    }
    if (!fileId) {
      return null;
    }
    const [source] = await get(db$)
      .select({ id: runUploadedFiles.id, url: runUploadedFiles.url })
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.id, fileId),
          eq(runUploadedFiles.userId, catalog.authorUserId),
          eq(runUploadedFiles.orgId, catalog.orgId),
          isNull(runUploadedFiles.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return source?.url ? { id: source.id, url: source.url } : null;
  },
);

const favoriteFileLocation$ = command(
  async (
    { get, set },
    args: {
      readonly fileId: string;
      readonly sourceUrl: string;
      readonly owner: Viewer;
      readonly viewer: Viewer;
    },
    signal: AbortSignal,
  ) => {
    const file = await set(privateArtifactRecord$, args.fileId, signal);
    // Private records always take precedence over a historical public URL.
    const publicKey = file ? null : publicArtifactKeyFromUrl(args.sourceUrl);
    const isOwner =
      args.owner.userId === args.viewer.userId &&
      args.owner.orgId === args.viewer.orgId;
    let preview: {
      readonly url: string;
      readonly previewImageUrl?: string;
    } | null = null;
    if (file) {
      if (file.materializationStatus !== "ready") {
        return null;
      }
      if (isOwner) {
        const signed = await set(
          resolveArtifactPreviewUrl$,
          { bucket: file.bucket, key: file.key, signingDate: nowDate() },
          signal,
        );
        const cover = await set(
          uploadedArtifactPreviewImageUrl$,
          { id: args.fileId, ...args.owner },
          signal,
        );
        preview = {
          url: signed.url,
          ...(cover ? { previewImageUrl: cover } : {}),
        };
      } else {
        preview =
          (await set(
            resolveInvitedArtifactFile$,
            { file, userId: args.viewer.userId },
            signal,
          )) ??
          (await set(
            resolveArtifactTargetShare$,
            {
              target: { kind: "file", id: args.fileId },
              targetId: args.fileId,
              userId: args.viewer.userId,
            },
            signal,
          ));
      }
    } else if (isOwner || publicKey !== null) {
      // Public authority is the recognized durable object, never accessLevel.
      preview = { url: args.sourceUrl };
    }
    if (!preview) {
      const published = await set(
        resolvePublicArtifactUrl$,
        { kind: "file", id: args.fileId },
        signal,
      );
      preview = published ? { url: published.url } : null;
    }
    signal.throwIfAborted();
    if (!preview) {
      return null;
    }
    const object = file
      ? await get(s3ObjectHead(file.bucket, file.key))
      : publicKey !== null
        ? await get(
            s3ObjectHead(env("R2_USER_ARTIFACTS_BUCKET_NAME"), publicKey),
          )
        : null;
    signal.throwIfAborted();
    return object?.kind === "missing" ? null : preview;
  },
);

const readFileFavorite$ = command(
  async (
    { set },
    args: TargetRead,
    signal: AbortSignal,
  ): Promise<ReadableFavorite | null> => {
    const catalog = args.target.artifact;
    const owner = { orgId: catalog.orgId, userId: catalog.authorUserId };
    const source = await set(favoriteFileSource$, catalog, signal);
    if (!source) {
      return null;
    }
    const preview = await set(
      favoriteFileLocation$,
      { fileId: source.id, sourceUrl: source.url, owner, viewer: args },
      signal,
    );
    if (!preview) {
      return null;
    }
    const detail = await set(
      getArtifactCatalogEntry$,
      { artifactId: catalog.id, ...owner },
      signal,
    );
    if (!detail || !("file" in detail) || detail.file.id !== source.id) {
      return null;
    }
    const isOwner = owner.userId === args.userId && owner.orgId === args.orgId;
    const cover =
      preview.previewImageUrl ??
      (detail.file.contentType.startsWith("image/") ? preview.url : null);
    return {
      detail: viewerDetail({
        ...detail,
        file: { ...detail.file, url: preview.url, previewImageUrl: cover },
        thumbnail: cover ? { url: cover } : null,
        sourceUrl: isOwner ? detail.sourceUrl : preview.url,
        ...(detail.file.contentType.startsWith("video/")
          ? { videoSourceUrl: preview.url }
          : {}),
        isOwner,
      }),
      category: args.target.category,
    };
  },
);

/** Authorize the CURRENT projection, never the older target named by a grant. */
export const readFavoriteArtifact$ = command(
  async (
    { get, set },
    args: Viewer & { readonly artifactId: string },
    signal: AbortSignal,
  ) => {
    const [target] = await get(db$)
      .select({
        artifact: artifacts,
        category: artifactCatalogCategory(),
        metadata: runUploadedFiles.metadata,
      })
      .from(artifacts)
      .leftJoin(
        runUploadedFiles,
        eq(runUploadedFiles.id, artifacts.projectionFileId),
      )
      .where(
        and(eq(artifacts.id, args.artifactId), isNull(artifacts.deletedAt)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!target) {
      return null;
    }
    if (isSharedThreadArtifactLogicalKey(target.artifact.logicalKey)) {
      return await set(readSharedThreadFavorite$, { ...args, target }, signal);
    }
    return target.artifact.logicalKey.startsWith("site:")
      ? await set(readSiteFavorite$, { ...args, target }, signal)
      : await set(readFileFavorite$, { ...args, target }, signal);
  },
);

const favoriteDeploymentSiteId$ = command(
  async ({ get }, deploymentId: string, signal: AbortSignal) => {
    const [deployment] = await get(db$)
      .select({ siteId: hostedDeployments.siteId })
      .from(hostedDeployments)
      .where(eq(hostedDeployments.id, deploymentId))
      .union(
        get(db$)
          .select({ siteId: privateHostedDeployments.siteId })
          .from(privateHostedDeployments)
          .where(eq(privateHostedDeployments.id, deploymentId)),
      )
      .limit(1);
    signal.throwIfAborted();
    return deployment?.siteId;
  },
);

const favoriteReferenceIdentity$ = command(
  async (
    { get, set },
    reference: { readonly id: string | null; readonly hash: string },
    signal: AbortSignal,
  ) => {
    let fileId = reference.id ?? undefined;
    let shareId = reference.id ?? undefined;
    let siteId: string | undefined;
    if (!reference.id) {
      const record = await set(
        artifactReferenceRecord$,
        reference.hash,
        signal,
      );
      if (!record || record.version === 3) {
        return null;
      }
      if (record.version === 1) {
        shareId = record.shareId;
      } else if (record.target.kind === "file") {
        fileId = record.target.id;
      } else {
        siteId = await set(favoriteDeploymentSiteId$, record.target.id, signal);
      }
    }
    if (shareId) {
      const [share] = await get(db$)
        .select()
        .from(artifactShares)
        .where(eq(artifactShares.id, shareId))
        .limit(1);
      signal.throwIfAborted();
      if (share?.targetKind === "file") {
        fileId = share.targetId;
      } else if (share?.targetKind === "html") {
        siteId = share.targetId;
      }
    }
    return { fileId, siteId };
  },
);

const favoriteSiteIdFromSlug$ = command(
  async ({ get, set }, slug: string, signal: AbortSignal) => {
    const deploymentId = uuid().safeParse(
      slug.startsWith("dpl-") ? slug.slice(4) : null,
    );
    if (deploymentId.success) {
      return await set(favoriteDeploymentSiteId$, deploymentId.data, signal);
    }
    const [site] = await get(db$)
      .select({ id: hostedSites.id })
      .from(hostedSites)
      .where(eq(hostedSites.publicSlug, slug))
      .limit(1);
    signal.throwIfAborted();
    return site?.id;
  },
);

/** Link parsing finds identity only. readFavoriteArtifact$ owns authorization. */
export const favoriteArtifactIdFromUrl$ = command(
  async ({ get, set }, url: string, signal: AbortSignal) => {
    const address = messageArtifactAddress(url);
    if (!address) {
      return null;
    }
    let fileId: string | null | undefined = address.fileId;
    let siteId: string | undefined;
    let threadId: string | undefined;
    if (address.reference) {
      const identity = await set(
        favoriteReferenceIdentity$,
        address.reference,
        signal,
      );
      if (!identity) {
        return null;
      }
      fileId = identity.fileId;
      siteId = identity.siteId;
    }
    if (address.siteSlug) {
      siteId = await set(favoriteSiteIdFromSlug$, address.siteSlug, signal);
    }
    const localThread = /^\/share\/threads\/([0-9a-f-]+)\/?$/u.exec(
      address.url.pathname,
    );
    // An arbitrary origin cannot spoof a shared-thread link by copying its path.
    if (localThread && address.local) {
      const parsed = uuid().safeParse(localThread[1]);
      if (parsed.success) {
        threadId = parsed.data;
      }
    }
    const validFile = uuid().safeParse(fileId);
    const identity = or(
      siteId ? eq(artifacts.logicalKey, `site:${siteId}`) : undefined,
      threadId
        ? eq(artifacts.logicalKey, sharedThreadArtifactLogicalKey(threadId))
        : undefined,
      validFile.success
        ? eq(artifacts.projectionFileId, validFile.data)
        : undefined,
      inArray(artifacts.sourceUrl, address.urls),
      inArray(artifacts.aliasUrl, address.urls),
    );
    const [artifact] = await get(db$)
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(identity, isNull(artifacts.deletedAt)))
      .limit(1);
    signal.throwIfAborted();
    return artifact?.id ?? null;
  },
);
