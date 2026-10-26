import { readHostedSitePolicy$ } from "./hosted-site-access.service";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import { hostedSitePreviewGrantSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import { PRIVATE_ARTIFACT_PREVIEW_MIN_REMAINING_MS } from "@okouai/api-contracts/contracts/presigned-urls";
import { db$, writeDb$ } from "../external/db";
import { command } from "ccstate";
import {
  linkLayoutSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS } from "../../lib/private-artifact-preview";
import { putHostedSitesS3Object } from "../external/s3";

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

/**
 * Read grants for conversation snapshots published before hosted sites became
 * public. Callers authorize the snapshot before issuing its grant.
 */
export const createHostedPreviewGrant$ = command(
  async (
    { get, set },
    args: {
      readonly siteId: string;
      readonly deploymentId: string;
      // The previewed deployment's layout; grants live in its namespace.
      readonly layout: LinkLayout;
      readonly snapshotId?: string;
      readonly immutableContent?: true;
    },
    signal: AbortSignal,
  ) => {
    const policy = await set(readHostedSitePolicy$, args.siteId, signal);
    if (!policy) {
      throw new Error("Hosted preview Site is unavailable");
    }
    if (policy.visibility !== "public" && args.layout === "current") {
      return set(
        createHostedSitePreviewGrant$,
        {
          siteId: args.siteId,
          deploymentId: args.deploymentId,
          prefix: args.snapshotId
            ? `shared-artifacts/okou/${args.snapshotId}/${args.deploymentId}`
            : `private-sites/okou/${args.deploymentId}`,
          revision: policy.revision,
          ...(args.snapshotId || args.immutableContent
            ? { immutableContent: true as const }
            : {}),
        },
        signal,
      );
    }
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (
      !bucket ||
      !env("R2_HOSTED_SITES_ACCESS_KEY_ID") ||
      !env("R2_HOSTED_SITES_SECRET_ACCESS_KEY")
    ) {
      throw new Error("Private hosted preview storage is not configured");
    }
    const segment = linkLayoutSegment(args.layout);
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(
      nowDate().getTime() + PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS * 1000,
    ).toISOString();
    const url = new URL(
      `${hostedLinkOrigin(args.layout, `${args.snapshotId ? "ps" : "pv"}-${token}`)}/`,
    );
    await get(
      putHostedSitesS3Object(
        bucket,
        `${args.snapshotId ? "shared-previews" : "private-previews"}/${segment}/${token}.json`,
        JSON.stringify({
          version: 1,
          publicBrand: segment,
          deploymentId: args.deploymentId,
          ...(args.snapshotId ? { snapshotId: args.snapshotId } : {}),
          ...(args.immutableContent ? { immutableContent: true } : {}),
          expiresAt,
        }),
        "application/json",
      ),
    );
    signal.throwIfAborted();
    return { url: url.href, expiresAt };
  },
);
