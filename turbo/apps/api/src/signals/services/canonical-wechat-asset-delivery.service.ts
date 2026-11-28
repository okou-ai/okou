import { createHash, randomUUID } from "node:crypto";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import {
  MAX_WECHAT_FILE_SIZE_BYTES,
  type WechatUploadCompleteResponse,
} from "@okouai/api-contracts/contracts/integrations-wechat-files";
import type { WechatMessage } from "@okouai/api-contracts/contracts/wechat-protocol";
import { WechatRequestError } from "@okouai/core/wechat-client";
import { wechatMessages } from "@okouai/db/schema/wechat";

import {
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { appendIntegrationMessageFooter } from "../../lib/integration-message-footer";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  sendWechatMedia,
  uploadWechatMedia,
  WechatMediaUploadError,
} from "../external/wechat-media";
import { settle } from "../utils";
import { finalizePublishedImFile$ } from "./canonical-asset.service";
import { encryptStoredSecretValue } from "./crypto.utils";
import { integrationMessageSendFooterText$ } from "./integration-message-context.service";
import { requireWechatSendAccess$ } from "./wechat-access.service";
import { wechatEventId } from "./wechat-message-identity";
import { sendArchivedWechatText$ } from "./wechat-message-send.service";

const log = logger("service:wechat-asset-delivery");

function failureDetails(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : "unknown",
    ...(error instanceof WechatMediaUploadError ||
    error instanceof WechatRequestError
      ? { statusCode: error.statusCode }
      : {}),
    ...(error instanceof WechatRequestError
      ? { providerRet: error.ret, providerErrorCode: error.errcode }
      : {}),
  };
}

interface CompleteWechatFileDeliveryArgs {
  readonly assetId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | null;
  readonly channelId: string;
  readonly comment?: string;
}

const deliverWechatMedia$ = command(
  async (
    { get, set },
    args: CompleteWechatFileDeliveryArgs & {
      readonly generation: string;
      readonly filename: string;
      readonly sizeBytes: number;
      readonly checksumSha256: string;
      readonly uploaded: NonNullable<WechatMessage["item_list"]>[number];
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const sendId = randomUUID();
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([args.filename, args.checksumSha256, args.comment]),
      )
      .digest("hex");
    const footerText = await get(integrationMessageSendFooterText$);
    signal.throwIfAborted();
    const comment = appendIntegrationMessageFooter(
      args.comment,
      footerText,
      2000,
    );
    if (comment) {
      const caption = await set(
        sendArchivedWechatText$,
        {
          orgId: args.orgId,
          userId: args.userId,
          runId: args.runId,
          channelId: args.channelId,
          generation: args.generation,
          operationId: sendId,
          index: 0,
          text: comment,
          requestHash,
        },
        signal,
      );
      if (caption.kind === "denied") {
        throw new Error(caption.response.body.error.message);
      }
    }
    const id = wechatEventId(args.channelId, sendId, "file");
    const encrypted = await encryptStoredSecretValue(
      JSON.stringify([args.uploaded]),
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    await db.insert(wechatMessages).values({
      id,
      connectionId: args.channelId,
      generation: args.generation,
      direction: "outbound",
      status: "unknown",
      content: "",
      requestHash,
      mediaCiphertext: encrypted,
      attachments: [
        {
          id: "0",
          kind:
            args.uploaded.type === 2
              ? "image"
              : args.uploaded.type === 5
                ? "video"
                : "file",
          filename: args.filename,
          size: args.sizeBytes,
        },
      ],
      createdAt: nowDate(),
    });
    signal.throwIfAborted();
    const live = await set(
      requireWechatSendAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        channelId: args.channelId,
        generation: args.generation,
      },
      signal,
    );
    if (live.kind === "denied") {
      throw new Error(live.response.body.error.message);
    }
    const receipt = await sendWechatMedia(
      {
        baseUrl: live.connection.baseUrl,
        token: live.token,
        senderId: live.connection.senderId,
        contextToken: live.contextToken,
        clientId: `okou-${id}`,
        item: args.uploaded,
      },
      signal,
    );
    await db
      .update(wechatMessages)
      .set({
        status: "sent",
        providerMessageId: receipt.message_id ?? null,
      })
      .where(eq(wechatMessages.id, id));
    signal.throwIfAborted();
    return id;
  },
);

/** Finalize the uploaded file and fire-and-forget deliver it to WeChat. */
export const completeCanonicalWechatDelivery$ = command(
  async (
    { set },
    args: CompleteWechatFileDeliveryArgs,
    signal: AbortSignal,
  ) => {
    const access = await set(
      requireWechatSendAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        channelId: args.channelId,
      },
      signal,
    );
    if (access.kind === "denied") {
      return { ok: false, response: access.response } as const;
    }

    const finalized = await set(
      finalizePublishedImFile$,
      {
        assetId: args.assetId,
        userId: args.userId,
        orgId: args.orgId,
        runId: args.runId,
        downloadMaxBytes: MAX_WECHAT_FILE_SIZE_BYTES,
      },
      signal,
    );
    if (!finalized.ok) {
      if (finalized.code === "NOT_FOUND") {
        return {
          ok: false,
          response: notFound("This WeChat file is unavailable."),
        } as const;
      }
      if (finalized.code === "STORAGE_UNAVAILABLE") {
        return {
          ok: false,
          response: providerUnavailable(
            "The published file could not be read.",
          ),
        } as const;
      }
      return {
        ok: false,
        response: badRequestMessage(finalized.message),
      } as const;
    }
    const bytes = finalized.bytes;
    if (!bytes) {
      return {
        ok: false,
        response: badRequestMessage(
          "Uploaded file bytes could not be verified.",
        ),
      } as const;
    }

    const uploaded = await settle(
      uploadWechatMedia(
        {
          baseUrl: access.connection.baseUrl,
          token: access.token,
          senderId: access.connection.senderId,
          filename: finalized.file.filename,
          contentType: finalized.file.contentType,
          bytes,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!uploaded.ok) {
      log.warn("WeChat file upload failed before message delivery", {
        assetId: args.assetId,
        stage: "media-upload",
        ...failureDetails(uploaded.error),
      });
      return {
        ok: false,
        response: providerUnavailable(
          "The file is published, but its WeChat media upload failed before sending.",
        ),
      } as const;
    }

    const delivered = await settle(
      set(
        deliverWechatMedia$,
        {
          ...args,
          generation: access.connection.generation,
          filename: finalized.file.filename,
          sizeBytes: finalized.file.sizeBytes,
          checksumSha256: finalized.file.checksumSha256 ?? "",
          uploaded: uploaded.value,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!delivered.ok) {
      log.warn("WeChat file delivery was not confirmed", {
        assetId: args.assetId,
        stage: "message-delivery",
        ...failureDetails(delivered.error),
      });
      return {
        ok: true,
        assetId: args.assetId,
        url: finalized.url,
        delivery: {
          status: "failed",
          message:
            "WeChat did not confirm complete file delivery. A caption may already have arrived; inspect message history before sending again.",
        },
      } satisfies { readonly ok: true } & WechatUploadCompleteResponse;
    }

    return {
      ok: true,
      assetId: args.assetId,
      url: finalized.url,
      delivery: {
        status: "delivered",
        channelId: args.channelId,
        messageId: delivered.value,
        permalink: null,
      },
    } satisfies { readonly ok: true } & WechatUploadCompleteResponse;
  },
);
