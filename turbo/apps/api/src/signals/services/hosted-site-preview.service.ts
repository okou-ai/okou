import { command } from "ccstate";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { hostedPreviewArtifactIds } from "./hosted-preview.service";
import { privateArtifactRecord$ } from "./private-artifact-storage.service";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import { db$ } from "../external/db";
import { createHostedSitePreviewGrant$ } from "./private-hosted-preview.service";
import { resolveSharedThreadHostedPreview$ } from "./shared-thread-artifacts.service";
import {
  checkHostedSiteAccess$,
  readHostedSitePolicy$,
} from "./hosted-site-access.service";

export const resolveHostedSitePreview$ = command(
  async (
    { get, set },
    args: {
      readonly publicSlug: string;
      readonly hostname: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const expected = new URL(hostedLinkOrigin("current", args.publicSlug));
    if (expected.hostname !== args.hostname.toLowerCase()) {
      return null;
    }
    const parsedDeployment = z
      .uuid()
      .safeParse(
        args.publicSlug.startsWith("dpl-") ? args.publicSlug.slice(4) : null,
      );
    const deploymentId = parsedDeployment.success
      ? parsedDeployment.data
      : undefined;
    const [row] = await get(db$)
      .select({ site: hostedSites, deployment: hostedDeployments })
      .from(hostedSites)
      .innerJoin(
        hostedDeployments,
        eq(hostedDeployments.siteId, hostedSites.id),
      )
      .where(
        and(
          eq(hostedSites.linkLayoutSegment, "okou"),
          isNull(hostedSites.deletedAt),
          eq(hostedDeployments.status, "ready"),
          deploymentId
            ? eq(hostedDeployments.id, deploymentId)
            : and(
                eq(hostedSites.publicSlug, args.publicSlug),
                eq(hostedDeployments.id, hostedSites.activeDeploymentId),
              ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      // Conversation snapshots have a delivery alias rather than a named Site
      // row. Authorize the selected snapshot, not the owner's latest version.
      return set(
        resolveSharedThreadHostedPreview$,
        { publicSlug: args.publicSlug, viewerId: args.userId },
        signal,
      );
    }
    if (row.deployment.manifest.access !== undefined) {
      return null;
    }
    const policy = await set(readHostedSitePolicy$, row.site.id, signal);
    if (!policy) {
      return null;
    }
    if (policy.visibility !== "public") {
      const access = await set(
        checkHostedSiteAccess$,
        { siteId: row.site.id, userId: args.userId },
        signal,
      );
      if (!access.allowed) {
        return null;
      }
    }
    const preview = row.deployment.manifest.preview;
    let image: { readonly url: string } | null = null;
    if (preview) {
      for (const id of hostedPreviewArtifactIds(row.deployment.id, preview)) {
        const cover = await set(privateArtifactRecord$, id, signal);
        if (!cover || cover.materializationStatus !== "ready") {
          continue;
        }
        if (
          cover.userId !== row.deployment.userId ||
          cover.orgId !== row.deployment.orgId
        ) {
          throw new Error("Website cover belongs to another publication owner");
        }
        image = await set(
          resolveArtifactPreviewUrl$,
          {
            bucket: cover.bucket,
            key: cover.key,
            signingDate: nowDate(),
          },
          signal,
        );
        break;
      }
    }
    const target =
      policy.visibility === "public"
        ? {
            url: expected.href,
            expiresAt: null,
          }
        : await set(
            createHostedSitePreviewGrant$,
            {
              siteId: row.site.id,
              deploymentId: row.deployment.id,
              prefix: row.deployment.r2Prefix,
              revision: policy.revision,
              ...(row.deployment.manifest.immutableContent === true
                ? { immutableContent: true as const }
                : {}),
            },
            signal,
          );
    return {
      ...target,
      ...(image ? { previewImageUrl: image.url } : {}),
    };
  },
);
