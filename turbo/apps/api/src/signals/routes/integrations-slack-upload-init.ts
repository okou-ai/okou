import { command } from "ccstate";
import { integrationsSlackUploadInitContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { createSlackClient } from "../external/slack-message-client";
import { MAX_SLACK_FILE_SIZE_BYTES } from "../external/slack-file-fetcher";
import { prepareCanonicalPublishedAsset$ } from "../services/canonical-asset.service";
import { slackOrgInstallation } from "../services/slack-data.service";
import { badRequestMessage, notFound } from "../../lib/error";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import type { RouteEntry } from "../route-entry";

const noInstallation = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No Slack installation found for this organization",
      code: "NOT_FOUND",
    }),
  }),
});

const initInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const bodyResult = await get(
    bodyResultOf(integrationsSlackUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const installation = await get(
    slackOrgInstallation({ orgId: auth.orgId, userId: auth.userId }),
  );
  signal.throwIfAborted();
  if (!installation) {
    return noInstallation;
  }

  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;
  if (body.canonical && runId) {
    if (body.length > MAX_SLACK_FILE_SIZE_BYTES) {
      return badRequestMessage("File too large (max 100 MB)");
    }
    const contentType =
      body.canonical.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!isAllowedUploadType(contentType)) {
      return badRequestMessage(`Unsupported file type: ${contentType}`);
    }
    const prepared = await set(
      prepareCanonicalPublishedAsset$,
      {
        runId,
        userId: auth.userId,
        orgId: auth.orgId,
        operationId: body.canonical.operationId,
        filename: body.filename,
        contentType,
        size: body.length,
        checksumSha256: body.canonical.checksumSha256,
        destination: {
          channelId: body.canonical.channel,
          ...(body.canonical.threadTs
            ? { threadTs: body.canonical.threadTs }
            : {}),
          ...(body.canonical.title ? { title: body.canonical.title } : {}),
          ...(body.canonical.initialComment
            ? { initialComment: body.canonical.initialComment }
            : {}),
        },
      },
      signal,
    );
    if (!prepared) {
      return notFound("Agent run not found");
    }
    return {
      status: 200 as const,
      body: {
        kind: "canonical" as const,
        assetId: prepared.assetId,
        operationId: prepared.operationId,
        ...(prepared.uploadUrl ? { uploadUrl: prepared.uploadUrl } : {}),
        ...(prepared.uploadHeaders
          ? { uploadHeaders: prepared.uploadHeaders }
          : {}),
        url: prepared.url,
      },
    };
  }

  const client = createSlackClient(installation.botToken);
  const result = await client.getUploadUrlExternal({
    filename: body.filename,
    length: body.length,
  });
  signal.throwIfAborted();

  if (result.kind === "slack_error") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: `Slack API error: ${result.error}`,
          code: "SLACK_ERROR",
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      uploadUrl: result.uploadUrl,
      fileId: result.fileId,
    },
  };
});

const slackWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "slack:write",
} as const;

export const integrationsSlackUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsSlackUploadInitContract.init,
    handler: authRoute(slackWriteAuth, initInner$),
  },
];
