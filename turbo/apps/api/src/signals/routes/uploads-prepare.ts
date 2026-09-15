import { command } from "ccstate";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";

import { badRequestMessage } from "../../lib/error";
import {
  MAX_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_SIZE_LABEL,
  normalizeWebUploadContentType,
} from "../../lib/uploads-constants";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  abortMultipartS3Upload,
  createMultipartS3Upload,
  generatePresignedPutUrl,
  generatePresignedUploadPartUrl,
  s3MetadataHeaders,
} from "../external/s3";
import { allocateUploadedArtifact$ } from "../services/uploaded-artifact.service";
import { rejectSuspendedOrg$ } from "../services/org-suspension.service";
import type { RouteEntry } from "../route-entry";
import { onRejection, tapError } from "../utils";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;

const prepareUploadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);

    const bodyResult = await get(bodyResultOf(uploadsContract.prepare));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { filename, size } = bodyResult.data;
    const contentType = normalizeWebUploadContentType(
      bodyResult.data.contentType,
    );

    if (size > MAX_UPLOAD_SIZE_BYTES) {
      return badRequestMessage(`File too large (max ${MAX_UPLOAD_SIZE_LABEL})`);
    }
    if (auth.orgId) {
      const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
      if (suspended) {
        return suspended;
      }
    }

    const artifact = await set(
      allocateUploadedArtifact$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        filename,
        contentType,
        size,
        publicBrand: PUBLIC_BRAND,
        purpose: bodyResult.data.purpose,
      },
      signal,
    );
    const bucket = artifact.bucket;
    const { id, key: s3Key, url, metadata } = artifact;
    const uploadHeaders = s3MetadataHeaders(metadata);

    if (
      bodyResult.data.multipart === true &&
      size >= MULTIPART_PART_SIZE_BYTES
    ) {
      let uploadId: string | undefined;
      return await onRejection(
        (async () => {
          uploadId = await get(
            createMultipartS3Upload(
              bucket,
              s3Key,
              contentType,
              metadata,
              signal,
            ),
          );
          signal.throwIfAborted();
          const partCount = Math.ceil(size / MULTIPART_PART_SIZE_BYTES);
          const signedParts: {
            partNumber: number;
            uploadUrl: string;
          }[] = [];
          for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
            const uploadUrl = await get(
              generatePresignedUploadPartUrl(
                bucket,
                s3Key,
                uploadId,
                partNumber,
              ),
            );
            signal.throwIfAborted();
            signedParts.push({ partNumber, uploadUrl });
          }
          return {
            status: 200 as const,
            body: {
              id,
              filename,
              contentType,
              size,
              url,
              multipart: {
                uploadId,
                partSize: MULTIPART_PART_SIZE_BYTES,
                parts: signedParts,
              },
            },
          };
        })(),
        async () => {
          if (uploadId !== undefined) {
            await tapError(
              get(abortMultipartS3Upload(bucket, s3Key, uploadId)),
            );
          }
        },
      );
    }

    const uploadUrl = await get(
      generatePresignedPutUrl(
        bucket,
        s3Key,
        contentType,
        { usePublicEndpoint: true, metadata },
        signal,
      ),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        id,
        filename,
        contentType,
        size,
        uploadUrl,
        url,
        ...(uploadHeaders ? { uploadHeaders } : {}),
      },
    };
  },
);

export const uploadsPrepareRoutes: readonly RouteEntry[] = [
  {
    route: uploadsContract.prepare,
    handler: authRoute(
      { requiredCapability: "file:write" },
      prepareUploadInner$,
    ),
  },
];
