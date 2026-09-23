import { command } from "ccstate";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { resolveArtifactPresignedGet$ } from "../services/artifact-presigned-url-cache.service";
import { privateArtifactRecord } from "../services/private-artifact-storage.service";
import {
  uploadedArtifactObject,
  uploadedArtifactPreviewImageUrl,
} from "../services/uploaded-artifact.service";
import type { RouteEntry } from "../route-entry";

const fileUrlInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(queryOf(webFilesContract.fileUrl));

  const [privateFile, previewImageUrl] = await Promise.all([
    get(privateArtifactRecord(params.file_id)),
    get(
      uploadedArtifactPreviewImageUrl({
        userId: auth.userId,
        orgId: auth.orgId,
        id: params.file_id,
      }),
    ),
  ]);
  signal.throwIfAborted();
  if (
    privateFile &&
    (privateFile.userId !== auth.userId || privateFile.orgId !== auth.orgId)
  ) {
    return notFound("File not found");
  }
  // Private bytes are verified on cache miss. Avoid an unconditional HEAD on
  // every preview read, while retaining public/legacy object resolution.
  const location =
    privateFile ??
    (await get(
      uploadedArtifactObject({
        userId: auth.userId,
        orgId: auth.orgId,
        id: params.file_id,
      }),
    ));
  signal.throwIfAborted();
  if (!location) {
    return notFound("File not found");
  }

  // Signed against the object key resolved for this user, so the URL never
  // widens beyond what the ownership check already allowed.
  const preview = await set(
    resolveArtifactPresignedGet$,
    {
      bucket: location.bucket,
      key: location.key,
      signer: "user-artifact",
      ...(privateFile ? {} : { objectVerified: true }),
    },
    signal,
  );
  if (!preview) {
    return notFound("File not found");
  }
  if (privateFile) {
    set(setResHeader$, "Cache-Control", "private, no-store");
  }
  return {
    status: 200 as const,
    body: {
      ...preview,
      publicUrl: privateFile ? null : location.url,
      previewImageUrl,
    },
  };
});

export const webFileUrlRoutes: readonly RouteEntry[] = [
  {
    route: webFilesContract.fileUrl,
    handler: authRoute(
      {
        requireOrganization: false,
        missingOrganizationStatus: 401,
        requiredCapability: "file:read",
      },
      fileUrlInner$,
    ),
  },
];
