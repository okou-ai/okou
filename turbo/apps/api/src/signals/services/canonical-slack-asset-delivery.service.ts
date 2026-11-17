import { appendIntegrationMessageFooter } from "../../lib/integration-message-footer";
import { resolveSlackMessageSendFooter$ } from "./slack-message-context.service";
import { command } from "ccstate";
import { createHash } from "node:crypto";
import { artifactStorageBucket } from "./private-artifact-storage.service";
import { downloadS3BufferWithMaxBytes$ } from "../external/s3";
import { MAX_SLACK_FILE_SIZE_BYTES } from "../external/slack-file-fetcher";
import { uploadSlackFileBytes } from "../external/slack-file-upload";
import type { SlackUploadDeliveryResponse } from "@okouai/api-contracts/contracts/integrations";
import type { CanonicalAssetSlackDeliveryDestination } from "@okouai/db/jsonb-contracts/run-uploaded-file";
import {
  CANONICAL_ASSET_VERSION,
  canonicalAssetDeliveries,
  runUploadedFiles,
} from "@okouai/db/schema/run-uploaded-file";
import { and, eq, isNull, ne, sql, type SQL } from "drizzle-orm";

import type { SlackClient } from "../external/slack-message-client";
import { writeDb$ } from "../external/db";
import { settle, settleIncludingAbort } from "../utils";
import { resolveSlackWriteTarget$ } from "./slack-write-access.service";

interface CanonicalSlackDeliveryRow {
  readonly assetId: string;
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly assetUrl: string | null;
  readonly storageKey: string | null;
  readonly checksumSha256: string | null;
  readonly metadata: typeof runUploadedFiles.$inferSelect.metadata;
  readonly operationId: string;
  readonly status: "pending" | "delivered" | "failed";
  readonly destination: CanonicalAssetSlackDeliveryDestination;
  readonly externalId: string | null;
  readonly deliveryUrl: string | null;
  readonly lastError: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

type CompletedCanonicalSlackDeliveryResult =
  SlackUploadDeliveryResponse["delivery"];

type CanonicalSlackDeliveryResult =
  | {
      readonly status: "pending";
      readonly uploadUrl: string;
      readonly fileId: string;
    }
  | CompletedCanonicalSlackDeliveryResult;

type SlackDeliveryReadResult = CanonicalSlackDeliveryRow | undefined;

type RawSlackDeliveryRow = Omit<CanonicalSlackDeliveryRow, "destination"> &
  Pick<typeof canonicalAssetDeliveries.$inferSelect, "destination">;

type SlackDeliveryConflictRow = Pick<
  CanonicalSlackDeliveryRow,
  "status" | "externalId" | "deliveryUrl" | "lastError"
>;

function requiredSlackFileId(externalId: string | null): string {
  if (!externalId) {
    throw new Error("Delivered Slack asset is missing its external file ID");
  }
  return externalId;
}

function requiredSlackPermalink(deliveryUrl: string | null): string {
  if (!deliveryUrl) {
    throw new Error("Delivered Slack asset is missing its permalink");
  }
  return deliveryUrl;
}

function deliveredResult(
  row: CanonicalSlackDeliveryRow,
): CompletedCanonicalSlackDeliveryResult {
  return {
    status: "delivered",
    fileId: requiredSlackFileId(row.externalId),
    permalink: requiredSlackPermalink(row.deliveryUrl),
  };
}

function providerFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Slack request failed";
}

interface CanonicalSlackDeliveryFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

function resolveSlackFilePermalink(
  info: Awaited<ReturnType<SlackClient["getFileInfo"]>>,
):
  | { readonly ok: true; readonly permalink: string }
  | { readonly ok: false; readonly error: CanonicalSlackDeliveryFailure } {
  if (info.kind === "slack_error") {
    return {
      ok: false,
      error: {
        code: info.error,
        message: `Slack delivery failed: ${info.error}`,
        retryable: true,
      },
    };
  }
  const permalink = info.file?.permalink;
  if (!permalink) {
    return {
      ok: false,
      error: {
        code: "missing_permalink",
        message: "Slack file info did not include a permalink",
        retryable: true,
      },
    };
  }
  return { ok: true, permalink };
}

function sharedSlackFileResult(
  info: Awaited<ReturnType<SlackClient["getFileInfo"]>>,
  row: CanonicalSlackDeliveryRow,
) {
  const permalink = resolveSlackFilePermalink(info);
  if (!permalink.ok) {
    return permalink;
  }
  if (
    info.kind !== "ok" ||
    info.file?.id !== row.externalId ||
    // Slack can strip image metadata after accepting the verified upload bytes.
    typeof info.file.size !== "number" ||
    info.file.size <= 0 ||
    ![
      ...(info.file.channels ?? []),
      ...(info.file.groups ?? []),
      ...(info.file.ims ?? []),
    ].includes(row.destination.channelId)
  ) {
    return {
      ok: false as const,
      error: {
        code: "slack-file-not-shared",
        message: "Slack has not confirmed the uploaded file in its destination",
        retryable: true,
      },
    };
  }
  return permalink;
}

function failedResult(
  error: CanonicalSlackDeliveryFailure,
): Extract<CompletedCanonicalSlackDeliveryResult, { status: "failed" }> {
  return {
    status: "failed",
    message: error.message,
    retryable: error.retryable,
  };
}

function deliveryIdentityCondition(row: CanonicalSlackDeliveryRow): SQL {
  return and(
    eq(canonicalAssetDeliveries.assetId, row.assetId),
    eq(canonicalAssetDeliveries.provider, "slack"),
    eq(canonicalAssetDeliveries.operationId, row.operationId),
  )!;
}

function deliveryExternalIdCondition(externalId: string | null): SQL {
  return externalId === null
    ? isNull(canonicalAssetDeliveries.externalId)
    : eq(canonicalAssetDeliveries.externalId, externalId);
}

function deliveryTransitionCondition(row: CanonicalSlackDeliveryRow): SQL {
  return and(
    deliveryIdentityCondition(row),
    deliveryExternalIdCondition(row.externalId),
    ne(canonicalAssetDeliveries.status, "delivered"),
  )!;
}

function validatedSlackDeliveryRow(
  row: RawSlackDeliveryRow | undefined,
): SlackDeliveryReadResult {
  if (!row) {
    return undefined;
  }
  if (row.destination.provider !== undefined) {
    throw new Error("Slack delivery has a Discord destination");
  }
  return { ...row, destination: row.destination };
}

function slackConflictSelection() {
  return {
    status: canonicalAssetDeliveries.status,
    externalId: canonicalAssetDeliveries.externalId,
    deliveryUrl: canonicalAssetDeliveries.url,
    lastError: canonicalAssetDeliveries.lastError,
  };
}

function conflictDeliveryResult(
  current: SlackDeliveryConflictRow | undefined,
): CompletedCanonicalSlackDeliveryResult {
  if (current?.status === "delivered") {
    return {
      status: "delivered",
      fileId: requiredSlackFileId(current.externalId),
      permalink: requiredSlackPermalink(current.deliveryUrl),
    };
  }
  if (current?.status === "failed" && current.lastError) {
    return failedResult(current.lastError);
  }
  return failedResult({
    code: "delivery-attempt-in-progress",
    message: "Another Slack delivery attempt is already in progress",
    retryable: true,
  });
}

function deliveredUpdateFields(deliveryUrl: string) {
  return {
    status: "delivered" as const,
    url: deliveryUrl,
    lastError: null,
    updatedAt: sql`now()`,
  };
}

function successfulDeliveryResult(
  fileId: string,
  deliveryUrl: string,
): CompletedCanonicalSlackDeliveryResult {
  return {
    status: "delivered",
    fileId,
    permalink: deliveryUrl,
  };
}

function slackDeliverySelection() {
  return {
    assetId: runUploadedFiles.id,
    filename: runUploadedFiles.filename,
    sizeBytes: runUploadedFiles.sizeBytes,
    assetUrl: runUploadedFiles.url,
    storageKey: runUploadedFiles.storageKey,
    checksumSha256: runUploadedFiles.checksumSha256,
    metadata: runUploadedFiles.metadata,
    operationId: canonicalAssetDeliveries.operationId,
    status: canonicalAssetDeliveries.status,
    destination: canonicalAssetDeliveries.destination,
    externalId: canonicalAssetDeliveries.externalId,
    deliveryUrl: canonicalAssetDeliveries.url,
    lastError: canonicalAssetDeliveries.lastError,
  };
}

interface PreparedSlackFile {
  readonly uploadUrl: string;
  readonly fileId: string;
}

interface SlackCompletionRequest {
  readonly fileId: string;
  readonly channel: string;
  readonly threadTs?: string;
  readonly title?: string;
  readonly initialComment?: string;
}

function slackDeliveryAssetJoin(): SQL {
  return eq(runUploadedFiles.id, canonicalAssetDeliveries.assetId);
}

function failedUpdateFields(error: CanonicalSlackDeliveryFailure): {
  readonly status: "failed";
  readonly lastError: CanonicalSlackDeliveryFailure;
  readonly updatedAt: SQL;
} {
  return {
    status: "failed",
    lastError: error,
    updatedAt: sql`now()`,
  };
}

function slackRequestFailure(error: unknown): CanonicalSlackDeliveryFailure {
  return {
    code: "slack-request-failed",
    message: providerFailureMessage(error),
    retryable: true,
  };
}

function slackUploadFailure(error: unknown): CanonicalSlackDeliveryFailure {
  return { ...slackRequestFailure(error), code: "slack-upload-failed" };
}

function missingAssetMetadataFailure(): CanonicalSlackDeliveryFailure {
  return {
    code: "asset-metadata-missing",
    message: "Canonical asset metadata is incomplete",
    retryable: false,
  };
}

function slackProviderFailure(result: {
  readonly error: string;
}): CanonicalSlackDeliveryFailure {
  return {
    code: result.error,
    message: `Slack delivery failed: ${result.error}`,
    retryable: true,
  };
}

function isUnuploadedSlackFile(result: { readonly error: string }): boolean {
  return result.error === "file_not_found" || result.error === "no_file_data";
}

function slackCompletionRequest(
  fileId: string,
  row: Pick<CanonicalSlackDeliveryRow, "destination">,
  footerText?: string,
): SlackCompletionRequest {
  return {
    fileId,
    channel: row.destination.channelId,
    threadTs: row.destination.threadTs,
    title: row.destination.title,
    initialComment: footerText
      ? appendIntegrationMessageFooter(
          row.destination.initialComment,
          footerText,
        )
      : row.destination.initialComment,
  };
}

function slackUploadRequest(
  filename: string,
  length: number,
): { readonly filename: string; readonly length: number } {
  return { filename, length };
}

function preparedUpdateFields(prepared: PreparedSlackFile): {
  readonly status: "pending";
  readonly externalId: string;
  readonly url: null;
  readonly lastError: null;
  readonly updatedAt: SQL;
} {
  return {
    status: "pending",
    externalId: prepared.fileId,
    url: null,
    lastError: null,
    updatedAt: sql`now()`,
  };
}

function pendingDeliveryResult(
  prepared: PreparedSlackFile,
): CanonicalSlackDeliveryResult {
  return {
    status: "pending",
    uploadUrl: prepared.uploadUrl,
    fileId: prepared.fileId,
  };
}

interface PrepareCanonicalSlackDeliveryArgs {
  readonly assetId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly serverTransfer?: boolean;
}

function slackDeliveryReadCondition(
  args: Readonly<
    Pick<
      PrepareCanonicalSlackDeliveryArgs,
      "assetId" | "runId" | "userId" | "orgId" | "operationId"
    >
  >,
): SQL | undefined {
  return and(
    eq(runUploadedFiles.id, args.assetId),
    eq(runUploadedFiles.runId, args.runId),
    eq(runUploadedFiles.userId, args.userId),
    eq(runUploadedFiles.orgId, args.orgId),
    eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
    eq(runUploadedFiles.classification, "published-output"),
    eq(runUploadedFiles.materializationStatus, "ready"),
    eq(canonicalAssetDeliveries.provider, "slack"),
    eq(canonicalAssetDeliveries.operationId, args.operationId),
  );
}

const readCanonicalSlackConflict$ = command(
  async (
    { set },
    row: CanonicalSlackDeliveryRow,
  ): Promise<CompletedCanonicalSlackDeliveryResult> => {
    const [current] = await set(writeDb$)
      .select(slackConflictSelection())
      .from(canonicalAssetDeliveries)
      .where(deliveryIdentityCondition(row))
      .limit(1);
    return conflictDeliveryResult(current);
  },
);

const recordCanonicalSlackFailure$ = command(
  async (
    { set },
    row: CanonicalSlackDeliveryRow,
    error: CanonicalSlackDeliveryFailure,
  ): Promise<CompletedCanonicalSlackDeliveryResult> => {
    const [failed] = await set(writeDb$)
      .update(canonicalAssetDeliveries)
      .set(failedUpdateFields(error))
      .where(deliveryTransitionCondition(row))
      .returning({ id: canonicalAssetDeliveries.id });
    return failed
      ? failedResult(error)
      : await set(readCanonicalSlackConflict$, row);
  },
);

const reserveCanonicalSlackUpload$ = command(
  async (
    { set },
    row: CanonicalSlackDeliveryRow,
    prepared: PreparedSlackFile,
    signal: AbortSignal,
  ): Promise<CanonicalSlackDeliveryResult> => {
    const [reserved] = await set(writeDb$)
      .update(canonicalAssetDeliveries)
      .set(preparedUpdateFields(prepared))
      .where(deliveryTransitionCondition(row))
      .returning({ id: canonicalAssetDeliveries.id });
    if (signal.aborted) {
      if (reserved) {
        await set(
          recordCanonicalSlackFailure$,
          { ...row, externalId: prepared.fileId },
          slackUploadFailure(signal.reason),
        );
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
    }
    if (!reserved) {
      return await set(readCanonicalSlackConflict$, row);
    }
    return pendingDeliveryResult(prepared);
  },
);

const resolveCanonicalSlackDelivery$ = command(
  async (
    { set },
    args: Pick<
      PrepareCanonicalSlackDeliveryArgs,
      "orgId" | "userId" | "runId"
    > & {
      destination: CanonicalSlackDeliveryRow["destination"];
    },
    signal: AbortSignal,
  ) => {
    const access = await set(
      resolveSlackWriteTarget$,
      {
        runId: args.runId,
        workspaceId: args.destination.workspaceId,
        orgId: args.orgId,
        userId: args.userId,
        channel: args.destination.channelId,
        threadTs: args.destination.threadTs,
      },
      signal,
    );
    return "status" in access
      ? failedResult({
          code: "slack-access-denied",
          message: access.body.error.message,
          retryable: access.body.error.code === "SLACK_ERROR",
        })
      : access;
  },
);

// Record a provider-accepted receipt before observing caller cancellation.
const recordReconciledSlackDelivery$ = command(
  async (
    { set },
    row: CanonicalSlackDeliveryRow,
    permalink: string,
  ): Promise<CompletedCanonicalSlackDeliveryResult> => {
    const db = set(writeDb$);
    const fileId = requiredSlackFileId(row.externalId);
    const deliveryUrl = requiredSlackPermalink(permalink);
    const [delivered] = await db
      .update(canonicalAssetDeliveries)
      .set(deliveredUpdateFields(deliveryUrl))
      .where(deliveryTransitionCondition(row))
      .returning({ id: canonicalAssetDeliveries.id });
    return delivered
      ? successfulDeliveryResult(fileId, deliveryUrl)
      : await set(readCanonicalSlackConflict$, row);
  },
);

export const prepareCanonicalSlackDelivery$ = command(
  async (
    { set },
    args: PrepareCanonicalSlackDeliveryArgs,
    signal: AbortSignal,
  ): Promise<CanonicalSlackDeliveryResult | null> => {
    const db = set(writeDb$);
    const [persisted] = await db
      .select(slackDeliverySelection())
      .from(canonicalAssetDeliveries)
      .innerJoin(runUploadedFiles, slackDeliveryAssetJoin())
      .where(slackDeliveryReadCondition(args))
      .limit(1);
    signal.throwIfAborted();
    const row = validatedSlackDeliveryRow(persisted);
    if (!row) {
      return null;
    }
    if (row.status === "delivered") {
      return deliveredResult(row);
    }
    const access = await set(
      resolveCanonicalSlackDelivery$,
      { ...args, destination: row.destination },
      signal,
    );
    if ("status" in access) {
      return access;
    }

    const recordPreparationFailure = (error: CanonicalSlackDeliveryFailure) => {
      return set(recordCanonicalSlackFailure$, row, error);
    };

    const reconcileExistingSlackFile = async () => {
      if (!row.externalId || row.lastError?.code === "slack-upload-failed") {
        return null;
      }

      const currentInfo = await client.getFileInfo(row.externalId);
      const shared = sharedSlackFileResult(currentInfo, row);
      if (shared.ok) {
        return await set(recordReconciledSlackDelivery$, row, shared.permalink);
      }
      if (row.status === "pending" && args.serverTransfer) {
        return conflictDeliveryResult(row);
      }
      if (
        currentInfo.kind === "slack_error" &&
        isUnuploadedSlackFile(currentInfo)
      ) {
        return null;
      }
      // A reservation/permalink does not establish that bytes reached Slack.
      if (
        currentInfo.kind !== "ok" ||
        !currentInfo.file?.url_private_download
      ) {
        return await recordPreparationFailure(shared.error);
      }
      const completed = await client.completeUploadExternal(
        slackCompletionRequest(row.externalId, row, footerText),
      );
      if (completed.kind === "slack_error") {
        if (isUnuploadedSlackFile(completed)) {
          return null;
        }
        return await recordPreparationFailure(slackProviderFailure(completed));
      }
      const info = await client.getFileInfo(row.externalId);
      const permalinkResult = sharedSlackFileResult(info, row);
      if (!permalinkResult.ok) {
        return await recordPreparationFailure(permalinkResult.error);
      }
      return await set(
        recordReconciledSlackDelivery$,
        row,
        permalinkResult.permalink,
      );
    };
    const client = access.client;
    const footerText = await set(
      resolveSlackMessageSendFooter$,
      access.workspaceId,
      signal,
    );
    const reconciliation = await settle(reconcileExistingSlackFile(), signal);
    signal.throwIfAborted();
    if (!reconciliation.ok) {
      return await recordPreparationFailure(
        slackRequestFailure(reconciliation.error),
      );
    }
    const reconciled = reconciliation.value;
    if (reconciled) {
      return reconciled;
    }
    if (!row.filename || row.sizeBytes === null) {
      return await recordPreparationFailure(missingAssetMetadataFailure());
    }

    const preparation = await settle(
      client.getUploadUrlExternal(
        slackUploadRequest(row.filename, row.sizeBytes),
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!preparation.ok) {
      return await recordPreparationFailure(
        slackRequestFailure(preparation.error),
      );
    }
    const prepared = preparation.value;
    if (prepared.kind === "slack_error") {
      return await recordPreparationFailure(slackProviderFailure(prepared));
    }

    return await set(
      reserveCanonicalSlackUpload$,
      row,
      { uploadUrl: prepared.uploadUrl, fileId: prepared.fileId },
      signal,
    );
  },
);

interface CompleteCanonicalSlackDeliveryArgs {
  readonly assetId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly fileId: string;
  readonly uploadError?: string;
  readonly verifySharedFile?: boolean;
}

/**
 * Completes a canonical Slack delivery to its persisted destination and
 * reports that destination's channel alongside the delivery result.
 */
export const completeCanonicalSlackDelivery$ = command(
  async (
    { set },
    args: CompleteCanonicalSlackDeliveryArgs,
    signal: AbortSignal,
  ): Promise<
    | (CompletedCanonicalSlackDeliveryResult & { readonly channelId: string })
    | null
  > => {
    const db = set(writeDb$);
    const [persisted] = await db
      .select(slackDeliverySelection())
      .from(canonicalAssetDeliveries)
      .innerJoin(
        runUploadedFiles,
        eq(runUploadedFiles.id, canonicalAssetDeliveries.assetId),
      )
      .where(slackDeliveryReadCondition(args))
      .limit(1);
    signal.throwIfAborted();
    const row = validatedSlackDeliveryRow(persisted);
    if (!row) {
      return null;
    }
    if (row.status === "delivered") {
      return { ...deliveredResult(row), channelId: row.destination.channelId };
    }
    if (row.externalId !== args.fileId) {
      const conflict = await set(readCanonicalSlackConflict$, row);
      signal.throwIfAborted();
      return { ...conflict, channelId: row.destination.channelId };
    }
    const access = await set(
      resolveCanonicalSlackDelivery$,
      { ...args, destination: row.destination },
      signal,
    );
    if ("status" in access) {
      const failed = await set(recordCanonicalSlackFailure$, row, {
        code: "slack-access-denied",
        message: access.message,
        retryable: access.retryable,
      });
      signal.throwIfAborted();
      return { ...failed, channelId: row.destination.channelId };
    }
    const client = access.client;
    const footerText = await set(
      resolveSlackMessageSendFooter$,
      access.workspaceId,
      signal,
    );
    const completeDelivery = async (
      deliverySignal: AbortSignal,
    ): Promise<CompletedCanonicalSlackDeliveryResult> => {
      const recordDeliveryFailure = (error: CanonicalSlackDeliveryFailure) => {
        return set(recordCanonicalSlackFailure$, row, error);
      };
      if (args.uploadError) {
        return await recordDeliveryFailure({
          code: "slack-upload-failed",
          message: args.uploadError,
          retryable: true,
        });
      }

      const completion = await settle(
        client.completeUploadExternal(
          slackCompletionRequest(args.fileId, row, footerText),
        ),
        deliverySignal,
      );
      deliverySignal.throwIfAborted();
      if (!completion.ok) {
        return await recordDeliveryFailure({
          code: "slack-request-failed",
          message: providerFailureMessage(completion.error),
          retryable: true,
        });
      }
      const completed = completion.value;
      if (completed.kind === "slack_error") {
        return await recordDeliveryFailure({
          code: completed.error,
          message: `Slack delivery failed: ${completed.error}`,
          retryable: true,
        });
      }

      const infoResult = await settle(
        client.getFileInfo(args.fileId),
        deliverySignal,
      );
      deliverySignal.throwIfAborted();
      if (!infoResult.ok) {
        return await recordDeliveryFailure({
          code: "slack-request-failed",
          message: providerFailureMessage(infoResult.error),
          retryable: true,
        });
      }
      const info = infoResult.value;
      const permalinkResult = args.verifySharedFile
        ? sharedSlackFileResult(info, row)
        : resolveSlackFilePermalink(info);
      if (!permalinkResult.ok) {
        return await recordDeliveryFailure(permalinkResult.error);
      }
      return await set(
        recordReconciledSlackDelivery$,
        row,
        permalinkResult.permalink,
      );
    };
    const result = await completeDelivery(signal);
    return { ...result, channelId: row.destination.channelId };
  },
);

/** New native CLI path: the server owns storage reads and all Slack traffic. */
export const deliverCanonicalSlackAsset$ = command(
  async (
    { set },
    args: PrepareCanonicalSlackDeliveryArgs,
    signal: AbortSignal,
  ): Promise<CompletedCanonicalSlackDeliveryResult | null> => {
    const db = set(writeDb$);
    const [persisted] = await db
      .select(slackDeliverySelection())
      .from(canonicalAssetDeliveries)
      .innerJoin(runUploadedFiles, slackDeliveryAssetJoin())
      .where(slackDeliveryReadCondition(args))
      .limit(1);
    signal.throwIfAborted();
    const row = validatedSlackDeliveryRow(persisted);
    if (!row) {
      return null;
    }
    const prepared = await set(
      prepareCanonicalSlackDelivery$,
      { ...args, serverTransfer: true },
      signal,
    );
    if (!prepared || prepared.status !== "pending") {
      return prepared;
    }
    const transferRow = { ...row, externalId: prepared.fileId };
    const transfer = await settleIncludingAbort(
      (async () => {
        if (!row.storageKey || !row.checksumSha256 || !row.sizeBytes) {
          throw new Error(
            "Canonical Slack file has no verified storage identity",
          );
        }
        const bytes = await set(
          downloadS3BufferWithMaxBytes$,
          {
            bucket: artifactStorageBucket(row.metadata),
            key: row.storageKey,
            maxBytes: MAX_SLACK_FILE_SIZE_BYTES,
          },
          signal,
        );
        if (
          bytes.byteLength !== row.sizeBytes ||
          createHash("sha256").update(bytes).digest("hex") !==
            row.checksumSha256
        ) {
          throw new Error(
            "Canonical Slack bytes do not match the declared size and checksum",
          );
        }
        await uploadSlackFileBytes(prepared.uploadUrl, bytes, signal);
      })(),
    );
    if (signal.aborted) {
      await set(
        recordCanonicalSlackFailure$,
        transferRow,
        slackUploadFailure(signal.reason),
      );
      signal.throwIfAborted();
    }
    if (!transfer.ok) {
      return await set(
        recordCanonicalSlackFailure$,
        transferRow,
        slackUploadFailure(transfer.error),
      );
    }
    const completion = await settleIncludingAbort(
      set(
        completeCanonicalSlackDelivery$,
        { ...args, fileId: prepared.fileId, verifySharedFile: true },
        signal,
      ),
    );
    if (signal.aborted) {
      await set(
        recordCanonicalSlackFailure$,
        transferRow,
        slackRequestFailure(signal.reason),
      );
      signal.throwIfAborted();
    }
    if (!completion.ok) {
      await set(
        recordCanonicalSlackFailure$,
        transferRow,
        slackRequestFailure(completion.error),
      );
      signal.throwIfAborted();
      throw completion.error;
    }
    return completion.value;
  },
);
