import { command } from "ccstate";
import {
  integrationsSlackUploadCompleteContract,
  type SlackUploadCompleteBody,
} from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  createSlackClient,
  type SlackClient,
  type SlackFileInfo,
} from "../external/slack-message-client";
import { completeCanonicalSlackDelivery$ } from "../services/canonical-slack-asset-delivery.service";
import { recordSlackUploadedFile$ } from "../services/run-uploaded-files.service";
import { slackOrgInstallation } from "../services/slack-data.service";
import type { RouteEntry } from "../route-entry";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const noInstallation = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No Slack installation found for this organization",
      code: "NOT_FOUND",
    }),
  }),
});

function buildSlackUploadMetadata(
  body: SlackUploadCompleteBody,
  file: SlackFileInfo | undefined,
): Record<string, unknown> {
  return {
    channel: body.channel,
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
  readonly client: SlackClient;
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
        fileId: body.fileId,
        ...(body.uploadError ? { uploadError: body.uploadError } : {}),
        client: args.client,
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
  readonly client: SlackClient;
}

const completeDirectUpload$ = command(
  async ({ set }, args: DirectCompletionArgs, signal: AbortSignal) => {
    const { body, client } = args;
    const completeResult = await client.completeUploadExternal({
      fileId: body.fileId,
      channel: body.channel,
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

    const infoResult = await client.getFileInfo(body.fileId);
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
        publicBrand: PUBLIC_BRAND,
        metadata: buildSlackUploadMetadata(body, file),
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        fileId: body.fileId,
        permalink,
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

  const installation = await get(
    slackOrgInstallation({ orgId: auth.orgId, userId: auth.userId }),
  );
  signal.throwIfAborted();
  if (!installation) {
    return noInstallation;
  }

  const client = createSlackClient(installation.botToken);
  const hasCanonicalIdentity =
    body.canonicalAssetId !== undefined || body.operationId !== undefined;
  if (hasCanonicalIdentity) {
    return set(
      completeCanonicalUpload$,
      {
        body,
        runId,
        userId: auth.userId,
        client,
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
      client,
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
