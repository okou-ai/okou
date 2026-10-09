import { createHash } from "node:crypto";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { command } from "ccstate";
import sharp from "sharp";
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
import { settle } from "../utils";
import {
  allocatePrivateArtifact$,
  completePrivateArtifact$,
  privateArtifactRecord$,
  privateArtifactUrl,
  privateArtifactsBucket,
} from "./private-artifact-storage.service";

function previewId(deploymentId: string, preview: HostedSitePreview): string {
  return uuidv5(
    `${deploymentId}:sandbox-preview:${preview.sha256}`,
    uuidv5.URL,
  );
}

function uploadKey(deploymentId: string, preview: HostedSitePreview): string {
  return `private-artifacts/${previewId(deploymentId, preview)}/upload`;
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

/** Decode bounded input and strip metadata before it becomes a reusable cover. */
async function normalizePreview(
  bytes: Buffer,
  preview: HostedSitePreview,
): Promise<Buffer> {
  if (
    bytes.length !== preview.size ||
    createHash("sha256").update(bytes).digest("hex") !== preview.sha256
  ) {
    throw new Error("Preview bytes do not match the prepared size and SHA-256");
  }
  const image = sharp(bytes, {
    limitInputPixels: 4096 * 4096,
    failOn: "warning",
  });
  const metadata = await image.metadata();
  if (
    `image/${metadata.format}` !== preview.contentType ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new Error(
      "Preview must be a single PNG or JPEG image matching its declared type",
    );
  }
  const normalized = await image.rotate().png().toBuffer();
  if (normalized.length > MAX_HOSTED_PREVIEW_BYTES) {
    throw new Error("Decoded preview exceeds the 5 MiB image limit");
  }
  return normalized;
}

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
    | { readonly status: "preview_unavailable" }
  > => {
    const features = await set(
      loadUserFeatureSwitchContext$,
      args.orgId,
      args.userId,
      signal,
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.ArtifactPreviews, features)) {
      return { status: "preview_unavailable" };
    }
    const id = previewId(args.deploymentId, args.preview);
    const existing = await set(privateArtifactRecord$, id, signal);
    signal.throwIfAborted();
    if (existing?.materializationStatus === "ready") {
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
        url: privateArtifactUrl(id, existing.filename, existing.metadata),
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
    // Storage/provider failures remain errors; malformed caller images are 400s.
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
    const decoded = await settle(
      normalizePreview(downloaded.value, args.preview),
      signal,
    );
    if (!decoded.ok) {
      return {
        status: "bad_request",
        message:
          "Invalid hosted preview: supply a complete PNG or JPEG, at most 5 MiB and 16 megapixels, matching the prepared checksum",
      };
    }
    const artifact = await set(
      allocatePrivateArtifact$,
      {
        id,
        userId: args.userId,
        orgId: args.orgId,
        filename: `preview-${args.preview.sha256}.png`,
        contentType: "image/png",
        size: decoded.value.length,
      },
      signal,
    );
    // Upload credentials only address the staging key, never this final object.
    await get(
      putImmutableS3Object(bucket, artifact.key, decoded.value, "image/png", {
        signal,
        metadata: artifact.metadata,
      }),
    );
    signal.throwIfAborted();
    await set(
      completePrivateArtifact$,
      { id, url: null, contentType: "image/png", size: decoded.value.length },
      signal,
    );
    await get(deleteS3Objects(bucket, [key], signal));
    signal.throwIfAborted();
    return { status: "ok", url: artifact.url };
  },
);
