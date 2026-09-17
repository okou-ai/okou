import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import type {
  HostedSiteManifest,
  HostedSiteSnapshotDependencies,
} from "@okouai/db/jsonb-contracts/hosted-site";
import { privateHostedDeployments } from "@okouai/db/schema/hosted-site";
import {
  artifactTextContentType,
  artifactTextReferences,
  MAX_ARTIFACT_TEXT_BYTES,
  MAX_ARTIFACT_TOTAL_TEXT_BYTES,
} from "../../lib/artifact-text-references";
import { mapConcurrent } from "../../lib/map-concurrent";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  S3ObjectSizeLimitError,
  readHostedSiteSnapshotSource,
} from "../external/s3";

/** Dependency URLs are private server metadata, never part of a delivery manifest. */
export function hostedSiteDeliveryManifest(
  manifest: HostedSiteManifest,
): HostedSiteManifest {
  const delivery = { ...manifest };
  delete delivery.snapshotDependencies;
  return delivery;
}

function sourceManifestHash(manifest: HostedSiteManifest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        deploymentId: manifest.deploymentId,
        files: manifest.files,
      }),
    )
    .digest("hex");
}

/**
 * Index final uploaded bytes at completion, or lazily for older deployments.
 * DB/API compatibility: remove share-time collection after a complete backfill
 * and after older writers leave serving/rollback targets; follow-up #34630.
 */
export const collectHostedSiteDependencies$ = command(
  async (
    { get, set },
    deployment: Pick<
      typeof privateHostedDeployments.$inferSelect,
      "id" | "manifest" | "manifestHash" | "r2Prefix"
    >,
    bucket: string,
    signal: AbortSignal,
  ): Promise<HostedSiteSnapshotDependencies> => {
    const hash = sourceManifestHash(deployment.manifest);
    const existing = deployment.manifest.snapshotDependencies;
    if (existing) {
      if (existing.version !== 1 || existing.sourceManifestHash !== hash) {
        throw new Error(
          "Hosted dependency index does not match its deployment manifest",
        );
      }
      return existing;
    }
    const entries = Object.entries(deployment.manifest.files).filter(
      ([, file]) => {
        return artifactTextContentType(file.contentType);
      },
    );
    const tooLarge =
      entries.some(([, file]) => {
        return file.size > MAX_ARTIFACT_TEXT_BYTES;
      }) ||
      entries.reduce((total, [, file]) => {
        return total + file.size;
      }, 0) > MAX_ARTIFACT_TOTAL_TEXT_BYTES;
    let actualBytes = 0;
    const scanned = tooLarge
      ? { ok: true as const, value: [] }
      : await settle(
          mapConcurrent(entries, 10, async ([path]) => {
            signal.throwIfAborted();
            const source = await get(
              readHostedSiteSnapshotSource(
                bucket,
                `${deployment.r2Prefix}${path}`,
                signal,
              ),
            );
            actualBytes += source.buffer.byteLength;
            if (actualBytes > MAX_ARTIFACT_TOTAL_TEXT_BYTES) {
              throw new S3ObjectSizeLimitError(
                deployment.id,
                actualBytes,
                MAX_ARTIFACT_TOTAL_TEXT_BYTES,
              );
            }
            return [
              path,
              {
                etag: source.etag,
                sha256: createHash("sha256")
                  .update(source.buffer)
                  .digest("hex"),
                size: source.buffer.byteLength,
                references: artifactTextReferences(
                  source.buffer.toString("utf8"),
                ),
              },
            ] as const;
          }),
          signal,
        );
    if (!scanned.ok && !(scanned.error instanceof S3ObjectSizeLimitError)) {
      throw scanned.error;
    }
    const index: HostedSiteSnapshotDependencies = {
      version: 1,
      sourceManifestHash: hash,
      status: tooLarge || !scanned.ok ? "too-large" : "complete",
      files: Object.fromEntries(scanned.ok ? scanned.value : []),
    };
    const manifest = { ...deployment.manifest, snapshotDependencies: index };
    signal.throwIfAborted();
    // Competing completion/share requests may collect the same revision. CAS
    // prevents an old collector from replacing metadata written by a newer one.
    await set(writeDb$)
      .update(privateHostedDeployments)
      .set({
        manifest,
        manifestHash: createHash("sha256")
          .update(JSON.stringify(manifest))
          .digest("hex"),
      })
      .where(
        and(
          eq(privateHostedDeployments.id, deployment.id),
          eq(privateHostedDeployments.manifestHash, deployment.manifestHash),
        ),
      );
    signal.throwIfAborted();
    return index;
  },
);
