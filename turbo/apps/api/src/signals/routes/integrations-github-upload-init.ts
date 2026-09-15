import { command } from "ccstate";
import { integrationsGithubUploadInitContract } from "@okouai/api-contracts/contracts/integrations";

import { sanitizeArtifactFilename } from "../../lib/file-url";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { generatePresignedPutUrl, s3MetadataHeaders } from "../external/s3";
import { allocateUploadedArtifact$ } from "../services/uploaded-artifact.service";
import type { RouteEntry } from "../route-entry";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const init$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsGithubUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const filename = sanitizeArtifactFilename(body.filename);
  const artifact = await set(
    allocateUploadedArtifact$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      contentType: body.contentType,
      size: body.length,
      filename: body.filename,
      publicBrand: PUBLIC_BRAND,
    },
    signal,
  );
  const uploadHeaders = s3MetadataHeaders(artifact.metadata);
  const uploadUrl = await get(
    generatePresignedPutUrl(
      artifact.bucket,
      artifact.key,
      body.contentType,
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
      filename,
      contentType: body.contentType,
      size: body.length,
      ...(uploadHeaders ? { uploadHeaders } : {}),
    },
  };
});

const githubWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "github:write",
} as const;

export const integrationsGithubUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubUploadInitContract.init,
    handler: authRoute(githubWriteAuth, init$),
  },
];
