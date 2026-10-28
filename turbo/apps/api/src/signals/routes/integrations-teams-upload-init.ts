import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { command } from "ccstate";
import {
  integrationsTeamsUploadInitContract,
  type TeamsUploadInitBody,
} from "@okouai/api-contracts/contracts/integrations";

import { sanitizeArtifactFilename } from "../../lib/file-url";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { generatePresignedPutUrl, s3MetadataHeaders } from "../external/s3";
import { allocateUploadedArtifact$ } from "../services/uploaded-artifact.service";
import type { RouteEntry } from "../route-entry";

import { resolveTeamsWriteTarget$ } from "../services/teams-write-access.service";
import {
  prepareCanonicalPublishedAsset$,
  CanonicalPublicationConflictError,
} from "../services/canonical-asset.service";
import { settle } from "../utils";
import { conflict, notFound, badRequestMessage } from "../../lib/error";
import { isAllowedUploadType } from "../../lib/uploads-constants";

const prepareCanonicalTeamsUpload$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string;
      readonly body: TeamsUploadInitBody & {
        readonly canonical: NonNullable<TeamsUploadInitBody["canonical"]>;
      };
    },
    signal: AbortSignal,
  ) => {
    const { body, orgId, userId, runId } = args;
    const contentType =
      body.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (body.length > 100 * 1024 * 1024 || !isAllowedUploadType(contentType)) {
      return badRequestMessage(
        "Unsupported Teams upload type or file exceeds 100 MB",
      );
    }
    const target = await set(
      resolveTeamsWriteTarget$,
      {
        runId,
        userId: userId,
        orgId: orgId,
        body: body.canonical,
      },
      signal,
    );
    if ("status" in target) {
      return target;
    }
    const result = await settle(
      set(
        prepareCanonicalPublishedAsset$,
        {
          provider: "teams",
          runId,
          userId: userId,
          orgId: orgId,
          operationId: body.canonical.operationId,
          checksumSha256: body.canonical.checksumSha256,
          filename: body.filename,
          contentType,
          size: body.length,
          destination: {
            provider: "teams",
            tenantId: target.installation.teamsTenantId,
            conversationId: target.conversationId,
            source: target.source,
            ...(body.canonical.activityId
              ? { activityId: body.canonical.activityId }
              : {}),
            ...(body.canonical.text ? { text: body.canonical.text } : {}),
          },
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      if (result.error instanceof CanonicalPublicationConflictError) {
        return conflict(result.error.message);
      }
      throw result.error;
    }
    const prepared = result.value;
    if (!prepared) {
      return notFound("Agent run not found");
    }
    return {
      status: 200 as const,
      body: {
        uploadId: prepared.assetId,
        operationId: prepared.operationId,
        uploadUrl: prepared.uploadUrl ?? "",
        uploadRequired: Boolean(prepared.uploadUrl),
        fileUrl: prepared.url,
        filename: body.filename,
        contentType,
        size: body.length,
        ...(prepared.uploadHeaders
          ? { uploadHeaders: prepared.uploadHeaders }
          : {}),
      },
    };
  },
);

const init$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsTeamsUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const runId = "runId" in auth ? auth.runId : undefined;
  const identityEnabled =
    auth.orgId && body.canonical && runId
      ? isFeatureEnabled(
          FeatureSwitchKey.TeamsWorkspaceIdentity,
          await set(
            loadUserFeatureSwitchContext$,
            auth.orgId,
            auth.userId,
            signal,
          ),
        )
      : false;
  if (identityEnabled && body.canonical && runId && auth.orgId) {
    return await set(
      prepareCanonicalTeamsUpload$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        runId,
        body: { ...body, canonical: body.canonical },
      },
      signal,
    );
  }
  const filename = sanitizeArtifactFilename(body.filename);
  const artifact = await set(
    allocateUploadedArtifact$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      contentType: body.contentType,
      size: body.length,
      filename: body.filename,
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

export const integrationsTeamsUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTeamsUploadInitContract.init,
    handler: authRoute({ requiredCapability: "teams:write" }, init$),
  },
];
