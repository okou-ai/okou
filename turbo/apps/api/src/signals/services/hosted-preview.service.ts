import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { v5 as uuidv5 } from "uuid";
import {
  MAX_HOSTED_PREVIEW_BYTES,
  type HostedSitePreview,
} from "@okouai/api-contracts/contracts/host";

import {
  deleteS3Objects,
  downloadS3BufferWithMaxBytes,
  generatePresignedPutUrl,
  putImmutableS3Object,
  s3ObjectExists,
  S3ObjectSizeLimitError,
} from "../external/s3";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  allocatePrivateArtifact$,
  privateArtifactRecord$,
  privateArtifactUrl,
  privateArtifactsBucket,
} from "./private-artifact-storage.service";

/** Original-byte identity; never shares an allocation with normalized covers. */
export function hostedPreviewArtifactId(
  deploymentId: string,
  preview: HostedSitePreview,
): string {
  return uuidv5(
    `${deploymentId}:sandbox-preview:original-v1:${preview.sha256}`,
    uuidv5.URL,
  );
}

/** Shared original-upload staging identity and historical normalized cover ID. */
export function hostedPreviewLegacyArtifactId(
  deploymentId: string,
  preview: HostedSitePreview,
): string {
  return uuidv5(
    `${deploymentId}:sandbox-preview:${preview.sha256}`,
    uuidv5.URL,
  );
}

/**
 * Both immutable cover generations remain supported while their published
 * records/references are retained; API drain alone cannot retire normalized IDs.
 * Readers must check readiness and owner/org for each candidate they use.
 */
export function hostedPreviewArtifactIds(
  deploymentId: string,
  preview: HostedSitePreview,
): readonly string[] {
  return [
    hostedPreviewArtifactId(deploymentId, preview),
    hostedPreviewLegacyArtifactId(deploymentId, preview),
  ];
}

function uploadKey(deploymentId: string, preview: HostedSitePreview): string {
  // Both writer generations stage the same original bytes. Only final objects
  // need distinct identities, so prepare grants remain rollback-compatible.
  return `private-artifacts/${hostedPreviewLegacyArtifactId(deploymentId, preview)}/upload`;
}

export const prepareHostedPreview$ = command(
  async (
    { get },
    deploymentId: string,
    preview: HostedSitePreview,
    signal: AbortSignal,
  ) => {
    const uploadUrl = await get(
      generatePresignedPutUrl(
        privateArtifactsBucket(),
        uploadKey(deploymentId, preview),
        preview.contentType,
        {
          usePublicEndpoint: true,
          contentLength: preview.size,
          expiresInSeconds: 3600,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    return { uploadUrl, sha256: preview.sha256 };
  },
);

/** Covers are ready file records, not standalone catalog publications. */
const markHostedPreviewReady$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly userId: string;
      readonly orgId: string;
      readonly storageKey: string;
      readonly size: number;
      readonly contentType: HostedSitePreview["contentType"];
    },
    signal: AbortSignal,
  ) => {
    const [completed] = await set(writeDb$)
      .update(runUploadedFiles)
      .set({
        url: null,
        contentType: args.contentType,
        sizeBytes: args.size,
        materializationStatus: "ready",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(runUploadedFiles.id, args.id),
          eq(runUploadedFiles.userId, args.userId),
          eq(runUploadedFiles.orgId, args.orgId),
          eq(runUploadedFiles.storageKey, args.storageKey),
        ),
      )
      .returning({ id: runUploadedFiles.id });
    signal.throwIfAborted();
    if (!completed) {
      throw new Error("Hosted preview ownership record is unavailable");
    }
    return completed.id;
  },
);

export const completeHostedPreview$ = command(
  async (
    { get, set },
    args: {
      readonly deploymentId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly preview: HostedSitePreview;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "ok"; readonly url: string }
    | { readonly status: "bad_request"; readonly message: string }
  > => {
    const id = hostedPreviewArtifactId(args.deploymentId, args.preview);
    for (const candidateId of hostedPreviewArtifactIds(
      args.deploymentId,
      args.preview,
    )) {
      const existing = await set(privateArtifactRecord$, candidateId, signal);
      signal.throwIfAborted();
      if (existing?.materializationStatus !== "ready") {
        continue;
      }
      if (existing.userId !== args.userId || existing.orgId !== args.orgId) {
        throw new Error("Hosted preview belongs to another owner");
      }
      await get(
        deleteS3Objects(
          existing.bucket,
          [uploadKey(args.deploymentId, args.preview)],
          signal,
        ),
      );
      signal.throwIfAborted();
      return {
        status: "ok",
        url: privateArtifactUrl(
          candidateId,
          existing.filename,
          existing.metadata,
        ),
      };
    }

    const bucket = privateArtifactsBucket();
    const key = uploadKey(args.deploymentId, args.preview);
    if (!(await get(s3ObjectExists(bucket, key)))) {
      signal.throwIfAborted();
      return {
        status: "bad_request",
        message: "Hosted preview was not uploaded",
      };
    }
    // Storage/provider failures remain errors; upload integrity failures are 400s.
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          bucket,
          key,
          MAX_HOSTED_PREVIEW_BYTES,
          signal,
        ),
      ),
      signal,
    );
    if (!downloaded.ok) {
      if (downloaded.error instanceof S3ObjectSizeLimitError) {
        return {
          status: "bad_request",
          message: "Hosted preview exceeds the 5 MiB image limit",
        };
      }
      throw downloaded.error;
    }
    const bytes = downloaded.value;
    if (
      bytes.length !== args.preview.size ||
      createHash("sha256").update(bytes).digest("hex") !== args.preview.sha256
    ) {
      return {
        status: "bad_request",
        message:
          "Hosted preview bytes do not match the prepared size and SHA-256",
      };
    }
    const artifact = await set(
      allocatePrivateArtifact$,
      {
        id,
        userId: args.userId,
        orgId: args.orgId,
        filename: `preview-${args.preview.sha256}.${args.preview.contentType === "image/png" ? "png" : "jpg"}`,
        contentType: args.preview.contentType,
        size: bytes.length,
      },
      signal,
    );
    // Upload credentials only address the staging key, never this final object.
    await get(
      putImmutableS3Object(
        bucket,
        artifact.key,
        bytes,
        args.preview.contentType,
        {
          signal,
          metadata: artifact.metadata,
        },
      ),
    );
    signal.throwIfAborted();
    await set(
      markHostedPreviewReady$,
      {
        id,
        userId: args.userId,
        orgId: args.orgId,
        storageKey: artifact.key,
        size: bytes.length,
        contentType: args.preview.contentType,
      },
      signal,
    );
    await get(deleteS3Objects(bucket, [key], signal));
    signal.throwIfAborted();
    return { status: "ok", url: artifact.url };
  },
);
