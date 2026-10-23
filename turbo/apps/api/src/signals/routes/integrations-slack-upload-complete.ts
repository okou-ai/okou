import { command } from "ccstate";
import {
  integrationsSlackUploadCompleteContract,
  type SlackUploadCompleteBody,
} from "@okouai/api-contracts/contracts/integrations";
import { CURRENT_LINK_LAYOUT } from "@okouai/api-contracts/contracts/link-layout";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { SlackFileInfo } from "../external/slack-message-client";
import { completeCanonicalSlackDelivery$ } from "../services/canonical-slack-asset-delivery.service";
import { recordSlackUploadedFile$ } from "../services/run-uploaded-files.service";
import { resolveSlackWriteTarget$ } from "../services/slack-write-access.service";
import type { RouteEntry } from "../route-entry";

function buildSlackUploadMetadata(
  body: SlackUploadCompleteBody,
  channel: string,
  file: SlackFileInfo | undefined,
): Record<string, unknown> {
  return {
    channel,
    ...(body.threadTs ? { threadTs: body.threadTs } : {}),
    ...(body.title ? { title: body.title } : {}),
    ...(body.initialComment ? { initialComment: body.initialComment } : {}),
    slackFile: {
      id: file?.id ?? body.fileId,
      name: file?.name ?? null,
      title: file?.title ?? null,
      mimetype: file?.mimetype ?? null,
      filetype: file?.filetype ?? null,
    },
  };
}

interface CanonicalCompletionArgs {
  readonly body: SlackUploadCompleteBody;
  readonly runId: string | undefined;
  readonly userId: string;
  readonly orgId: string;
}

const completeCanonicalUpload$ = command(
  async ({ set }, args: CanonicalCompletionArgs, signal: AbortSignal) => {
    const { body, runId } = args;
    if (!body.canonicalAssetId || !body.operationId || !runId) {
      return {
        status: 400 as const,
        body: {
          error: {
            message:
              "Canonical Slack completion requires asset, operation, and run identities",
            code: "BAD_REQUEST",
          },
        },
      };
    }
    const delivery = await set(
      completeCanonicalSlackDelivery$,
      {
        assetId: body.canonicalAssetId,
        operationId: body.operationId,
        runId,
        userId: args.userId,
        orgId: args.orgId,
        fileId: body.fileId,
        ...(body.uploadError ? { uploadError: body.uploadError } : {}),
      },
      signal,
    );
    if (!delivery) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: "Canonical Slack delivery was not found",
            code: "NOT_FOUND",
          },
        },
      };
    }
    if (delivery.status === "failed") {
      return {
        status: 200 as const,
        body: {
          fileId: body.fileId,
          permalink: "",
          channel: delivery.channelId,
          assetId: body.canonicalAssetId,
          deliveryStatus: "failed" as const,
          deliveryError: delivery.message,
        },
      };
    }
    if (delivery.status === "pending") {
      throw new Error("Canonical Slack completion remained pending");
    }
    return {
      status: 200 as const,
      body: {
        fileId: delivery.fileId,
        permalink: delivery.permalink,
        channel: delivery.channelId,
        assetId: body.canonicalAssetId,
        deliveryStatus: "delivered" as const,
      },
    };
  },
);

interface DirectCompletionArgs {
  readonly body: SlackUploadCompleteBody;
  readonly runId: string | undefined;
  readonly userId: string;
  readonly orgId: string;
}

const completeDirectUpload$ = command(
  async ({ set }, args: DirectCompletionArgs, signal: AbortSignal) => {
    const { body } = args;
    const target = await set(
      resolveSlackWriteTarget$,
      {
        runId: args.runId,
        allowSource: false,
        userId: args.userId,
        orgId: args.orgId,
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
    const completeResult = await target.client.completeUploadExternal({
      fileId: body.fileId,
      channel,
      threadTs: body.threadTs,
      title: body.title,
      initialComment: body.initialComment,
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
    const file = infoResult.file;
    const permalink = file?.permalink ?? "";
    await set(
      recordSlackUploadedFile$,
      {
        runId: args.runId,
        externalId: body.fileId,
        userId: args.userId,
        orgId: args.orgId,
        filename: body.title ?? file?.title ?? file?.name ?? null,
        contentType: file?.mimetype ?? null,
        sizeBytes: file?.size ?? null,
        url: permalink || null,
        layout: CURRENT_LINK_LAYOUT,
        metadata: buildSlackUploadMetadata(body, channel, file),
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        fileId: body.fileId,
        permalink,
        channel,
      },
    };
  },
);

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

  const hasCanonicalIdentity =
    body.canonicalAssetId !== undefined || body.operationId !== undefined;
  if (hasCanonicalIdentity) {
    return set(
      completeCanonicalUpload$,
      {
        body,
        runId,
        userId: auth.userId,
        orgId: auth.orgId,
      },
      signal,
    );
  }

  return set(
    completeDirectUpload$,
    {
      body,
      runId,
      userId: auth.userId,
      orgId: auth.orgId,
    },
    signal,
  );
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
