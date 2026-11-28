import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import {
  ARTIFACT_OG_BRAND,
  artifactHtmlMetadata,
  GENERIC_ARTIFACT_DESCRIPTION,
} from "@okouai/core/artifact-og";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";
import type { ArtifactLinkPreview } from "../../lib/slack-artifact-preview";
import { env } from "../../lib/env";
import { db$ } from "../external/db";
import {
  downloadS3BufferWithMaxBytes$,
  signPresignedGetUrl$,
} from "../external/s3";
import type { ChannelSharingResource } from "./artifact-channel-resource.service";
import { privateArtifactRecord$ } from "./private-artifact-storage.service";
import { hostedPreviewArtifactIds } from "./hosted-preview.service";

export interface ArtifactChannelPreview extends ArtifactLinkPreview {
  readonly description: string;
  readonly image: {
    readonly bucket: string;
    readonly key: string;
    readonly contentType: string;
  } | null;
}

/** Called only after the integration confirms access for the intended viewers.
 * These object-scoped URLs expire; anonymous OG readers keep their public-only policy.
 */
const channelPreviewImage$ = command(
  async (
    { set },
    source: { readonly bucket: string; readonly key: string } | null,
    signal: AbortSignal,
  ) => {
    if (!source) {
      return ARTIFACT_OG_BRAND.imageUrl;
    }
    const url = await set(signPresignedGetUrl$, {
      ...source,
      publicEndpoint: true,
      expiresInSeconds: 15 * 60,
      responseCacheControl: "private, no-store",
    });
    signal.throwIfAborted();
    return url;
  },
);

const fileChannelPreview$ = command(
  async (
    { set },
    resource: ChannelSharingResource,
    signal: AbortSignal,
  ): Promise<ArtifactChannelPreview | null> => {
    const file = await set(privateArtifactRecord$, resource.id, signal);
    if (
      !file ||
      file.userId !== resource.userId ||
      file.orgId !== resource.orgId ||
      !file.isReady
    ) {
      return null;
    }
    const image = file.contentType.startsWith("image/")
      ? { bucket: file.bucket, key: file.key, contentType: file.contentType }
      : null;
    return {
      title: file.filename,
      image,
      description: GENERIC_ARTIFACT_DESCRIPTION,
      imageUrl: await set(channelPreviewImage$, image, signal),
    };
  },
);

const siteChannelPreview$ = command(
  async (
    { get, set },
    resource: ChannelSharingResource,
    signal: AbortSignal,
  ): Promise<ArtifactChannelPreview | null> => {
    const [row] = await get(db$)
      .select({ site: hostedSites, deployment: hostedDeployments })
      .from(hostedSites)
      .innerJoin(
        hostedDeployments,
        and(
          eq(hostedDeployments.id, hostedSites.activeDeploymentId),
          eq(hostedDeployments.siteId, hostedSites.id),
        ),
      )
      .where(
        and(
          eq(hostedSites.id, resource.id),
          eq(hostedSites.userId, resource.userId),
          eq(hostedSites.orgId, resource.orgId),
          eq(hostedSites.linkLayoutSegment, "okou"),
          eq(hostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      throw new Error("Hosted storage is not configured");
    }
    const deployment = row.deployment;
    const index = deployment.manifest.files["/index.html"];
    const html =
      index && index.size <= 4 * 1024 * 1024
        ? await set(
            downloadS3BufferWithMaxBytes$,
            {
              bucket,
              key: `${deployment.r2Prefix}/index.html`,
              maxBytes: 4 * 1024 * 1024,
            },
            signal,
          )
        : null;
    const metadata = html ? artifactHtmlMetadata(html.toString("utf8")) : null;
    let image: ArtifactChannelPreview["image"] = null;
    if (deployment.manifest.preview) {
      for (const id of hostedPreviewArtifactIds(
        deployment.id,
        deployment.manifest.preview,
      )) {
        const file = await set(privateArtifactRecord$, id, signal);
        if (!file || !file.isReady) {
          continue;
        }
        if (file.userId !== resource.userId || file.orgId !== resource.orgId) {
          throw new Error("Channel artifact preview owner mismatch");
        }
        image = {
          bucket: file.bucket,
          key: file.key,
          contentType: file.contentType,
        };
        break;
      }
    }
    return {
      title: metadata?.title || row.site.publicSlug,
      image,
      description: metadata?.description || GENERIC_ARTIFACT_DESCRIPTION,
      imageUrl: await set(channelPreviewImage$, image, signal),
    };
  },
);

/** Prepares a preview for an explicitly authorized conversation, not a public OG response. */
export const artifactChannelPreview$ = command(
  ({ set }, resource: ChannelSharingResource, signal: AbortSignal) => {
    return resource.kind === "file"
      ? set(fileChannelPreview$, resource, signal)
      : set(siteChannelPreview$, resource, signal);
  },
);
