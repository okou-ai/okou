import { command } from "ccstate";
import { integrationsTelegramUploadInitContract } from "@okouai/api-contracts/contracts/integrations";

import { sanitizeArtifactFilename } from "../../lib/file-url";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { generatePresignedPutUrl, s3MetadataHeaders } from "../external/s3";
import { allocateUploadedArtifact$ } from "../services/uploaded-artifact.service";
import type { RouteEntry } from "../route-entry";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const initInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);

  const bodyResult = await get(
    bodyResultOf(integrationsTelegramUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { filename, contentType, length } = bodyResult.data;
  const sanitized = sanitizeArtifactFilename(filename);
  const artifact = await set(
    allocateUploadedArtifact$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      contentType: contentType,
      size: length,
      filename,
      publicBrand: PUBLIC_BRAND,
    },
    signal,
  );
  const uploadHeaders = s3MetadataHeaders(artifact.metadata);
  const uploadUrl = await get(
    generatePresignedPutUrl(
      artifact.bucket,
      artifact.key,
      contentType,
      {
        usePublicEndpoint: true,
        metadata: artifact.metadata,
      },
      signal,
    ),
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      uploadId: artifact.id,
      uploadUrl,
      fileUrl: artifact.url,
      filename: sanitized,
      contentType,
      size: length,
      ...(uploadHeaders ? { uploadHeaders } : {}),
    },
  };
});

export const integrationsTelegramUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTelegramUploadInitContract.init,
    handler: authRoute({ requiredCapability: "telegram:write" }, initInner$),
  },
];
