import { command, computed } from "ccstate";
import {
  integrationsSlackUploadInitContract,
  type SlackUploadInitBody,
} from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { createSlackClient } from "../external/slack-message-client";
import { MAX_SLACK_FILE_SIZE_BYTES } from "../external/slack-file-fetcher";
import {
  CanonicalPublicationConflictError,
  prepareCanonicalPublishedAsset$,
} from "../services/canonical-asset.service";
import { slackUserInstallation } from "../services/slack-data.service";
import { resolveSlackWriteTarget$ } from "../services/slack-write-access.service";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

const slackInstallationInput$ = computed(
  (
    get,
  ): {
    readonly orgId: string;
    readonly userId: string;
  } => {
    const auth = get(organizationAuthContext$);
    return { orgId: auth.orgId, userId: auth.userId };
  },
);
const slackInstallation$ = slackUserInstallation(slackInstallationInput$);

const noInstallation = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No connected Slack account found for this organization",
      code: "NOT_FOUND",
    }),
  }),
});

function canonicalDestination(
  upload: NonNullable<SlackUploadInitBody["canonical"]>,
  target: {
    readonly channelId: string;
    readonly workspaceId: string;
  },
) {
  return {
    channelId: target.channelId,
    workspaceId: target.workspaceId,
    ...(upload.threadTs ? { threadTs: upload.threadTs } : {}),
    ...(upload.title ? { title: upload.title } : {}),
    ...(upload.initialComment ? { initialComment: upload.initialComment } : {}),
  };
}

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

  const runId = "runId" in auth ? auth.runId : undefined;
  if (body.canonical && runId) {
    if (body.length > MAX_SLACK_FILE_SIZE_BYTES) {
      return badRequestMessage("File too large (max 100 MB)");
    }
    const contentType =
      body.canonical.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!isAllowedUploadType(contentType)) {
      return badRequestMessage(`Unsupported file type: ${contentType}`);
    }
    const target = await set(
      resolveSlackWriteTarget$,
      {
        runId,
        userId: auth.userId,
        orgId: auth.orgId,
        channel: body.canonical.channel,
        threadTs: body.canonical.threadTs,
        user: body.canonical.user,
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
          provider: "slack",
          runId,
          userId: auth.userId,
          orgId: auth.orgId,
          operationId: body.canonical.operationId,
          filename: body.filename,
          contentType,
          size: body.length,
          checksumSha256: body.canonical.checksumSha256,
          destination: canonicalDestination(body.canonical, target),
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
        kind: "canonical" as const,
        assetId: prepared.assetId,
        operationId: prepared.operationId,
        channel: target.channelId,
        ...(prepared.uploadUrl ? { uploadUrl: prepared.uploadUrl } : {}),
        ...(prepared.uploadHeaders
          ? { uploadHeaders: prepared.uploadHeaders }
          : {}),
        url: prepared.url,
      },
    };
  }

  const installation = await get(slackInstallation$);
  signal.throwIfAborted();
  if (installation.kind !== "connected") {
    return noInstallation;
  }

  const client = createSlackClient(installation.botToken, {
    automaticRetries: false,
  });
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
