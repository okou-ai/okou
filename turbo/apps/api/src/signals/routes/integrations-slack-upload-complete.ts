import { command } from "ccstate";
import { integrationsSlackUploadCompleteContract } from "@okouai/api-contracts/contracts/integrations";

import { appendIntegrationMessageFooter } from "../../lib/integration-message-footer";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { resolveSlackMessageSendFooter$ } from "../services/slack-message-context.service";
import { resolveSlackWriteTarget$ } from "../services/slack-write-access.service";

const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;

  const bodyResult = await get(
    bodyResultOf(integrationsSlackUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const target = await set(
    resolveSlackWriteTarget$,
    {
      runId,
      allowSource: false,
      userId: auth.userId,
      orgId: auth.orgId,
      channel: body.channel,
      threadTs: body.threadTs,
      user: body.user,
    },
    signal,
  );
  if ("status" in target) {
    return target;
  }
  const channel = target.channelId;
  const footerText = await set(
    resolveSlackMessageSendFooter$,
    target.workspaceId,
    signal,
  );
  const completeResult = await target.client.completeUploadExternal({
    fileId: body.fileId,
    channel,
    threadTs: body.threadTs,
    title: body.title,
    initialComment:
      appendIntegrationMessageFooter(body.initialComment, footerText) ||
      undefined,
  });
  signal.throwIfAborted();
  if (completeResult.kind === "slack_error") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: `Slack API error: ${completeResult.error}`,
          code: "SLACK_ERROR",
        },
      },
    };
  }

  const infoResult = await target.client.getFileInfo(body.fileId);
  signal.throwIfAborted();
  if (infoResult.kind === "slack_error") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: `Slack API error: ${infoResult.error}`,
          code: "SLACK_ERROR",
        },
      },
    };
  }
  const permalink = infoResult.file?.permalink ?? "";
  return {
    status: 200 as const,
    body: {
      fileId: body.fileId,
      permalink,
      channel,
    },
  };
});

const slackWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "slack:write",
} as const;

export const integrationsSlackUploadCompleteRoutes: readonly RouteEntry[] = [
  {
    route: integrationsSlackUploadCompleteContract.complete,
    handler: authRoute(slackWriteAuth, completeInner$),
  },
];
