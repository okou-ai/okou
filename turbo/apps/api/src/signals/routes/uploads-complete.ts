import { command } from "ccstate";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { normalizeWebUploadContentType } from "../../lib/uploads-constants";
import { uploadedArtifactObject } from "../services/uploaded-artifact.service";
import { registerLegacyArtifactFile$ } from "../services/artifact-delivery.service";
import { completePrivateArtifact$ } from "../services/private-artifact-storage.service";
import { recordWebUploadedFile$ } from "../services/run-uploaded-files.service";
import { rejectSuspendedOrg$ } from "../services/org-suspension.service";
import type { RouteEntry } from "../route-entry";

const completeBody$ = bodyResultOf(uploadsContract.complete);

const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const body = await get(completeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return {
      status: 400 as const,
      body: {
        error: { message: "Invalid request body", code: "BAD_REQUEST" },
      },
    };
  }

  const { id, contentType: requestedContentType } = body.data;

  if (auth.orgId) {
    const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
    if (suspended) {
      return suspended;
    }
  }

  const s3Object = await get(
    uploadedArtifactObject({ userId: auth.userId, orgId: auth.orgId, id }),
  );
  signal.throwIfAborted();
  if (!s3Object) {
    return {
      status: 404 as const,
      body: {
        error: { message: "Uploaded file not found", code: "NOT_FOUND" },
      },
    };
  }

  const filename = s3Object.filename;
  const contentType =
    !s3Object.isPrivate && requestedContentType
      ? normalizeWebUploadContentType(requestedContentType)
      : s3Object.contentType;
  const size = s3Object.size;
  const url = s3Object.url;
  const lastModified = s3Object.lastModified?.toISOString();

  if (s3Object.isPrivate) {
    await set(completePrivateArtifact$, { id, url, contentType, size }, signal);
  } else {
    await set(
      registerLegacyArtifactFile$,
      {
        key: s3Object.key,
        filename,
        contentType,
        layout: s3Object.layout,
      },
      signal,
    );
  }
  const runId = "runId" in auth ? auth.runId : undefined;

  await set(
    recordWebUploadedFile$,
    {
      runId,
      externalId: id,
      userId: auth.userId,
      orgId: "orgId" in auth ? auth.orgId : null,
      filename,
      contentType,
      sizeBytes: size,
      url,
      s3Key: s3Object.key,
      layout: s3Object.layout,
      metadata: lastModified ? { lastModified } : {},
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { id, filename, contentType, size, url },
  };
});

export const uploadsCompleteRoutes: readonly RouteEntry[] = [
  {
    route: uploadsContract.complete,
    handler: authRoute({ requiredCapability: "file:write" }, completeInner$),
  },
];
