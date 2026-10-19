import type {
  CanonicalAssetWechatDeliveryDestination,
  CanonicalAssetWechatDeliveryState,
  RunUploadedFileMetadata,
} from "@okouai/db/jsonb-contracts/run-uploaded-file";
import { createHash, randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  MAX_WECHAT_FILE_SIZE_BYTES,
  type WechatUploadCompleteResponse,
} from "@okouai/api-contracts/contracts/integrations-wechat-files";
import {
  canonicalAssetDeliveries,
  runUploadedFiles,
  CANONICAL_ASSET_VERSION,
} from "@okouai/db/schema/run-uploaded-file";
import { wechatMessages } from "@okouai/db/schema/wechat";
import { writeDb$ } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  S3ObjectSizeLimitError,
} from "../external/s3";
import {
  sendWechatMedia,
  uploadWechatMedia,
  WechatMediaUploadError,
} from "../external/wechat-media";
import type { WechatMessage } from "@okouai/api-contracts/contracts/wechat-protocol";
import { WechatRequestError } from "@okouai/core/wechat-client";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import { nowDate } from "../../lib/time";
import {
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { artifactStorageBucket } from "./private-artifact-storage.service";
import { materializeCanonicalPublishedAsset$ } from "./canonical-asset.service";
import { requireWechatSendAccess$ } from "./wechat-access.service";
import { encryptStoredSecretValue } from "./crypto.utils";
import { sendArchivedWechatText$ } from "./wechat-message-send.service";
import { wechatEventId } from "./wechat-message-identity";
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

interface Identity {
  readonly assetId: string;
  readonly operationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | null;
}
const readDelivery$ = command(
  async ({ set }, args: Identity, signal: AbortSignal) => {
    const [row] = await set(writeDb$)
      .select({
        id: canonicalAssetDeliveries.id,
        status: canonicalAssetDeliveries.status,
        destination: canonicalAssetDeliveries.destination,
        providerState: canonicalAssetDeliveries.providerState,
        externalId: canonicalAssetDeliveries.externalId,
        lastError: canonicalAssetDeliveries.lastError,
        filename: runUploadedFiles.filename,
        contentType: runUploadedFiles.contentType,
        size: runUploadedFiles.sizeBytes,
        checksum: runUploadedFiles.checksumSha256,
        storageKey: runUploadedFiles.storageKey,
        metadata: runUploadedFiles.metadata,
        materializationStatus: runUploadedFiles.materializationStatus,
        url: runUploadedFiles.url,
      })
      .from(canonicalAssetDeliveries)
      .innerJoin(
        runUploadedFiles,
        eq(runUploadedFiles.id, canonicalAssetDeliveries.assetId),
      )
      .where(
        and(
          eq(runUploadedFiles.id, args.assetId),
          eq(runUploadedFiles.orgId, args.orgId),
          eq(runUploadedFiles.userId, args.userId),
          args.runId === null
            ? isNull(runUploadedFiles.runId)
            : eq(runUploadedFiles.runId, args.runId),
          eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
          eq(runUploadedFiles.classification, "published-output"),
          eq(runUploadedFiles.idempotencyKey, args.operationId),
          eq(canonicalAssetDeliveries.operationId, args.operationId),
          eq(canonicalAssetDeliveries.provider, "wechat"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    if (
      row.destination.provider !== "wechat" ||
      row.providerState?.provider !== "wechat" ||
      !row.filename ||
      !row.contentType ||
      row.size === null ||
      !row.checksum ||
      !row.storageKey
    ) {
      throw new Error("WeChat delivery metadata is incomplete");
    }
    return {
      ...row,
      destination: row.destination,
      providerState: row.providerState,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      checksum: row.checksum,
      storageKey: row.storageKey,
    };
  },
);
type Delivery = Pick<
  typeof canonicalAssetDeliveries.$inferSelect,
  "id" | "status" | "externalId" | "lastError"
> & {
  destination: CanonicalAssetWechatDeliveryDestination;
  providerState: CanonicalAssetWechatDeliveryState;
  filename: string;
  contentType: string;
  size: number;
  checksum: string;
  storageKey: string;
  metadata: RunUploadedFileMetadata;
  materializationStatus: (typeof runUploadedFiles.$inferSelect)["materializationStatus"];
  url: string | null;
};

function response(args: Identity, row: Delivery) {
  if (!row.url || row.materializationStatus !== "ready") {
    return {
      ok: false,
      response: badRequestMessage("Publish the file before WeChat delivery."),
    } as const;
  }
  let delivery: WechatUploadCompleteResponse["delivery"];
  if (row.status === "delivered") {
    if (!row.externalId) {
      throw new Error("WeChat file delivery has no receipt");
    }
    delivery = {
      status: "delivered",
      channelId: row.destination.channelId,
      messageId: row.externalId,
      permalink: null,
    };
  } else if (row.status === "failed") {
    if (!row.lastError) {
      throw new Error("WeChat file delivery has no failure reason");
    }
    delivery = {
      status: "failed",
      message: row.lastError.message,
      retryable: row.lastError.retryable,
    };
  } else {
    delivery = { status: "pending" };
  }
  return {
    ok: true,
    assetId: args.assetId,
    operationId: args.operationId,
    url: row.url,
    delivery,
  } as const;
}
function unavailable() {
  return {
    ok: false,
    response: notFound("This WeChat file operation is unavailable."),
  } as const;
}

class InvalidWechatFileError extends Error {}
function fileFailure(error: unknown) {
  return {
    ok: false,
    response:
      error instanceof InvalidWechatFileError ||
      error instanceof S3ObjectSizeLimitError
        ? badRequestMessage(
            "Uploaded bytes do not match the declared checksum/size or exceed 10 MiB.",
          )
        : providerUnavailable(
            "The published file could not be read. Retry this operation before delivery.",
          ),
  } as const;
}
const fileBytes$ = command(
  async ({ get }, row: Delivery, signal: AbortSignal) => {
    if (row.size < 1 || row.size > MAX_WECHAT_FILE_SIZE_BYTES) {
      throw new InvalidWechatFileError("WeChat file exceeds 10 MiB");
    }
    const bytes = await get(
      downloadS3BufferWithMaxBytes(
        artifactStorageBucket(row.metadata),
        row.storageKey,
        MAX_WECHAT_FILE_SIZE_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (
      bytes.byteLength !== row.size ||
      createHash("sha256").update(bytes).digest("hex") !== row.checksum
    ) {
      throw new InvalidWechatFileError(
        "Uploaded bytes do not match the declared checksum and size",
      );
    }
    return bytes;
  },
);
export const materializeCanonicalWechatAsset$ = command(
  async ({ set }, args: Identity, signal: AbortSignal) => {
    const row = await set(readDelivery$, args, signal);
    if (!row) {
      return unavailable();
    }
    const access = await set(
      requireWechatSendAccess$,
      {
        ...args,
        channelId: row.destination.channelId,
        generation: row.destination.generation,
      },
      signal,
    );
    if (access.kind === "denied") {
      return { ok: false, response: access.response } as const;
    }
    if (row.materializationStatus !== "ready") {
      const checked = await settle(set(fileBytes$, row, signal), signal);
      if (!checked.ok) {
        return fileFailure(checked.error);
      }
    }
    const materialized = await set(
      materializeCanonicalPublishedAsset$,
      args,
      signal,
    );
    if (!materialized.ok) {
      return {
        ok: false,
        response: badRequestMessage(materialized.message),
      } as const;
    }
    const current = await set(readDelivery$, args, signal);
    return current ? response(args, current) : unavailable();
  },
);

const recordFileReceipt$ = command(
  async (
    { set },
    row: Delivery,
    id: string,
    providerMessageId: string | null,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const archiveReceipt = db
      .update(wechatMessages)
      .set({ status: "sent", providerMessageId: providerMessageId })
      .where(eq(wechatMessages.id, id))
      .returning({ id: wechatMessages.id });
    const deliveryReceipt = db
      .update(canonicalAssetDeliveries)
      .set({
        status: "delivered",
        externalId: id,
        lastError: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(canonicalAssetDeliveries.id, row.id),
          eq(canonicalAssetDeliveries.providerState, row.providerState),
        ),
      );
    await db.execute(
      sql`WITH receipt AS (${archiveReceipt.getSQL()}) ${deliveryReceipt.getSQL()}`,
    );
    signal.throwIfAborted();
  },
);

const deliverFile$ = command(
  async (
    { set },
    args: Identity,
    row: Delivery,
    uploaded: NonNullable<WechatMessage["item_list"]>[number],
    signal: AbortSignal,
  ) => {
    const access = await set(
      requireWechatSendAccess$,
      {
        ...args,
        channelId: row.destination.channelId,
        generation: row.destination.generation,
      },
      signal,
    );
    if (access.kind === "denied") {
      throw new Error(access.response.body.error.message);
    }
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([row.filename, row.checksum, row.destination.comment]),
      )
      .digest("hex");
    if (row.destination.comment) {
      const caption = await set(
        sendArchivedWechatText$,
        {
          ...args,
          channelId: row.destination.channelId,
          generation: row.destination.generation,
          index: 0,
          text: row.destination.comment,
          requestHash,
        },
        signal,
      );
      if (caption.kind === "denied") {
        throw new Error(caption.response.body.error.message);
      }
    }
    const id = wechatEventId(
      row.destination.channelId,
      args.operationId,
      "file",
    );
    const encrypted = await encryptStoredSecretValue(
      JSON.stringify([uploaded]),
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    await db.insert(wechatMessages).values({
      id,
      connectionId: row.destination.channelId,
      generation: row.destination.generation,
      direction: "outbound",
      status: "unknown",
      content: "",
      requestHash,
      mediaCiphertext: encrypted,
      attachments: [
        {
          id: "0",
          kind:
            uploaded.type === 2
              ? "image"
              : uploaded.type === 5
                ? "video"
                : "file",
          filename: row.filename,
          size: row.size,
        },
      ],
      createdAt: nowDate(),
    });
    signal.throwIfAborted();
    const live = await set(
      requireWechatSendAccess$,
      {
        ...args,
        channelId: row.destination.channelId,
        generation: row.destination.generation,
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
        item: uploaded,
      },
      signal,
    );
    await set(recordFileReceipt$, row, id, receipt.message_id ?? null, signal);
  },
);

export const completeCanonicalWechatDelivery$ = command(
  async ({ set }, args: Identity, signal: AbortSignal) => {
    const row = await set(readDelivery$, args, signal);
    if (!row) {
      return unavailable();
    }
    const access = await set(
      requireWechatSendAccess$,
      {
        ...args,
        channelId: row.destination.channelId,
        generation: row.destination.generation,
      },
      signal,
    );
    if (access.kind === "denied") {
      return { ok: false, response: access.response } as const;
    }
    if (
      row.materializationStatus !== "ready" ||
      row.status !== "pending" ||
      row.providerState.attempt !== null
    ) {
      return response(args, row);
    }
    const checked = await settle(set(fileBytes$, row, signal), signal);
    if (!checked.ok) {
      return fileFailure(checked.error);
    }
    // Preparing an encrypted CDN object cannot deliver a message. Keep the
    // operation unclaimed so an upload failure can resume with the same ID.
    const uploaded = await settle(
      uploadWechatMedia(
        {
          baseUrl: access.connection.baseUrl,
          token: access.token,
          senderId: access.connection.senderId,
          filename: row.filename,
          contentType: row.contentType,
          bytes: checked.value,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!uploaded.ok) {
      log.warn("WeChat file upload failed before message delivery", {
        operationId: args.operationId,
        stage: "media-upload",
        ...failureDetails(uploaded.error),
      });
      return {
        ok: false,
        response: providerUnavailable(
          "The file is published, but its WeChat media upload failed before sending. Retry with the same operation ID.",
        ),
      } as const;
    }
    const providerState = {
      provider: "wechat",
      attempt: { id: randomUUID(), startedAt: nowDate().toISOString() },
    } as const;
    const db = set(writeDb$);
    const [claimed] = await db
      .update(canonicalAssetDeliveries)
      .set({ providerState, updatedAt: nowDate() })
      .where(
        and(
          eq(canonicalAssetDeliveries.id, row.id),
          eq(canonicalAssetDeliveries.status, "pending"),
          eq(canonicalAssetDeliveries.providerState, row.providerState),
        ),
      )
      .returning({ id: canonicalAssetDeliveries.id });
    signal.throwIfAborted();
    if (claimed) {
      const result = await settle(
        set(
          deliverFile$,
          args,
          { ...row, providerState },
          uploaded.value,
          signal,
        ),
        signal,
      );
      signal.throwIfAborted();
      if (!result.ok) {
        log.warn("WeChat file delivery was not confirmed", {
          operationId: args.operationId,
          stage: "message-delivery",
          ...failureDetails(result.error),
        });
        await db
          .update(canonicalAssetDeliveries)
          .set({
            status: "failed",
            lastError: {
              code: "wechat-delivery-unconfirmed",
              message:
                "WeChat did not confirm complete file delivery. A caption may already have arrived; inspect message history before starting a new operation.",
              retryable: false,
            },
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(canonicalAssetDeliveries.id, row.id),
              eq(canonicalAssetDeliveries.status, "pending"),
              eq(canonicalAssetDeliveries.providerState, providerState),
            ),
          );
        signal.throwIfAborted();
      }
    }
    const current = await set(readDelivery$, args, signal);
    return current ? response(args, current) : unavailable();
  },
);
