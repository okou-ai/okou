import { command } from "ccstate";
import {
  MAX_DISCORD_FILE_SIZE_BYTES,
  type DiscordUploadCompleteResponse,
} from "@okouai/api-contracts/contracts/integrations-discord-files";

import { discordMessageUrl } from "../../lib/discord-message";
import {
  appendIntegrationMessageFooter,
  escapeMarkdownFooterLabel,
} from "../../lib/integration-message-footer";
import { discordClient, type DiscordMessage } from "../external/discord-client";
import { settle } from "../utils";
import { finalizePublishedImFile$ } from "./canonical-asset.service";
import {
  discordUnavailable,
  type DiscordFailureResponse,
} from "./discord-api-response";
import {
  requireDiscordOutputAccess$,
  resolveDiscordOutputChannel$,
} from "./discord-output-destination.service";
import {
  integrationMessageSendFooterText,
  integrationMessageSendLabels$,
} from "./integration-message-context.service";

interface CompleteDiscordFileDeliveryArgs {
  readonly assetId: string;
  readonly runId: string | null;
  readonly userId: string;
  readonly orgId: string;
  readonly channelId?: string;
  readonly recipientId?: string;
  readonly guildId?: string;
  readonly comment?: string;
}

type DiscordDeliveryFailure = {
  readonly ok: false;
  readonly response:
    | DiscordFailureResponse
    | {
        readonly status: 400;
        readonly body: {
          readonly error: { readonly code: string; readonly message: string };
        };
      };
};

type DiscordDeliveryResult =
  | ({ readonly ok: true } & DiscordUploadCompleteResponse)
  | DiscordDeliveryFailure;

function invalidFile(message: string): DiscordDeliveryFailure {
  return {
    ok: false,
    response: {
      status: 400,
      body: { error: { code: "INVALID_FILE", message } },
    },
  };
}

function deliveredAttachment(
  message: DiscordMessage,
  channelId: string,
  sizeBytes: number,
  botUserId: string,
) {
  if (message.channel_id !== channelId || message.author.id !== botUserId) {
    return undefined;
  }
  // Discord normalizes attachment filenames, so the receipt is matched by the
  // bot's single attachment of the verified size rather than by name.
  const [attachment, ...extra] = message.attachments;
  return attachment && extra.length === 0 && attachment.size === sizeBytes
    ? attachment
    : undefined;
}

function discordDeliveryFailure(
  assetId: string,
  url: string,
  message: string,
): DiscordDeliveryResult {
  return {
    ok: true,
    assetId,
    url,
    delivery: { status: "failed", message },
  };
}

function mapFinalizedDiscordError(
  code: string,
  message: string,
): DiscordDeliveryResult {
  if (code === "NOT_FOUND") {
    return { ok: false, response: discordUnavailable() };
  }
  if (code === "STORAGE_UNAVAILABLE") {
    return {
      ok: false,
      response: {
        status: 502,
        body: {
          error: {
            code: "STORAGE_UNAVAILABLE",
            message: "Could not read the uploaded file.",
          },
        },
      },
    };
  }
  return invalidFile(message);
}

const sendDiscordUploadedAttachment$ = command(
  async (
    { get },
    args: {
      readonly assetId: string;
      readonly url: string;
      readonly channelId: string;
      readonly comment?: string;
      readonly botToken: string;
      readonly guildId: string | undefined;
      readonly discordUserId: string;
      readonly botUserId: string;
      readonly filename: string;
      readonly contentType: string;
      readonly sizeBytes: number;
      readonly bytes: Buffer;
    },
    signal: AbortSignal,
  ): Promise<DiscordDeliveryResult> => {
    const labels = await get(integrationMessageSendLabels$);
    signal.throwIfAborted();
    const footerText = integrationMessageSendFooterText({
      ...labels,
      agentLabel: escapeMarkdownFooterLabel(labels.agentLabel),
      userLabel: labels.runOwner ? `<@${args.discordUserId}>` : undefined,
    });
    const comment = appendIntegrationMessageFooter(
      args.comment,
      footerText ? `-# ${footerText}` : undefined,
      2000,
    );
    const sent = await settle(
      discordClient.createDiscordMessage(
        {
          botToken: args.botToken,
          channelId: args.channelId,
          content: comment,
          files: [
            {
              filename: args.filename,
              data: new Blob([new Uint8Array(args.bytes)], {
                type: args.contentType,
              }),
            },
          ],
        },
        signal,
      ),
      signal,
    );
    if (!sent.ok) {
      return discordDeliveryFailure(
        args.assetId,
        args.url,
        "Discord did not confirm the file delivery.",
      );
    }
    if (sent.value.kind !== "ok") {
      const rejected =
        sent.value.status >= 400 &&
        sent.value.status < 500 &&
        sent.value.status !== 408;
      return discordDeliveryFailure(
        args.assetId,
        args.url,
        rejected
          ? "Discord rejected the file delivery"
          : "Discord did not confirm the file delivery.",
      );
    }
    const message = sent.value.data;
    const attachment = deliveredAttachment(
      message,
      args.channelId,
      args.sizeBytes,
      args.botUserId,
    );
    if (!attachment) {
      return discordDeliveryFailure(
        args.assetId,
        args.url,
        "Discord's response does not match the file delivery",
      );
    }
    return {
      ok: true,
      assetId: args.assetId,
      url: args.url,
      delivery: {
        status: "delivered",
        channelId: args.channelId,
        messageId: message.id,
        attachmentId: attachment.id,
        permalink: discordMessageUrl({
          guildId: args.guildId,
          channelId: message.channel_id,
          messageId: message.id,
        }),
      },
    };
  },
);

/** Finalize the uploaded file and fire-and-forget deliver it to Discord. */
export const completeCanonicalDiscordDelivery$ = command(
  async (
    { set },
    args: CompleteDiscordFileDeliveryArgs,
    signal: AbortSignal,
  ): Promise<DiscordDeliveryResult> => {
    const resolvedChannel = await set(
      resolveDiscordOutputChannel$,
      {
        orgId: args.orgId,
        userId: args.userId,
        channelId: args.channelId,
        recipientId: args.recipientId,
        guildId: args.guildId,
      },
      signal,
    );
    if (resolvedChannel.kind === "denied") {
      return { ok: false, response: resolvedChannel.response };
    }
    const channelId = resolvedChannel.channelId;

    const initialAccess = await set(
      requireDiscordOutputAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        guildId: args.guildId,
        channelId,
        createThread: false,
        attachFiles: true,
        allowOtherDmRecipients: true,
      },
      signal,
    );
    if (initialAccess.kind === "denied") {
      return { ok: false, response: initialAccess.response };
    }

    const finalized = await set(
      finalizePublishedImFile$,
      {
        assetId: args.assetId,
        userId: args.userId,
        orgId: args.orgId,
        runId: args.runId,
        downloadMaxBytes: MAX_DISCORD_FILE_SIZE_BYTES,
      },
      signal,
    );
    if (!finalized.ok) {
      return mapFinalizedDiscordError(finalized.code, finalized.message);
    }
    if (!finalized.bytes) {
      return invalidFile("Uploaded file content could not be verified");
    }

    const destination = await set(
      requireDiscordOutputAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        guildId: args.guildId,
        channelId,
        createThread: true,
        attachFiles: true,
        allowOtherDmRecipients: true,
      },
      signal,
    );
    if (destination.kind === "denied") {
      return { ok: false, response: destination.response };
    }

    return await set(
      sendDiscordUploadedAttachment$,
      {
        assetId: args.assetId,
        url: finalized.url,
        channelId,
        comment: args.comment,
        botToken: destination.botToken,
        guildId: destination.channel.guild_id,
        discordUserId: destination.binding.discordUserId,
        botUserId: destination.binding.botUserId,
        filename: finalized.file.filename,
        contentType: finalized.file.contentType,
        sizeBytes: finalized.file.sizeBytes,
        bytes: finalized.bytes,
      },
      signal,
    );
  },
);
