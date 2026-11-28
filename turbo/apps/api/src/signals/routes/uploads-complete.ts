import { command } from "ccstate";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";

import { badRequestMessage } from "../../lib/error";
import { MAX_TOTAL_AUDIO_BYTES } from "@okouai/api-contracts/contracts/voice-clips";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { normalizeWebUploadContentType } from "../../lib/uploads-constants";
import { files } from "@okouai/db/schema/file";
import { writeDb$ } from "../external/db";
import { uploadedArtifactObject$ } from "../services/uploaded-artifact.service";
import { registerLegacyArtifactFile$ } from "../services/artifact-delivery.service";
import { completePrivateArtifact$ } from "../services/private-artifact-storage.service";
import { upsertFileArtifact$ } from "../services/artifact-catalog.service";
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

  const s3Object = await set(
    uploadedArtifactObject$,
    { userId: auth.userId, orgId: auth.orgId, id },
    signal,
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

  if (
    auth.tokenType === "oauth" &&
    (!s3Object.isPrivate ||
      s3Object.contentType !== "audio/wav" ||
      s3Object.size <= 44 ||
      s3Object.size > MAX_TOTAL_AUDIO_BYTES)
  ) {
    return badRequestMessage("Expected a private WAV recording up to 25 MiB");
  }

  const filename = s3Object.filename;
  const contentType =
    !s3Object.isPrivate && requestedContentType
      ? normalizeWebUploadContentType(requestedContentType)
      : s3Object.contentType;
  const size = s3Object.size;
  const url = s3Object.url;
  const runId = "runId" in auth ? auth.runId : undefined;

  if (s3Object.isPrivate) {
    await set(
      completePrivateArtifact$,
      { id, url, contentType, size, runId },
      signal,
    );
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
    if (auth.orgId) {
      await set(writeDb$)
        .insert(files)
        .values({
          id,
          orgId: auth.orgId,
          ownerUserId: auth.userId,
          storageKey: s3Object.key,
          filename,
          contentType,
          sizeBytes: size,
          origin: runId ? "agent" : "user",
        })
        .onConflictDoUpdate({
          target: files.id,
          set: {
            contentType,
            sizeBytes: size,
          },
        });
      signal.throwIfAborted();
      if (runId) {
        await set(
          upsertFileArtifact$,
          {
            fileId: id,
            orgId: auth.orgId,
            userId: auth.userId,
            filename,
            contentType,
            sourceUrl: url,
            runId,
          },
          signal,
        );
      }
    }
  }
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { id, filename, contentType, size, url },
  };
});

export const uploadsCompleteRoutes: readonly RouteEntry[] = [
  {
    route: uploadsContract.complete,
    handler: authRoute(
      { requiredCapability: "file:write", oauthScope: "okou:chat:send" },
      completeInner$,
    ),
  },
];
