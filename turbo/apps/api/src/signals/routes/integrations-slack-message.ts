import { command } from "ccstate";
import { integrationsSlackMessageContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { SlackAnyBlock } from "../external/slack-block-kit";
import { slackMessageSendFooterText$ } from "../services/slack-message-context.service";
import { resolveSlackWriteTarget$ } from "../services/slack-write-access.service";
import { buildFooterBlocks } from "../../lib/slack-blocks";
import type { RouteEntry } from "../route-entry";

const sendMessageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsSlackMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const target = await set(
    resolveSlackWriteTarget$,
    {
      runId: "runId" in auth ? auth.runId : undefined,
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
  const targetChannel = target.channelId;
  const footerText = await get(slackMessageSendFooterText$);
  signal.throwIfAborted();

  let finalBlocks = body.blocks as SlackAnyBlock[] | undefined;
  if (footerText) {
    const footerBlocks = buildFooterBlocks(footerText);
    if (finalBlocks && finalBlocks.length > 0) {
      finalBlocks = [...finalBlocks, ...footerBlocks];
    } else if (body.text) {
      finalBlocks = [
        { type: "section", text: { type: "mrkdwn", text: body.text } },
        ...footerBlocks,
      ];
    } else {
      finalBlocks = footerBlocks;
    }
  }

  const result = await target.client.postMessage(
    targetChannel,
    body.text ?? "",
    {
      threadTs: body.threadTs,
      blocks: finalBlocks,
    },
  );
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
      ok: true as const,
      ts: result.ts,
      channel: result.channel,
    },
  };
});

const slackWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "slack:write",
} as const;

export const integrationsSlackMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsSlackMessageContract.sendMessage,
    handler: authRoute(slackWriteAuth, sendMessageInner$),
  },
];
