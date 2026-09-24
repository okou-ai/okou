import { createHash, randomUUID } from "node:crypto";
import { command } from "ccstate";
import {
  MAX_DISCORD_FILE_SIZE_BYTES,
  type DiscordUploadCompleteResponse,
} from "@okouai/api-contracts/contracts/integrations-discord-files";
import type {
  CanonicalAssetDeliveryError,
  CanonicalAssetDiscordDeliveryDestination,
  CanonicalAssetDiscordDeliveryState,
  RunUploadedFileMetadata,
} from "@okouai/db/jsonb-contracts/run-uploaded-file";
import {
  CANONICAL_ASSET_VERSION,
  canonicalAssetDeliveries,
  runUploadedFiles,
  type CanonicalAssetMaterializationStatus,
} from "@okouai/db/schema/run-uploaded-file";
import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { discordMessageUrl } from "../../lib/discord-message";
import { now, nowDate } from "../../lib/time";
import { type Db, writeDb$ } from "../external/db";
import { discordClient, type DiscordMessage } from "../external/discord-client";
import {
  downloadS3BufferWithMaxBytes,
  S3ObjectSizeLimitError,
} from "../external/s3";
import { settle } from "../utils";
import { materializeCanonicalPublishedAsset$ } from "./canonical-asset.service";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import {
  discordApiFailure,
  discordUnavailable,
  type DiscordFailureResponse,
} from "./discord-api-response";
import { artifactStorageBucket } from "./private-artifact-storage.service";

interface DiscordDeliveryIdentity {
  readonly assetId: string;
  readonly operationId: string;
  readonly runId: string | null;
  readonly userId: string;
  readonly orgId: string;
}

interface DiscordDeliveryRow {
  readonly id: string;
  readonly assetId: string;
  readonly operationId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly storageKey: string;
  readonly metadata: RunUploadedFileMetadata;
  readonly materializationStatus: CanonicalAssetMaterializationStatus;
  readonly assetUrl: string | null;
  readonly status: "pending" | "delivered" | "failed";
  readonly destination: CanonicalAssetDiscordDeliveryDestination;
  readonly providerState: CanonicalAssetDiscordDeliveryState;
  readonly externalId: string | null;
  readonly deliveryUrl: string | null;
  readonly lastError: CanonicalAssetDeliveryError | null;
}

interface DiscordDeliveryOperation {
  readonly identity: DiscordDeliveryIdentity;
  readonly row: DiscordDeliveryRow;
}

interface DiscordDeliveryRetry {
  readonly safeToRetrySend: boolean;
  readonly retryNotBeforeMs?: number;
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

function unavailableDelivery(): DiscordDeliveryFailure {
  return { ok: false, response: discordUnavailable() };
}

function invalidFile(message: string): DiscordDeliveryFailure {
  return {
    ok: false,
    response: {
      status: 400,
      body: { error: { code: "INVALID_FILE", message } },
    },
  };
}

async function loadDelivery(
  db: Db,
  args: DiscordDeliveryIdentity,
  signal: AbortSignal,
): Promise<DiscordDeliveryRow | undefined> {
  const [row] = await db
    .select({
      id: canonicalAssetDeliveries.id,
      assetId: runUploadedFiles.id,
      operationId: canonicalAssetDeliveries.operationId,
      filename: runUploadedFiles.filename,
      contentType: runUploadedFiles.contentType,
      sizeBytes: runUploadedFiles.sizeBytes,
      checksumSha256: runUploadedFiles.checksumSha256,
      storageKey: runUploadedFiles.storageKey,
      metadata: runUploadedFiles.metadata,
      materializationStatus: runUploadedFiles.materializationStatus,
      assetUrl: runUploadedFiles.url,
      status: canonicalAssetDeliveries.status,
      destination: canonicalAssetDeliveries.destination,
      providerState: canonicalAssetDeliveries.providerState,
      externalId: canonicalAssetDeliveries.externalId,
      deliveryUrl: canonicalAssetDeliveries.url,
      lastError: canonicalAssetDeliveries.lastError,
    })
    .from(canonicalAssetDeliveries)
    .innerJoin(
      runUploadedFiles,
      eq(runUploadedFiles.id, canonicalAssetDeliveries.assetId),
    )
    .where(
      and(
        eq(runUploadedFiles.id, args.assetId),
        eq(runUploadedFiles.userId, args.userId),
        eq(runUploadedFiles.orgId, args.orgId),
        args.runId === null
          ? isNull(runUploadedFiles.runId)
          : eq(runUploadedFiles.runId, args.runId),
        eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
        eq(runUploadedFiles.classification, "published-output"),
        eq(runUploadedFiles.idempotencyKey, args.operationId),
        eq(canonicalAssetDeliveries.provider, "discord"),
        eq(canonicalAssetDeliveries.operationId, args.operationId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row) {
    return undefined;
  }
  if (
    row.destination.provider !== "discord" ||
    row.providerState?.provider !== "discord" ||
    !row.filename ||
    !row.contentType ||
    row.sizeBytes === null ||
    !row.checksumSha256 ||
    !row.storageKey ||
    !row.materializationStatus
  ) {
    throw new Error("Canonical Discord delivery metadata is incomplete");
  }
  return {
    ...row,
    destination: row.destination,
    providerState: row.providerState,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    storageKey: row.storageKey,
    materializationStatus: row.materializationStatus,
  };
}

const authorizeDelivery$ = command(
  async (
    { set },
    args: DiscordDeliveryIdentity,
    row: DiscordDeliveryRow,
    signal: AbortSignal,
  ) => {
    const access = await set(
      requireDiscordConversationAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        guildId: row.destination.guildId,
        channelId: row.destination.channelId,
        mode: "write",
        attachFiles: true,
      },
      signal,
    );
    if (access.kind === "denied") {
      return { ok: false, response: access.response } as const;
    }
    if (access.binding.connectionId !== row.destination.connectionId) {
      return unavailableDelivery();
    }
    return { ok: true, access } as const;
  },
);

function deliveryState(
  row: DiscordDeliveryRow,
): DiscordUploadCompleteResponse["delivery"] {
  if (row.status === "delivered") {
    if (
      !row.externalId ||
      !row.deliveryUrl ||
      !row.providerState.attachmentId
    ) {
      throw new Error("Delivered Discord asset is missing its receipt");
    }
    return {
      status: "delivered",
      channelId: row.destination.channelId,
      messageId: row.externalId,
      attachmentId: row.providerState.attachmentId,
      permalink: row.deliveryUrl,
    };
  }
  if (row.status === "failed") {
    if (!row.lastError) {
      throw new Error("Failed Discord delivery is missing its failure reason");
    }
    return {
      status: "failed",
      message: row.lastError.message,
      retryable: row.lastError.retryable,
      ...(row.providerState.retryNotBeforeMs === undefined
        ? {}
        : {
            retryAfterSeconds: Math.ceil(
              Math.max(0, row.providerState.retryNotBeforeMs - now()) / 1000,
            ),
          }),
    };
  }
  return { status: "pending" };
}

function deliveryResult(row: DiscordDeliveryRow): DiscordDeliveryResult {
  if (!row.assetUrl || row.materializationStatus !== "ready") {
    return invalidFile("Publish the canonical file before Discord delivery");
  }
  return {
    ok: true,
    assetId: row.assetId,
    operationId: row.operationId,
    url: row.assetUrl,
    delivery: deliveryState(row),
  };
}

const verifiedFileBytes$ = command(
  async ({ get }, row: DiscordDeliveryRow, signal: AbortSignal) => {
    if (row.sizeBytes < 1 || row.sizeBytes > MAX_DISCORD_FILE_SIZE_BYTES) {
      return invalidFile("File exceeds the Discord upload size limit");
    }
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          artifactStorageBucket(row.metadata),
          row.storageKey,
          MAX_DISCORD_FILE_SIZE_BYTES,
          signal,
        ),
      ),
      signal,
    );
    if (!downloaded.ok) {
      if (downloaded.error instanceof S3ObjectSizeLimitError) {
        return invalidFile("File exceeds the Discord upload size limit");
      }
      return {
        ok: false,
        response: {
          status: 502,
          body: {
            error: {
              code: "STORAGE_UNAVAILABLE",
              message:
                "Could not read the canonical upload. Retry this operation.",
            },
          },
        },
      } as const;
    }
    const bytes = downloaded.value;
    if (
      bytes.byteLength !== row.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== row.checksumSha256
    ) {
      return invalidFile(
        "Uploaded bytes do not match the declared size and checksum",
      );
    }
    return { ok: true, bytes } as const;
  },
);

export const materializeCanonicalDiscordAsset$ = command(
  async (
    { set },
    args: DiscordDeliveryIdentity,
    signal: AbortSignal,
  ): Promise<DiscordDeliveryResult> => {
    const db = set(writeDb$);
    const row = await loadDelivery(db, args, signal);
    if (!row) {
      return unavailableDelivery();
    }
    const authorized = await set(authorizeDelivery$, args, row, signal);
    if (!authorized.ok) {
      return authorized;
    }
    if (row.materializationStatus !== "ready") {
      const verified = await set(verifiedFileBytes$, row, signal);
      if (!verified.ok) {
        return verified;
      }
    }
    const materialized = await set(
      materializeCanonicalPublishedAsset$,
      args,
      signal,
    );
    if (!materialized.ok) {
      return materialized.code === "NOT_FOUND"
        ? unavailableDelivery()
        : invalidFile(materialized.message);
    }
    const current = await loadDelivery(db, args, signal);
    return current ? deliveryResult(current) : unavailableDelivery();
  },
);

function transitionCondition(row: DiscordDeliveryRow) {
  return and(
    eq(canonicalAssetDeliveries.id, row.id),
    eq(canonicalAssetDeliveries.providerState, row.providerState),
    ne(canonicalAssetDeliveries.status, "delivered"),
  );
}

async function currentDeliveryResult(
  db: Db,
  args: DiscordDeliveryIdentity,
  signal: AbortSignal,
): Promise<DiscordDeliveryResult> {
  const current = await loadDelivery(db, args, signal);
  return current ? deliveryResult(current) : unavailableDelivery();
}

async function markFailed(
  db: Db,
  { identity, row }: DiscordDeliveryOperation,
  failure: CanonicalAssetDeliveryError,
  retry: DiscordDeliveryRetry,
  signal: AbortSignal,
): Promise<DiscordDeliveryResult> {
  await db
    .update(canonicalAssetDeliveries)
    .set({
      status: "failed",
      lastError: failure,
      providerState: retry.safeToRetrySend
        ? {
            provider: "discord",
            nonce: row.providerState.nonce,
            attempt: null,
            ...(retry.retryNotBeforeMs === undefined
              ? {}
              : { retryNotBeforeMs: retry.retryNotBeforeMs }),
          }
        : row.providerState,
      updatedAt: sql`now()`,
    })
    .where(transitionCondition(row));
  signal.throwIfAborted();
  return await currentDeliveryResult(db, identity, signal);
}

const uncertainDeliveryError: CanonicalAssetDeliveryError = Object.freeze({
  code: "discord-delivery-uncertain",
  message:
    "Discord delivery outcome is uncertain. Retry this same upload operation to reconcile it.",
  retryable: false,
});

function discordSendFailure(result: {
  readonly status: number;
  readonly retryAfterMs?: number;
}): {
  readonly error: CanonicalAssetDeliveryError;
  readonly retry: DiscordDeliveryRetry;
} {
  const rejected =
    result.status >= 400 && result.status < 500 && result.status !== 408;
  if (!rejected) {
    return { error: uncertainDeliveryError, retry: { safeToRetrySend: false } };
  }
  let retryNotBeforeMs: number | undefined;
  if (
    result.status === 429 &&
    result.retryAfterMs !== undefined &&
    result.retryAfterMs > 0
  ) {
    retryNotBeforeMs = now() + Math.ceil(result.retryAfterMs);
    if (!Number.isSafeInteger(retryNotBeforeMs)) {
      return {
        error: {
          code: "discord-retry-delay-unsupported",
          message:
            "Discord returned an unsupported retry delay. Delivery is blocked for this operation.",
          retryable: false,
        },
        retry: { safeToRetrySend: true },
      };
    }
  }
  return {
    error: {
      code: "discord-send-rejected",
      message: "Discord rejected the file delivery",
      retryable: result.status === 429,
    },
    retry: {
      safeToRetrySend: true,
      ...(retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs }),
    },
  };
}

function deliveredAttachment(
  message: DiscordMessage,
  row: DiscordDeliveryRow,
  botUserId: string,
) {
  if (
    message.channel_id !== row.destination.channelId ||
    message.author.id !== botUserId
  ) {
    return undefined;
  }
  return message.attachments.find((attachment) => {
    return (
      attachment.filename === row.filename && attachment.size === row.sizeBytes
    );
  });
}

async function recordDelivered(
  db: Db,
  { identity, row }: DiscordDeliveryOperation,
  message: DiscordMessage,
  context: { readonly botUserId: string; readonly guildId: string | undefined },
  signal: AbortSignal,
): Promise<DiscordDeliveryResult> {
  const attachment = deliveredAttachment(message, row, context.botUserId);
  if (!attachment) {
    return await markFailed(
      db,
      { identity, row },
      uncertainDeliveryError,
      { safeToRetrySend: false },
      signal,
    );
  }
  await db
    .update(canonicalAssetDeliveries)
    .set({
      status: "delivered",
      externalId: message.id,
      url: discordMessageUrl({
        guildId: context.guildId,
        channelId: message.channel_id,
        messageId: message.id,
      }),
      providerState: { ...row.providerState, attachmentId: attachment.id },
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(transitionCondition(row));
  signal.throwIfAborted();
  return await currentDeliveryResult(db, identity, signal);
}

async function reconcileAttempt(
  db: Db,
  args: DiscordDeliveryIdentity,
  row: DiscordDeliveryRow,
  context: {
    readonly botToken: string;
    readonly botUserId: string;
    readonly guildId: string | undefined;
  },
  signal: AbortSignal,
): Promise<DiscordDeliveryResult> {
  const attempt = row.providerState.attempt;
  if (!attempt) {
    throw new Error("Discord reconciliation is missing its persisted attempt");
  }
  const earliest = Date.parse(attempt.startedAt) - 60_000;
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const history = await discordClient.fetchDiscordMessages(
      {
        botToken: context.botToken,
        channelId: row.destination.channelId,
        before,
        limit: 100,
      },
      signal,
    );
    if (history.kind !== "ok") {
      return { ok: false, response: discordApiFailure(history) };
    }
    const matching = history.data.find((message) => {
      return (
        message.nonce === row.providerState.nonce &&
        deliveredAttachment(message, row, context.botUserId) !== undefined
      );
    });
    if (matching) {
      return await recordDelivered(
        db,
        { identity: args, row },
        matching,
        context,
        signal,
      );
    }
    const oldest = history.data.reduce<DiscordMessage | undefined>(
      (current, message) => {
        return !current || BigInt(message.id) < BigInt(current.id)
          ? message
          : current;
      },
      undefined,
    );
    if (
      history.data.length < 100 ||
      !oldest ||
      Date.parse(oldest.timestamp) < earliest
    ) {
      break;
    }
    before = oldest.id;
  }
  // Discord's nonce deduplication has a short retention window. Absence from a
  // bounded history read never proves a failed send, so this path cannot resend.
  if (
    row.status === "pending" &&
    now() - Date.parse(attempt.startedAt) < 60_000
  ) {
    return await currentDeliveryResult(db, args, signal);
  }
  return await markFailed(
    db,
    { identity: args, row },
    uncertainDeliveryError,
    { safeToRetrySend: false },
    signal,
  );
}

async function claimDeliveryAttempt(
  db: Db,
  row: DiscordDeliveryRow,
  signal: AbortSignal,
): Promise<DiscordDeliveryRow | undefined> {
  const providerState: CanonicalAssetDiscordDeliveryState = {
    provider: "discord",
    nonce: row.providerState.nonce,
    attempt: { id: randomUUID(), startedAt: nowDate().toISOString() },
  };
  const [claimed] = await db
    .update(canonicalAssetDeliveries)
    .set({
      providerState,
      status: "pending",
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(transitionCondition(row))
    .returning({ id: canonicalAssetDeliveries.id });
  signal.throwIfAborted();
  return claimed
    ? { ...row, providerState, status: "pending", lastError: null }
    : undefined;
}

export const completeCanonicalDiscordDelivery$ = command(
  async (
    { set },
    args: DiscordDeliveryIdentity,
    signal: AbortSignal,
  ): Promise<DiscordDeliveryResult> => {
    const db = set(writeDb$);
    const row = await loadDelivery(db, args, signal);
    if (!row) {
      return unavailableDelivery();
    }
    const authorized = await set(authorizeDelivery$, args, row, signal);
    if (!authorized.ok) {
      return authorized;
    }
    if (row.materializationStatus !== "ready") {
      return invalidFile("Publish the canonical file before Discord delivery");
    }
    if (row.status === "delivered") {
      return deliveryResult(row);
    }
    const context = {
      botToken: authorized.access.botToken,
      botUserId: authorized.access.binding.botUserId,
      guildId: authorized.access.channel.guild_id,
    };
    if (row.providerState.attempt) {
      return await reconcileAttempt(db, args, row, context, signal);
    }
    if (row.status === "failed" && !row.lastError?.retryable) {
      return deliveryResult(row);
    }
    if (
      row.providerState.retryNotBeforeMs !== undefined &&
      now() < row.providerState.retryNotBeforeMs
    ) {
      return deliveryResult(row);
    }
    const verified = await set(verifiedFileBytes$, row, signal);
    if (!verified.ok) {
      return verified;
    }
    const attemptRow = await claimDeliveryAttempt(db, row, signal);
    if (!attemptRow) {
      return await currentDeliveryResult(db, args, signal);
    }
    // Recheck after storage I/O and the durable claim, immediately before send.
    const sendAccess = await set(authorizeDelivery$, args, attemptRow, signal);
    if (!sendAccess.ok) {
      await markFailed(
        db,
        { identity: args, row: attemptRow },
        {
          code: "discord-access-denied",
          message: "Discord destination is no longer available",
          retryable: true,
        },
        { safeToRetrySend: true },
        signal,
      );
      return sendAccess;
    }
    const sent = await settle(
      discordClient.createDiscordMessage(
        {
          botToken: sendAccess.access.botToken,
          channelId: row.destination.channelId,
          content: row.destination.comment ?? "",
          nonce: attemptRow.providerState.nonce,
          files: [
            {
              filename: row.filename,
              data: new Blob([new Uint8Array(verified.bytes)], {
                type: row.contentType,
              }),
            },
          ],
        },
        signal,
      ),
      signal,
    );
    if (!sent.ok) {
      return await markFailed(
        db,
        { identity: args, row: attemptRow },
        uncertainDeliveryError,
        { safeToRetrySend: false },
        signal,
      );
    }
    if (sent.value.kind === "ok") {
      return await recordDelivered(
        db,
        { identity: args, row: attemptRow },
        sent.value.data,
        {
          botUserId: sendAccess.access.binding.botUserId,
          guildId: sendAccess.access.channel.guild_id,
        },
        signal,
      );
    }
    const failure = discordSendFailure(sent.value);
    return await markFailed(
      db,
      { identity: args, row: attemptRow },
      failure.error,
      failure.retry,
      signal,
    );
  },
);
