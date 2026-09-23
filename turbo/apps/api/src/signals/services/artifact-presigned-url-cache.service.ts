import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";
import { PRIVATE_ARTIFACT_CACHE_CONTROL } from "@okouai/api-contracts/contracts/artifact-cache";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  generateArtifactPreviewUrl,
  generateHostedSitesPresignedGetUrl,
  s3ObjectHead,
} from "../external/s3";

const SCOPE = "artifact_read";
const CACHE_POLICY = "artifact-read-get-v1";
const REFRESH_AFTER_SECONDS = PRESIGNED_URL_TTL_SECONDS / 2;

export interface ArtifactPresignedGetRequest {
  readonly bucket: string;
  readonly key: string;
  /** Hosted-site files have a separate signing credential from user artifacts. */
  readonly signer: "user-artifact" | "hosted-sites";
  /** A download disposition changes the signed request. */
  readonly filename?: string;
  /** The caller already verified this exact object with HEAD in this request. */
  readonly objectVerified?: true;
}

export interface ArtifactPresignedGetResult {
  readonly url: string;
  readonly expiresAt: string;
}

interface ArtifactCacheRow {
  readonly url: string;
  readonly expiresAt: Date;
  readonly refreshAfter: Date;
}

function isFresh(row: ArtifactCacheRow, at: Date): boolean {
  return row.refreshAfter > at && row.expiresAt > at;
}

function cacheResult(row: ArtifactCacheRow): ArtifactPresignedGetResult {
  return { url: row.url, expiresAt: row.expiresAt.toISOString() };
}

function cacheKey(request: ArtifactPresignedGetRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CACHE_POLICY,
        request.signer,
        request.bucket,
        request.key,
        request.filename ?? null,
        request.signer === "user-artifact" &&
        request.bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")
          ? PRIVATE_ARTIFACT_CACHE_CONTROL
          : null,
        env("S3_PUBLIC_ENDPOINT") ??
          env("S3_ENDPOINT") ??
          `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
        env("S3_REGION") ?? "auto",
        env("S3_FORCE_PATH_STYLE") === "true",
        request.signer === "hosted-sites"
          ? env("R2_HOSTED_SITES_ACCESS_KEY_ID")
          : request.bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")
            ? env("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID")
            : request.bucket === env("R2_USER_ARTIFACTS_BUCKET_NAME")
              ? env("R2_USER_ARTIFACTS_ACCESS_KEY_ID")
              : env("R2_ACCESS_KEY_ID"),
        PRESIGNED_URL_TTL_SECONDS,
      ]),
    )
    .digest("hex");
}

/** Only the already-authorized caller may request a credential. Never cache grants. */
export const resolveArtifactPresignedGet$ = command(
  async (
    { get, set },
    request: ArtifactPresignedGetRequest,
    signal: AbortSignal,
  ): Promise<ArtifactPresignedGetResult | null> => {
    const db = set(writeDb$);
    const key = cacheKey(request);
    const find = async (executor: Pick<typeof db, "select">) => {
      const [row] = await executor
        .select({
          url: systemStoragePresignedUrlCache.presignedUrl,
          expiresAt: systemStoragePresignedUrlCache.expiresAt,
          refreshAfter: systemStoragePresignedUrlCache.refreshAfter,
        })
        .from(systemStoragePresignedUrlCache)
        .where(
          and(
            eq(systemStoragePresignedUrlCache.cacheKey, key),
            eq(systemStoragePresignedUrlCache.scope, SCOPE),
          ),
        )
        .limit(1);
      return row;
    };
    const cached = await find(db);
    signal.throwIfAborted();
    if (cached && isFresh(cached, nowDate())) {
      return cacheResult(cached);
    }
    // Lock the *missing key* as well as expired rows. A second request rechecks
    // after the first commits, so concurrent cold loads share one HEAD and URL.
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`artifact-presign:${key}`}, 0))`,
      );
      signal.throwIfAborted();
      const current = await find(tx);
      signal.throwIfAborted();
      const issuedAt = nowDate();
      if (current && isFresh(current, issuedAt)) {
        return cacheResult(current);
      }
      const attempt = await settle(
        (async (): Promise<ArtifactPresignedGetResult | null> => {
          if (request.signer === "user-artifact") {
            if (!request.objectVerified) {
              const object = await get(
                s3ObjectHead(request.bucket, request.key),
              );
              signal.throwIfAborted();
              if (object.kind === "missing") {
                return null;
              }
            }
            return await get(
              generateArtifactPreviewUrl(request.bucket, request.key, {
                signingDate: issuedAt,
                filename: request.filename,
              }),
            );
          }
          const signingDate = new Date(
            Math.floor(issuedAt.getTime() / 1000) * 1000,
          );
          const url = await get(
            generateHostedSitesPresignedGetUrl(
              request.bucket,
              request.key,
              true,
              { signingDate, filename: request.filename },
            ),
          );
          return {
            url,
            expiresAt: new Date(
              signingDate.getTime() + PRESIGNED_URL_TTL_SECONDS * 1000,
            ).toISOString(),
          };
        })(),
        signal,
      );
      if (!attempt.ok) {
        // Only a transient HEAD/signing failure can use a still-valid old URL.
        // A confirmed missing object below must never use a cached credential.
        if (current && current.expiresAt > nowDate()) {
          return cacheResult(current);
        }
        throw attempt.error;
      }
      const signed = attempt.value;
      if (!signed) {
        return null;
      }
      const expiresAt = new Date(signed.expiresAt);
      const refreshAfter = new Date(
        expiresAt.getTime() - REFRESH_AFTER_SECONDS * 1000,
      );
      await tx
        .insert(systemStoragePresignedUrlCache)
        .values({
          cacheKey: key,
          scope: SCOPE,
          bucket: request.bucket,
          objectKey: request.key,
          // This column is the scope-local immutable signing identity.
          storageVersionId: key,
          resolvedOrgId: null,
          publicEndpoint: true,
          ttlSeconds: PRESIGNED_URL_TTL_SECONDS,
          presignedUrl: signed.url,
          expiresAt,
          refreshAfter,
          lastRequestedAt: issuedAt,
          updatedAt: issuedAt,
        })
        .onConflictDoUpdate({
          target: systemStoragePresignedUrlCache.cacheKey,
          set: {
            presignedUrl: signed.url,
            expiresAt,
            refreshAfter,
            lastRequestedAt: issuedAt,
            updatedAt: issuedAt,
          },
        });
      signal.throwIfAborted();
      return signed;
    });
  },
);
