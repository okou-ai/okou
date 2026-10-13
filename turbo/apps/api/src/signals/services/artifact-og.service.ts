import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import sharp from "sharp";
import {
  artifactHtmlMetadata,
  GENERIC_ARTIFACT_DESCRIPTION,
} from "@okouai/core/artifact-og";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ArtifactOgTarget } from "@okouai/api-contracts/contracts/artifact-og";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";
import { env } from "../../lib/env";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { db$ } from "../external/db";
import {
  downloadHostedSitesS3Buffer,
  downloadS3BufferWithMaxBytes,
  isS3NotFoundError,
  S3ObjectSizeLimitError,
} from "../external/s3";
import { settle } from "../utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  artifactReferenceRecord$,
  type SharedThreadArtifactReference,
} from "./artifact-reference.service";
import {
  publicArtifactShareIdentity$,
  resolvePublicArtifactSource$,
} from "./artifact-shares.service";
import { sharedThreadArtifactSnapshot$ } from "./shared-thread-artifact-reference.service";
import {
  privateArtifactRecord$,
  privateArtifactsBucket,
} from "./private-artifact-storage.service";
import { hostedPreviewArtifactId } from "./hosted-preview.service";
import { authorizeHostedSiteDelivery$ } from "./host.service";

interface ImageSource {
  readonly bucket: string;
  readonly key: string;
}
interface OgSource {
  readonly version: string;
  readonly title: string;
  readonly url: string;
  readonly html?: ImageSource;
  readonly image?: ImageSource;
}

const artifactPreviewsEnabled$ = command(
  async ({ set }, orgId: string, ownerId: string, signal: AbortSignal) => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      orgId,
      ownerId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.ArtifactPreviews, context);
  },
);

function hostedBucket(): string {
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    throw new Error("Hosted storage is not configured");
  }
  return bucket;
}

function imageSource(
  key: string,
  contentType: string,
): ImageSource | undefined {
  return ["image/png", "image/jpeg", "image/webp"].includes(contentType)
    ? { bucket: privateArtifactsBucket(), key }
    : undefined;
}

const hostedCover$ = command(
  async (
    { set },
    manifest: HostedSiteManifest,
    ownerId: string,
    orgId: string,
    signal: AbortSignal,
  ): Promise<ImageSource | undefined> => {
    if (!manifest.preview) {
      return undefined;
    }
    const file = await set(
      privateArtifactRecord$,
      hostedPreviewArtifactId(manifest.deploymentId, manifest.preview),
      signal,
    );
    if (!file || file.materializationStatus !== "ready") {
      return undefined;
    }
    if (file.userId !== ownerId || file.orgId !== orgId) {
      throw new Error("Hosted cover owner mismatch");
    }
    return { bucket: file.bucket, key: file.key };
  },
);

const hostedOgSource$ = command(
  async (
    { get, set },
    id: string,
    signal: AbortSignal,
  ): Promise<OgSource | null> => {
    const [row] = await get(db$)
      .select({ deployment: hostedDeployments })
      .from(hostedDeployments)
      .innerJoin(hostedSites, eq(hostedSites.id, hostedDeployments.siteId))
      .where(
        and(
          eq(hostedDeployments.id, id),
          eq(hostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const d = row.deployment;
    if (!(await set(artifactPreviewsEnabled$, d.orgId, d.userId, signal))) {
      return null;
    }
    const allowed = await set(
      authorizeHostedSiteDelivery$,
      {
        siteId: d.siteId,
        deploymentId: d.id,
        alias: `dpl-${d.id}`,
        publicSlug: d.manifest.publicSlug,
        publicBrand: d.linkLayoutSegment,
        prefix: d.r2Prefix,
        manifestKey: `${d.r2Prefix}/manifest.json`,
      },
      signal,
    );
    if (!allowed) {
      return null;
    }
    return {
      version: `${d.id}:${d.manifest.preview?.sha256 ?? "none"}`,
      title: d.manifest.site ?? d.manifest.publicSlug,
      url: d.url,
      html:
        d.manifest.files["/index.html"] &&
        d.manifest.files["/index.html"].size <= 4 * 1024 * 1024
          ? { bucket: hostedBucket(), key: `${d.r2Prefix}/index.html` }
          : undefined,
      image: await set(hostedCover$, d.manifest, d.userId, d.orgId, signal),
    };
  },
);

const snapshotOgSource$ = command(
  async (
    { get, set },
    record: SharedThreadArtifactReference,
    url: string,
    signal: AbortSignal,
  ): Promise<OgSource | null> => {
    const [owner] = await get(db$)
      .select({ userId: sharedThreads.userId, orgId: sharedThreads.orgId })
      .from(sharedThreads)
      .where(
        and(
          eq(sharedThreads.id, record.threadId),
          eq(sharedThreads.linkLayoutSegment, record.publicBrand),
          eq(sharedThreads.hasArtifactSnapshot, true),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!owner) {
      return null;
    }
    if (owner.orgId === null) {
      throw new Error("Shared artifact snapshot has no owner organization");
    }
    if (
      !(await set(artifactPreviewsEnabled$, owner.orgId, owner.userId, signal))
    ) {
      return null;
    }
    const snapshot = await set(sharedThreadArtifactSnapshot$, record, signal);
    if (!snapshot) {
      return null;
    }
    if (snapshot.ownerId !== owner.userId || snapshot.orgId !== owner.orgId) {
      throw new Error("Shared artifact snapshot does not match its owner");
    }
    const { target, previewTarget } = snapshot;
    return {
      version: createHash("sha256")
        .update(JSON.stringify([record, target, previewTarget]))
        .digest("hex"),
      title:
        target.kind === "file" ? target.filename : target.manifest.publicSlug,
      url,
      html:
        target.kind === "html" &&
        target.manifest.files["/index.html"] &&
        target.manifest.files["/index.html"].size <= 4 * 1024 * 1024
          ? {
              bucket: hostedBucket(),
              key: `shared-artifacts/${record.publicBrand}/${target.snapshotId}/${target.id}/index.html`,
            }
          : undefined,
      image:
        previewTarget?.kind === "file"
          ? imageSource(previewTarget.key, previewTarget.contentType)
          : target.kind === "file"
            ? imageSource(target.key, target.contentType)
            : undefined,
    };
  },
);

const referenceOgSource$ = command(
  async (
    { set },
    reference: string,
    signal: AbortSignal,
  ): Promise<OgSource | null> => {
    const parsed = parseArtifactReference(`/artifacts/${reference}`);
    if (!parsed) {
      return null;
    }
    const record =
      parsed.id === null
        ? await set(artifactReferenceRecord$, parsed.hash, signal)
        : null;
    const url = new URL(`/artifacts/${reference}`, env("APP_URL")).href;
    if (record?.version === 3) {
      return set(snapshotOgSource$, record, url, signal);
    }
    const target =
      parsed.id !== null
        ? { id: parsed.id }
        : record?.version === 1
          ? { id: record.shareId, kind: "share" as const }
          : record?.target;
    if (!target) {
      return null;
    }
    const owner = await set(publicArtifactShareIdentity$, target, signal);
    if (
      !owner ||
      !(await set(artifactPreviewsEnabled$, owner.orgId, owner.userId, signal))
    ) {
      return null;
    }
    const published = await set(
      resolvePublicArtifactSource$,
      target,
      owner,
      signal,
    );
    if (!published) {
      return null;
    }
    const { policy, candidate } = published;
    const shared = policy.target;
    return {
      version: policy.revision,
      title:
        shared.kind === "file" ? shared.filename : shared.manifest.publicSlug,
      url,
      html:
        shared.kind === "html" &&
        shared.manifest.files["/index.html"] &&
        shared.manifest.files["/index.html"].size <= 4 * 1024 * 1024
          ? {
              bucket: hostedBucket(),
              key: `shared-artifacts/${policy.publicBrand}/${shared.snapshotId}/${shared.id}/index.html`,
            }
          : undefined,
      image:
        shared.kind === "file"
          ? imageSource(shared.key, shared.contentType)
          : candidate.target.kind === "html"
            ? await set(
                hostedCover$,
                candidate.target.manifest,
                policy.ownerId,
                policy.orgId,
                signal,
              )
            : undefined,
    };
  },
);

/** Each resolver gates its owner's switch before loading OG policy or content. */
const authorizedOgSource$ = command(
  async ({ set }, target: ArtifactOgTarget, signal: AbortSignal) => {
    return target.kind === "host"
      ? await set(hostedOgSource$, target.id, signal)
      : target.kind === "reference"
        ? await set(referenceOgSource$, target.id, signal)
        : await set(
            snapshotOgSource$,
            {
              version: 3,
              threadId: target.id,
              target: { kind: "html", id: target.targetId },
              publicToken: target.token,
              publicBrand: target.publicBrand,
            },
            env("APP_URL"),
            signal,
          );
  },
);

export const artifactOgMetadata$ = command(
  async ({ get, set }, target: ArtifactOgTarget, signal: AbortSignal) => {
    const source = await set(authorizedOgSource$, target, signal);
    if (!source) {
      return { available: false as const };
    }
    const metadata = source.html
      ? artifactHtmlMetadata(
          (
            await get(
              downloadHostedSitesS3Buffer(
                source.html.bucket,
                source.html.key,
                { maxBytes: 4 * 1024 * 1024 },
                signal,
              ),
            )
          ).toString("utf8"),
        )
      : null;
    const origin = apiBackendUrl();
    if (!origin) {
      throw new Error("API origin is not configured");
    }
    const imageUrl = new URL("/api/artifact-og/image", origin);
    imageUrl.search = new URLSearchParams({
      ...target,
      version: source.version,
    }).toString();
    return {
      available: true as const,
      title: metadata?.title || source.title,
      description: metadata?.description || GENERIC_ARTIFACT_DESCRIPTION,
      url: source.url,
      imageUrl: imageUrl.href,
    };
  },
);

export const artifactOgImage$ = command(
  async (
    { get, set },
    target: ArtifactOgTarget,
    version: string,
    signal: AbortSignal,
  ): Promise<Buffer | null> => {
    const source = await set(authorizedOgSource$, target, signal);
    if (!source?.image || source.version !== version) {
      return null;
    }
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          source.image.bucket,
          source.image.key,
          5 * 1024 * 1024,
          signal,
        ),
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!downloaded.ok) {
      if (
        isS3NotFoundError(downloaded.error) ||
        downloaded.error instanceof S3ObjectSizeLimitError
      ) {
        return null;
      }
      throw downloaded.error;
    }
    const image = sharp(downloaded.value, {
      limitInputPixels: 4096 * 4096,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    signal.throwIfAborted();
    if (
      !metadata.format ||
      !["png", "jpeg", "webp"].includes(metadata.format) ||
      (metadata.pages ?? 1) !== 1
    ) {
      return null;
    }
    const normalized = await image.rotate().png().toBuffer();
    signal.throwIfAborted();
    return normalized.length <= 5 * 1024 * 1024 ? normalized : null;
  },
);
