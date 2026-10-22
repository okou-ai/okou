import { createHash, randomBytes } from "node:crypto";
import { command } from "ccstate";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import { hostedSitePreviewGrantSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { hostedPreviewArtifactId } from "./hosted-preview.service";
import { privateArtifactRecord$ } from "./private-artifact-storage.service";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import { PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS } from "../../lib/private-artifact-preview";
import { PRIVATE_ARTIFACT_PREVIEW_MIN_REMAINING_MS } from "@okouai/api-contracts/contracts/presigned-urls";
import { db$, writeDb$ } from "../external/db";
import { putHostedSitesS3Object } from "../external/s3";
import {
  checkHostedSiteAccess$,
  readHostedSitePolicy$,
} from "./hosted-site-access.service";

/** Call after checking both the underlying resource and the current Site policy. */
export const createHostedSitePreviewGrant$ = command(
  async (
    { get, set },
    args: {
      readonly siteId: string;
      readonly deploymentId: string;
      readonly prefix: string;
      readonly revision: string | null;
      readonly immutableContent?: true;
    },
    signal: AbortSignal,
  ) => {
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      throw new Error("Hosted preview storage is not configured");
    }
    const origin = hostedLinkOrigin("current", "site");
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify([
          "hosted-site-preview-v2",
          bucket,
          origin,
          args.siteId,
          args.deploymentId,
          args.prefix,
          args.revision,
          args.immutableContent ?? false,
          PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS,
        ]),
      )
      .digest("hex");
    const [cached] = await get(db$)
      .select({
        url: systemStoragePresignedUrlCache.presignedUrl,
        expiresAt: systemStoragePresignedUrlCache.expiresAt,
      })
      .from(systemStoragePresignedUrlCache)
      .where(eq(systemStoragePresignedUrlCache.cacheKey, cacheKey))
      .limit(1);
    signal.throwIfAborted();
    const issuedAt = nowDate();
    if (
      cached &&
      cached.expiresAt.getTime() - issuedAt.getTime() >
        PRIVATE_ARTIFACT_PREVIEW_MIN_REMAINING_MS
    ) {
      return { url: cached.url, expiresAt: cached.expiresAt.toISOString() };
    }
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(
      issuedAt.getTime() + PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS * 1000,
    );
    const grant = hostedSitePreviewGrantSchema.parse({
      version: 2,
      publicBrand: "okou",
      siteId: args.siteId,
      deploymentId: args.deploymentId,
      prefix: args.prefix,
      expiresAt: expiresAt.toISOString(),
      ...(args.immutableContent ? { immutableContent: true } : {}),
    });
    await get(
      putHostedSitesS3Object(
        bucket,
        `private-previews/okou/${token}.json`,
        JSON.stringify(grant),
        "application/json",
        signal,
      ),
    );
    signal.throwIfAborted();
    const url = `${hostedLinkOrigin("current", `pv-${token}`)}/`;
    const values = {
      cacheKey,
      scope: "hosted_site_preview",
      bucket,
      objectKey: args.prefix,
      storageVersionId: createHash("sha256")
        .update(JSON.stringify(args))
        .digest("hex"),
      resolvedOrgId: null,
      publicEndpoint: true,
      ttlSeconds: PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS,
      presignedUrl: url,
      expiresAt,
      refreshAfter: expiresAt,
      lastRequestedAt: issuedAt,
      updatedAt: issuedAt,
    };
    await set(writeDb$)
      .insert(systemStoragePresignedUrlCache)
      .values(values)
      .onConflictDoUpdate({
        target: systemStoragePresignedUrlCache.cacheKey,
        set: values,
      });
    signal.throwIfAborted();
    return { url, expiresAt: expiresAt.toISOString() };
  },
);

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
    if (!row || row.deployment.manifest.access !== undefined) {
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
    const cover = preview
      ? await set(
          privateArtifactRecord$,
          hostedPreviewArtifactId(row.deployment.id, preview),
          signal,
        )
      : null;
    if (
      cover &&
      (cover.userId !== row.deployment.userId ||
        cover.orgId !== row.deployment.orgId)
    ) {
      throw new Error("Website cover belongs to another publication owner");
    }
    const image =
      cover?.materializationStatus === "ready"
        ? await set(
            resolveArtifactPreviewUrl$,
            {
              bucket: cover.bucket,
              key: cover.key,
              signingDate: nowDate(),
            },
            signal,
          )
        : null;
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
