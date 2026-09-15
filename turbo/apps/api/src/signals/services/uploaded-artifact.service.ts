import { command, computed } from "ccstate";

import { env } from "../../lib/env";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userFeatureSwitchContext } from "./feature-switches.service";
import {
  generateArtifactPreviewUrl,
  s3ObjectHead,
  tryListMultipartS3Parts,
} from "../external/s3";
import { nowDate } from "../../lib/time";
import {
  allocateArtifactObject$,
  resolvedArtifactObject,
  resolveArtifactMultipartUpload$,
} from "./artifact-storage.service";
import {
  allocatePrivateArtifact$,
  completePrivateArtifact$,
  privateArtifactRecord,
  privateArtifactUrl,
} from "./private-artifact-storage.service";

export const allocateUploadedArtifact$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string | undefined;
      readonly filename: string;
      readonly contentType: string;
      readonly size: number;
      readonly publicBrand: PublicBrand;
      readonly purpose?: "artifact";
      readonly id?: string;
      readonly variant?: string;
    },
    signal: AbortSignal,
  ) => {
    if (args.orgId) {
      const context = await get(
        userFeatureSwitchContext(args.orgId, args.userId),
      );
      signal.throwIfAborted();
      if (isFeatureEnabled(FeatureSwitchKey.PrivateArtifacts, context)) {
        return await set(
          allocatePrivateArtifact$,
          { ...args, orgId: args.orgId },
          signal,
        );
      }
    }
    const artifact = await set(allocateArtifactObject$, args, signal);
    return {
      ...artifact,
      bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
      storageMetadata: { publicBrand: args.publicBrand },
    };
  },
);

interface UploadedArtifactIdentity {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string | undefined;
  readonly filenameHint?: string;
  readonly variant?: string;
}

export function uploadedArtifactObject(args: UploadedArtifactIdentity) {
  return computed(async (get) => {
    const record = await get(privateArtifactRecord(args.id));
    if (record) {
      // This check never consults the rollout switch. Disabling creation must
      // not remove authorization or try the public bucket for a private ID.
      if (record.userId !== args.userId || record.orgId !== args.orgId) {
        return null;
      }
      const head = await get(s3ObjectHead(record.bucket, record.key));
      if (head.kind === "missing") {
        return null;
      }
      if (head.contentLength === undefined) {
        throw new Error(`Private artifact ${args.id} has no content length`);
      }
      return {
        key: record.key,
        bucket: record.bucket,
        url: privateArtifactUrl(record.id, record.filename),
        publicBrand: record.publicBrand,
        filename: record.filename,
        contentType: record.contentType,
        size: head.contentLength,
        lastModified: head.lastModified,
        isPrivate: true,
      };
    }
    // Historical public objects remain readable without rewriting their URLs.
    const object = await get(
      resolvedArtifactObject(
        args.userId,
        args.id,
        args.filenameHint,
        args.variant,
      ),
    );
    return object
      ? {
          ...object,
          bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
          isPrivate: false,
        }
      : null;
  });
}

/** Finalize verified bytes before an integration publishes or transfers them. */
export const materializeUploadedArtifact$ = command(
  async ({ get, set }, args: UploadedArtifactIdentity, signal: AbortSignal) => {
    const object = await get(uploadedArtifactObject(args));
    signal.throwIfAborted();
    if (object?.isPrivate) {
      await set(completePrivateArtifact$, { id: args.id, ...object }, signal);
    }
    return object;
  },
);

/** Provider fetch URLs expire; callers persist object.url instead. */
export function uploadedArtifactFetchUrl(object: {
  readonly isPrivate: boolean;
  readonly bucket: string;
  readonly key: string;
  readonly url: string;
}) {
  return computed(async (get) => {
    if (!object.isPrivate) {
      return object.url;
    }
    const signed = await get(
      generateArtifactPreviewUrl(object.bucket, object.key, {
        signingDate: nowDate(),
      }),
    );
    return signed.url;
  });
}

export const resolveUploadedMultipart$ = command(
  async (
    { get, set },
    args: UploadedArtifactIdentity & {
      readonly filename: string;
      readonly uploadId: string;
    },
    signal: AbortSignal,
  ) => {
    const record = await get(privateArtifactRecord(args.id));
    signal.throwIfAborted();
    if (record) {
      if (
        record.userId !== args.userId ||
        record.orgId !== args.orgId ||
        record.filename !== args.filename
      ) {
        return null;
      }
      const parts = await get(
        tryListMultipartS3Parts(record.bucket, record.key, args.uploadId),
      );
      signal.throwIfAborted();
      return parts === null
        ? null
        : { key: record.key, bucket: record.bucket, parts };
    }
    const upload = await set(resolveArtifactMultipartUpload$, args, signal);
    if (!upload) {
      // Keep the existing public route's error contract. Private misses above
      // return null so their routes can deny access without revealing ownership.
      throw new Error("R2 multipart upload was not found");
    }
    return { ...upload, bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME") };
  },
);
