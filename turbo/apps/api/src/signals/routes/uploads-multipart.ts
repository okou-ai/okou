import { command } from "ccstate";
import { registerLegacyArtifactFile$ } from "../services/artifact-delivery.service";
import { completePrivateArtifact$ } from "../services/private-artifact-storage.service";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";

import { badRequestMessage, notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  abortMultipartS3Upload,
  completeMultipartS3Upload,
} from "../external/s3";
import {
  resolveUploadedMultipart$,
  uploadedArtifactObject,
} from "../services/uploaded-artifact.service";
import { rejectSuspendedOrg$ } from "../services/org-suspension.service";
import type { RouteEntry } from "../route-entry";

const completeMultipartInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const bodyResult = await get(
      bodyResultOf(uploadsContract.completeMultipart),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    if (auth.orgId) {
      const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
      if (suspended) {
        return suspended;
      }
    }

    const { id, filename, uploadId, partCount } = bodyResult.data;
    const upload = await set(
      resolveUploadedMultipart$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        id,
        filename,
        uploadId,
      },
      signal,
    );
    if (!upload) {
      return notFound("Multipart upload not found");
    }
    const { key, parts, bucket } = upload;
    const completePartSet =
      parts.length === partCount &&
      parts.every((part, index) => {
        return part.partNumber === index + 1;
      });
    if (!completePartSet) {
      return badRequestMessage("Multipart upload is incomplete");
    }

    await get(completeMultipartS3Upload(bucket, key, uploadId, parts));
    signal.throwIfAborted();

    const completed = await get(
      uploadedArtifactObject({ userId: auth.userId, orgId: auth.orgId, id }),
    );
    signal.throwIfAborted();
    if (!completed) {
      throw new Error("Completed R2 multipart upload was not found");
    }

    if (completed.isPrivate) {
      await set(
        completePrivateArtifact$,
        {
          id,
          url: completed.url,
          contentType: completed.contentType,
          size: completed.size,
        },
        signal,
      );
    } else {
      await set(
        registerLegacyArtifactFile$,
        {
          key: completed.key,
          filename: completed.filename,
          contentType: completed.contentType,
          publicBrand: completed.publicBrand,
        },
        signal,
      );
    }
    return {
      status: 200 as const,
      body: {
        id,
        url: completed.url,
      },
    };
  },
);

const abortMultipartInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const bodyResult = await get(bodyResultOf(uploadsContract.abortMultipart));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { id, filename, uploadId } = bodyResult.data;
    const upload = await set(
      resolveUploadedMultipart$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        id,
        filename,
        uploadId,
      },
      signal,
    );
    if (!upload) {
      return notFound("Multipart upload not found");
    }
    await get(abortMultipartS3Upload(upload.bucket, upload.key, uploadId));
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { id },
    };
  },
);

export const uploadsMultipartRoutes: readonly RouteEntry[] = [
  {
    route: uploadsContract.completeMultipart,
    handler: authRoute(
      { requiredCapability: "file:write" },
      completeMultipartInner$,
    ),
  },
  {
    route: uploadsContract.abortMultipart,
    handler: authRoute(
      { requiredCapability: "file:write" },
      abortMultipartInner$,
    ),
  },
];
