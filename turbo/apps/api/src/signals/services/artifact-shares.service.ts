import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { artifactFilenameExtension } from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  linkLayoutFromSegment,
  linkLayoutSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import type { ArtifactDownloadResponse } from "@okouai/api-contracts/contracts/artifact-downloads";
import type {
  ArtifactSharePolicy,
  ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import {
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";

import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { legacyPrivateHostedDeploymentVersion } from "../../lib/hosted-publication";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import {
  clerk$,
  isClerkResourceNotFound,
  type ClerkOrganizationMembership,
} from "../external/clerk";
import { settle } from "../utils";
import { hostedSiteDeliveryManifest } from "./hosted-site-dependencies.service";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import { resolveArtifactDownloadUrl$ } from "./artifact-download-url.service";
import {
  privateArtifactRecord$,
  resolvePrivateArtifactUrl$,
  type PrivateArtifactRecord,
} from "./private-artifact-storage.service";
import { findActiveArtifactForFile$ } from "./artifact-file-share-access.service";
import { probeLegacyArtifactSharePolicy$ } from "./artifact-share-probe.service";
import { signHostedSiteFiles$ } from "./hosted-site-files.service";
import { checkHostedSiteAccess$ } from "./hosted-site-access.service";
import { artifactDeliveryRecord } from "./artifact-delivery.service";
import { resolveSharedThreadHostedDownload$ } from "./shared-thread-artifacts.service";
import { uploadedArtifactPreviewImageUrl$ } from "./uploaded-artifact.service";

export { probeLegacyArtifactSharePolicy$ };

interface ShareCandidate {
  readonly targetId: string;
  readonly ownerUrl: string;
  readonly layout: LinkLayout;
  readonly candidateVersion: number | null;
  readonly target:
    | (Extract<ArtifactSharePolicy["target"], { kind: "file" }> & {
        readonly bucket: string;
      })
    | (Omit<
        Extract<ArtifactSharePolicy["target"], { kind: "html" }>,
        "snapshotId" | "manifest"
      > & {
        readonly manifest: HostedSiteManifest;
      });
}

const ownedShareTarget$ = command(
  async (
    { get, set },
    args: {
      readonly target: ArtifactShareTarget;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<ShareCandidate | null> => {
    const { target, userId, orgId } = args;
    if (target.kind === "file") {
      const file = await set(privateArtifactRecord$, target.id, signal);
      signal.throwIfAborted();
      if (
        !file ||
        file.userId !== userId ||
        file.orgId !== orgId ||
        !file.isReady
      ) {
        return null;
      }
      const ownerUrl = await set(
        resolvePrivateArtifactUrl$,
        { id: file.id, filename: file.filename },
        signal,
      );
      return {
        targetId: file.id,
        ownerUrl,
        layout: file.layout,
        candidateVersion: null,
        target: {
          kind: "file" as const,
          id: file.id,
          key: file.key,
          bucket: file.bucket,
          filename: file.filename,
          contentType: file.contentType,
        },
      };
    }
    const [row] = await get(db$)
      .select({ deployment: privateHostedDeployments })
      .from(privateHostedDeployments)
      .innerJoin(
        hostedSites,
        eq(hostedSites.id, privateHostedDeployments.siteId),
      )
      .where(
        and(
          eq(privateHostedDeployments.id, target.id),
          eq(privateHostedDeployments.userId, userId),
          eq(privateHostedDeployments.orgId, orgId),
          eq(privateHostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const deployment = row.deployment;
    const deploymentVersion = legacyPrivateHostedDeploymentVersion(
      deployment.manifest,
    );
    return {
      targetId: deployment.siteId,
      ownerUrl: new URL(deployment.artifactUrl, env("APP_URL")).href,
      layout: linkLayoutFromSegment(deployment.linkLayoutSegment),
      candidateVersion: deploymentVersion,
      target: {
        kind: "html" as const,
        id: deployment.id,
        siteId: deployment.siteId,
        deploymentVersion,
        manifest: hostedSiteDeliveryManifest(deployment.manifest),
      },
    };
  },
);

function publicShareUrl(policy: ArtifactSharePolicy): string {
  if (!policy.publicToken) {
    throw new Error("Public artifact has no publication token");
  }
  const layout = linkLayoutFromSegment(policy.publicBrand);
  if (!policy.delivery) {
    return `${hostedLinkOrigin(layout, `sh-${policy.shareId.replaceAll("-", "")}-${policy.publicToken}`)}/`;
  }
  if (policy.target.kind === "file") {
    const origin = env("PUBLIC_ARTIFACT_SHARES_BASE_URL");
    if (!origin) {
      throw new Error(
        "PUBLIC_ARTIFACT_SHARES_BASE_URL is required for file sharing",
      );
    }
    return new URL(
      `/${policy.publicToken}${artifactFilenameExtension(policy.target.filename)}`,
      origin,
    ).href;
  }
  return `${hostedLinkOrigin(layout, policy.publicSlug ?? policy.publicToken)}/`;
}

function publicSharePreview(policy: ArtifactSharePolicy) {
  return {
    url: publicShareUrl(policy),
    preview:
      policy.target.kind === "file"
        ? {
            filename: policy.target.filename,
            contentType: policy.target.contentType,
          }
        : { filename: "index.html", contentType: "text/html" },
  };
}

const currentShareMember$ = command(
  async (
    { get },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<ClerkOrganizationMembership | null> => {
    const memberships = await settle(
      get(clerk$).organizations.getOrganizationMembershipList(
        { organizationId: orgId, userId: [userId], limit: 1 },
        undefined,
        signal,
      ),
      signal,
    );
    if (!memberships.ok) {
      if (isClerkResourceNotFound(memberships.error)) {
        return null;
      }
      throw memberships.error;
    }
    return (
      memberships.value.data.find((member) => {
        return member.publicUserData?.userId === userId;
      }) ?? null
    );
  },
);

/**
 * Authorize a historical R2 share policy without querying the retired
 * `artifact_shares` database table.
 */
const authorizedLegacySharePolicy$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly userId: string;
      readonly expectedTarget?: ArtifactShareTarget;
      readonly allowPrivateOwner?: boolean;
      readonly allowPublic?: boolean;
      readonly publicToken?: string;
      readonly layout?: LinkLayout;
    },
    signal: AbortSignal,
  ): Promise<ArtifactSharePolicy | null> => {
    const policy = await set(
      probeLegacyArtifactSharePolicy$,
      { shareId: args.id, layout: args.layout },
      signal,
    );
    if (
      !policy ||
      (policy.status !== "active" &&
        !(args.allowPrivateOwner && policy.ownerId === args.userId)) ||
      (args.expectedTarget &&
        (policy.target.kind !== args.expectedTarget.kind ||
          policy.target.id !== args.expectedTarget.id)) ||
      (args.publicToken !== undefined &&
        (policy.audience !== "public" ||
          policy.publicToken !== args.publicToken)) ||
      (args.layout !== undefined &&
        policy.publicBrand !== linkLayoutSegment(args.layout))
    ) {
      return null;
    }
    if (
      !(args.allowPublic && policy.audience === "public") &&
      !(await set(currentShareMember$, policy.orgId, args.userId, signal))
    ) {
      return null;
    }
    return policy;
  },
);

/**
 * Resolve a historical `/share/artifacts/:shareId` or v1 reference via
 * read-only R2 policy probe (0 DB reads on `artifact_shares`).
 */
export const resolveArtifactShare$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly userId: string;
      readonly expectedTarget?: ArtifactShareTarget;
      readonly allowPrivateOwner?: boolean;
    },
    signal: AbortSignal,
  ) => {
    const policy = await set(authorizedLegacySharePolicy$, args, signal);
    if (!policy || policy.target.kind === "html") {
      return null;
    }
    const file = await set(privateArtifactRecord$, policy.target.id, signal);
    signal.throwIfAborted();
    if (
      !file ||
      file.userId !== policy.ownerId ||
      file.orgId !== policy.orgId ||
      !file.isReady
    ) {
      return null;
    }
    // Honor Library deletion (Principle 4) for live file artifacts: if an
    // active artifact row exists and has been narrowed to private, or if the
    // owner soft-deleted the artifact, only the owner can keep reading via
    // this historical share.
    const artifact = await set(findActiveArtifactForFile$, file, signal);
    if (!artifact && policy.ownerId !== args.userId) {
      return null;
    }
    if (
      artifact &&
      artifact.visibility === "private" &&
      policy.ownerId !== args.userId
    ) {
      return null;
    }
    const preview = await set(
      resolveArtifactPreviewUrl$,
      {
        bucket: file.bucket,
        key: policy.target.key,
        signingDate: nowDate(),
      },
      signal,
    );
    const downloadUrl = await set(
      resolveArtifactDownloadUrl$,
      {
        bucket: file.bucket,
        key: policy.target.key,
        filename: policy.target.filename,
      },
      signal,
    );
    const previewImageUrl =
      artifact?.thumbnail?.url ??
      (await set(
        uploadedArtifactPreviewImageUrl$,
        { id: file.id, userId: policy.ownerId, orgId: policy.orgId },
        signal,
      ));
    signal.throwIfAborted();
    return {
      ...preview,
      downloadUrl,
      filename: file.filename,
      contentType: file.contentType,
      ...(previewImageUrl ? { previewImageUrl } : {}),
      target: { kind: "file" as const, id: policy.target.id },
    };
  },
);

/**
 * Authorize live file visibility (`artifacts.visibility = 'organization' | 'public'`)
 * for an authenticated non-owner viewer.
 */
export const resolveArtifactTargetShare$ = command(
  async (
    { set },
    args: {
      readonly target: ArtifactShareTarget;
      readonly targetId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    if (args.target.kind !== "file") {
      return null;
    }
    const file = await set(privateArtifactRecord$, args.target.id, signal);
    signal.throwIfAborted();
    if (!file || !file.isReady) {
      return null;
    }
    const artifact = await set(findActiveArtifactForFile$, file, signal);
    if (!artifact || artifact.visibility === "private") {
      return null;
    }
    if (
      artifact.visibility === "organization" &&
      !(await set(currentShareMember$, file.orgId, args.userId, signal))
    ) {
      return null;
    }
    const preview = await set(
      resolveArtifactPreviewUrl$,
      { bucket: file.bucket, key: file.key, signingDate: nowDate() },
      signal,
    );
    const downloadUrl = await set(resolveArtifactDownloadUrl$, file, signal);
    signal.throwIfAborted();
    const previewImageUrl = artifact.thumbnail?.url ?? null;
    return {
      ...preview,
      downloadUrl,
      filename: file.filename,
      contentType: file.contentType,
      ...(previewImageUrl ? { previewImageUrl } : {}),
      target: { kind: "file" as const, id: file.id },
    };
  },
);

const signLegacySharePolicyDownload$ = command(
  async (
    { set },
    args: {
      readonly policy: ArtifactSharePolicy;
      readonly candidate: ShareCandidate;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<ArtifactDownloadResponse | null> => {
    const { policy, candidate, userId } = args;
    if (policy.target.kind === "file") {
      const file = await set(privateArtifactRecord$, policy.target.id, signal);
      signal.throwIfAborted();
      if (!file) {
        return null;
      }
      const artifact = await set(findActiveArtifactForFile$, file, signal);
      if (
        policy.ownerId !== userId &&
        (!artifact || artifact.visibility === "private")
      ) {
        return null;
      }
      const url = await set(
        resolveArtifactDownloadUrl$,
        {
          bucket: file.bucket,
          key: policy.target.key,
          filename: policy.target.filename,
        },
        signal,
      );
      signal.throwIfAborted();
      return {
        kind: "file",
        url,
        filename: policy.target.filename,
        contentType: policy.target.contentType,
      };
    }
    const target = policy.target;
    if (
      !(
        await set(
          checkHostedSiteAccess$,
          { siteId: target.siteId, userId },
          signal,
        )
      ).allowed
    ) {
      return null;
    }
    const site = await set(
      signHostedSiteFiles$,
      {
        metadata: {
          siteId: target.siteId,
          deploymentId: target.id,
          deploymentVersion: target.deploymentVersion,
          publicSlug: target.manifest.publicSlug,
          url: candidate.ownerUrl,
          artifactUrl: candidate.ownerUrl,
          ...(policy.audience === "public"
            ? { aliasUrl: publicShareUrl(policy) }
            : {}),
        },
        manifest: target.manifest,
        viewerId: userId,
        prefix: `shared-artifacts/${policy.publicBrand}/${target.snapshotId}/${target.id}`,
      },
      signal,
    );
    return { kind: "html", site };
  },
);

/** Download grants follow live `artifacts.visibility` for files and read-only R2 probes for legacy share IDs. */
export const resolveArtifactShareDownload$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly selector:
        | { readonly kind: "share"; readonly id: string }
        | {
            readonly kind: "target";
            readonly target: ArtifactShareTarget;
            readonly targetId: string;
          };
      readonly allowPrivateOwner?: boolean;
      readonly publicToken?: string;
      readonly layout?: LinkLayout;
      readonly expectedKind?: "html";
    },
    signal: AbortSignal,
  ): Promise<ArtifactDownloadResponse | null> => {
    if (args.selector.kind === "target") {
      if (
        args.expectedKind === "html" ||
        args.selector.target.kind !== "file"
      ) {
        return null;
      }
      const shared = await set(
        resolveArtifactTargetShare$,
        {
          target: args.selector.target,
          targetId: args.selector.targetId,
          userId: args.userId,
        },
        signal,
      );
      return shared
        ? {
            kind: "file",
            url: shared.downloadUrl,
            filename: shared.filename,
            contentType: shared.contentType,
          }
        : null;
    }

    const policy = await set(
      authorizedLegacySharePolicy$,
      {
        id: args.selector.id,
        userId: args.userId,
        allowPublic: true,
        allowPrivateOwner: args.allowPrivateOwner,
        publicToken: args.publicToken,
        layout: args.layout,
      },
      signal,
    );
    if (
      !policy ||
      (args.expectedKind && policy.target.kind !== args.expectedKind)
    ) {
      return null;
    }
    const candidate = await set(
      ownedShareTarget$,
      { target: policy.target, userId: policy.ownerId, orgId: policy.orgId },
      signal,
    );
    signal.throwIfAborted();
    if (!candidate) {
      return null;
    }
    return await set(
      signLegacySharePolicyDownload$,
      { policy, candidate, userId: args.userId },
      signal,
    );
  },
);

/** A copied public alias must keep following its selected snapshot, even for its owner. */
export const resolveHostedSitePublicationDownload$ = command(
  async (
    { get, set },
    args: {
      readonly publicSlug: string;
      readonly layout: LinkLayout;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const legacy = /^sh-([a-f0-9]{32})-([a-f0-9]{24})$/u.exec(args.publicSlug);
    const hash = legacy?.[1];
    const publicToken = legacy?.[2];
    const record =
      hash && publicToken
        ? {
            kind: "publication" as const,
            targetKind: "html" as const,
            shareId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`,
            publicToken,
          }
        : await get(
            artifactDeliveryRecord(
              args.layout,
              "html",
              args.publicSlug,
              signal,
            ),
          );
    signal.throwIfAborted();
    if (!record) {
      return { kind: "missing" as const };
    }
    if (record.kind === "legacy-site") {
      return { kind: "legacy" as const };
    }
    if (record.kind === "thread-resource") {
      const site = await set(
        resolveSharedThreadHostedDownload$,
        { publicSlug: args.publicSlug, record, viewerId: args.userId },
        signal,
      );
      return site
        ? { kind: "shared" as const, site }
        : { kind: "unavailable" as const };
    }
    if (record.kind !== "publication" || record.targetKind !== "html") {
      return { kind: "unavailable" as const };
    }
    const download = await set(
      resolveArtifactShareDownload$,
      {
        selector: { kind: "share", id: record.shareId },
        userId: args.userId,
        layout: args.layout,
        publicToken: record.publicToken,
        expectedKind: "html",
      },
      signal,
    );
    return download?.kind === "html"
      ? { kind: "shared" as const, site: download.site }
      : { kind: "unavailable" as const };
  },
);

export interface PublicArtifactLookup {
  readonly id: string;
  readonly kind?: "file" | "html" | "share";
}

export type ResolvedPublicArtifactSource =
  | {
      readonly kind: "live-file";
      readonly file: PrivateArtifactRecord;
      readonly version: string;
      readonly preview: {
        readonly filename: string;
        readonly contentType: string;
        readonly previewImageUrl?: string;
      };
    }
  | {
      readonly kind: "legacy-policy";
      readonly policy: ArtifactSharePolicy;
      readonly candidate: ShareCandidate;
      readonly url: string;
      readonly preview: {
        readonly filename: string;
        readonly contentType: string;
      };
    };

const resolvePublicLegacyPolicySource$ = command(
  async (
    { set },
    shareId: string,
    signal: AbortSignal,
  ): Promise<Extract<
    ResolvedPublicArtifactSource,
    { kind: "legacy-policy" }
  > | null> => {
    const policy = await set(
      probeLegacyArtifactSharePolicy$,
      { shareId },
      signal,
    );
    if (!policy || policy.status !== "active" || policy.audience !== "public") {
      return null;
    }
    if (policy.target.kind === "html") {
      const allowed = await set(
        checkHostedSiteAccess$,
        { siteId: policy.target.siteId },
        signal,
      );
      if (!allowed.allowed) {
        return null;
      }
    } else {
      const file = await set(privateArtifactRecord$, policy.target.id, signal);
      if (!file?.isReady) {
        return null;
      }
      const artifact = await set(findActiveArtifactForFile$, file, signal);
      if (artifact?.visibility !== "public") {
        return null;
      }
    }
    const candidate = await set(
      ownedShareTarget$,
      { target: policy.target, userId: policy.ownerId, orgId: policy.orgId },
      signal,
    );
    signal.throwIfAborted();
    if (!candidate) {
      return null;
    }
    return {
      kind: "legacy-policy",
      policy,
      candidate,
      ...publicSharePreview(policy),
    };
  },
);

/**
 * Resolve public artifact metadata and authority:
 * 1) Live `files` + active `artifacts.visibility = 'public'`
 * 2) Historical `/share/artifacts/:shareId` R2 policy probe (0 DB `artifact_shares` reads)
 */
export const resolvePublicArtifactSource$ = command(
  async (
    { set },
    args: PublicArtifactLookup,
    signal: AbortSignal,
  ): Promise<ResolvedPublicArtifactSource | null> => {
    if (args.kind === undefined || args.kind === "file") {
      const file = await set(privateArtifactRecord$, args.id, signal);
      signal.throwIfAborted();
      if (file?.isReady) {
        const artifact = await set(findActiveArtifactForFile$, file, signal);
        if (artifact?.visibility === "public") {
          const previewImageUrl = artifact.thumbnail?.url ?? undefined;
          return {
            kind: "live-file",
            file,
            version: `${artifact.id}:${artifact.updatedAt.toISOString()}`,
            preview: {
              filename: file.filename,
              contentType: file.contentType,
              ...(previewImageUrl ? { previewImageUrl } : {}),
            },
          };
        }
        return null;
      }
      if (args.kind === "file") {
        return null;
      }
    }

    if (args.kind === "html") {
      return null;
    }

    return await set(resolvePublicLegacyPolicySource$, args.id, signal);
  },
);

export const resolvePublicArtifactUrl$ = command(
  async ({ set }, args: PublicArtifactLookup, signal: AbortSignal) => {
    const source = await set(resolvePublicArtifactSource$, args, signal);
    if (!source) {
      return null;
    }
    if (source.kind === "live-file") {
      const preview = await set(
        resolveArtifactPreviewUrl$,
        {
          bucket: source.file.bucket,
          key: source.file.key,
          signingDate: nowDate(),
        },
        signal,
      );
      const downloadUrl = await set(
        resolveArtifactDownloadUrl$,
        source.file,
        signal,
      );
      return {
        url: preview.url,
        expiresAt: preview.expiresAt,
        downloadUrl,
        preview: source.preview,
      };
    }
    const { policy, candidate } = source;
    if (policy.target.kind === "html") {
      const target = policy.target;
      const site = await set(
        signHostedSiteFiles$,
        {
          metadata: {
            siteId: target.siteId,
            deploymentId: target.id,
            deploymentVersion: target.deploymentVersion,
            publicSlug: target.manifest.publicSlug,
            url: candidate.ownerUrl,
            artifactUrl: candidate.ownerUrl,
            aliasUrl: publicShareUrl(policy),
          },
          manifest: target.manifest,
          prefix: `shared-artifacts/${policy.publicBrand}/${target.snapshotId}/${target.id}`,
          attachment: true,
        },
        signal,
      );
      const downloadUrl = site.files.find((file) => {
        return file.path === "/index.html";
      })?.downloadUrl;
      if (!downloadUrl) {
        return null;
      }
      return { url: source.url, preview: source.preview, downloadUrl };
    }
    if (candidate.target.kind !== "file") {
      throw new Error("Artifact share target does not match its publication");
    }
    const downloadUrl = await set(
      resolveArtifactDownloadUrl$,
      {
        bucket: candidate.target.bucket,
        key: policy.target.key,
        filename: policy.target.filename,
      },
      signal,
    );
    return { url: source.url, preview: source.preview, downloadUrl };
  },
);
