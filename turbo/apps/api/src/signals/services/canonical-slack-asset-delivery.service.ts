import { command } from "ccstate";
import type { SlackUploadDeliveryResponse } from "@okouai/api-contracts/contracts/integrations";

import { appendIntegrationMessageFooter } from "../../lib/integration-message-footer";
import { MAX_SLACK_FILE_SIZE_BYTES } from "../external/slack-file-fetcher";
import { uploadSlackFileBytes } from "../external/slack-file-upload";
import type { SlackClient } from "../external/slack-message-client";
import { settle } from "../utils";
import { finalizePublishedImFile$ } from "./canonical-asset.service";
import { resolveSlackMessageSendFooter$ } from "./slack-message-context.service";
import { resolveSlackWriteTarget$ } from "./slack-write-access.service";

interface DeliverCanonicalSlackAssetArgs {
  readonly assetId: string;
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly channel?: string;
  readonly user?: string;
  readonly threadTs?: string;
  readonly title?: string;
  readonly initialComment?: string;
}

type SlackDeliveryOutcome =
  | ({ readonly ok: true } & SlackUploadDeliveryResponse)
  | {
      readonly ok: false;
      readonly status: 400 | 404;
      readonly code: string;
      readonly message: string;
    };

function providerFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Slack request failed";
}

function sharedSlackFilePermalink(
  info: Awaited<ReturnType<SlackClient["getFileInfo"]>>,
  fileId: string,
  channelId: string,
):
  | { readonly ok: true; readonly permalink: string }
  | { readonly ok: false; readonly message: string } {
  if (info.kind === "slack_error") {
    return { ok: false, message: `Slack delivery failed: ${info.error}` };
  }
  const permalink = info.file?.permalink;
  if (!permalink) {
    return {
      ok: false,
      message: "Slack file info did not include a permalink",
    };
  }
  if (
    info.file?.id !== fileId ||
    typeof info.file.size !== "number" ||
    info.file.size <= 0 ||
    ![
      ...(info.file.channels ?? []),
      ...(info.file.groups ?? []),
      ...(info.file.ims ?? []),
    ].includes(channelId)
  ) {
    return {
      ok: false,
      message: "Slack has not confirmed the uploaded file in its destination",
    };
  }
  return { ok: true, permalink };
}

const uploadAndVerifySlackFile$ = command(
  async (
    { set },
    args: {
      readonly client: SlackClient;
      readonly workspaceId: string;
      readonly channelId: string;
      readonly threadTs?: string;
      readonly title?: string;
      readonly initialComment?: string;
      readonly filename: string;
      readonly bytes: Buffer;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly fileId: string; readonly permalink: string }
    | { readonly ok: false; readonly message: string }
  > => {
    const footerText = await set(
      resolveSlackMessageSendFooter$,
      args.workspaceId,
      signal,
    );
    const preparation = await settle(
      args.client.getUploadUrlExternal({
        filename: args.filename,
        length: args.bytes.byteLength,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!preparation.ok) {
      return { ok: false, message: providerFailureMessage(preparation.error) };
    }
    if (preparation.value.kind === "slack_error") {
      return {
        ok: false,
        message: `Slack delivery failed: ${preparation.value.error}`,
      };
    }

    const { uploadUrl, fileId } = preparation.value;
    const transfer = await settle(
      uploadSlackFileBytes(uploadUrl, args.bytes, signal),
      signal,
    );
    signal.throwIfAborted();
    if (!transfer.ok) {
      return { ok: false, message: providerFailureMessage(transfer.error) };
    }

    const completion = await settle(
      args.client.completeUploadExternal({
        fileId,
        channel: args.channelId,
        threadTs: args.threadTs,
        title: args.title,
        initialComment:
          appendIntegrationMessageFooter(args.initialComment, footerText) ||
          undefined,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!completion.ok) {
      return { ok: false, message: providerFailureMessage(completion.error) };
    }
    if (completion.value.kind === "slack_error") {
      return {
        ok: false,
        message: `Slack delivery failed: ${completion.value.error}`,
      };
    }

    const infoResult = await settle(args.client.getFileInfo(fileId), signal);
    signal.throwIfAborted();
    if (!infoResult.ok) {
      return { ok: false, message: providerFailureMessage(infoResult.error) };
    }
    const verified = sharedSlackFilePermalink(
      infoResult.value,
      fileId,
      args.channelId,
    );
    return verified.ok
      ? { ok: true, fileId, permalink: verified.permalink }
      : verified;
  },
);

/** Finalize the uploaded file and fire-and-forget deliver it to Slack. */
export const deliverCanonicalSlackAsset$ = command(
  async (
    { set },
    args: DeliverCanonicalSlackAssetArgs,
    signal: AbortSignal,
  ): Promise<SlackDeliveryOutcome> => {
    const finalized = await set(
      finalizePublishedImFile$,
      {
        assetId: args.assetId,
        userId: args.userId,
        orgId: args.orgId,
        runId: args.runId,
        downloadMaxBytes: MAX_SLACK_FILE_SIZE_BYTES,
      },
      signal,
    );
    if (!finalized.ok) {
      return {
        ok: false,
        status: finalized.code === "NOT_FOUND" ? 404 : 400,
        code: finalized.code,
        message: finalized.message,
      };
    }
    const bytes = finalized.bytes;
    if (!bytes) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_FILE",
        message: "Uploaded file bytes could not be verified",
      };
    }

    const failedDelivery = (message: string): SlackDeliveryOutcome => {
      return {
        ok: true,
        assetId: args.assetId,
        url: finalized.url,
        delivery: { status: "failed", message },
      };
    };

    const access = await set(
      resolveSlackWriteTarget$,
      {
        runId: args.runId,
        orgId: args.orgId,
        userId: args.userId,
        channel: args.channel,
        user: args.user,
        threadTs: args.threadTs,
      },
      signal,
    );
    if ("status" in access) {
      return failedDelivery(access.body.error.message);
    }

    const delivered = await set(
      uploadAndVerifySlackFile$,
      {
        client: access.client,
        workspaceId: access.workspaceId,
        channelId: access.channelId,
        threadTs: args.threadTs,
        title: args.title,
        initialComment: args.initialComment,
        filename: finalized.file.filename,
        bytes,
      },
      signal,
    );
    if (!delivered.ok) {
      return failedDelivery(delivered.message);
    }

    return {
      ok: true,
      assetId: args.assetId,
      url: finalized.url,
      delivery: {
        status: "delivered",
        fileId: delivered.fileId,
        permalink: delivered.permalink,
      },
    };
  },
);
