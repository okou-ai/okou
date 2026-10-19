import { command } from "ccstate";
import {
  CANONICAL_ASSET_VERSION,
  canonicalAssetDeliveries,
  runUploadedFiles,
} from "@okouai/db/schema/run-uploaded-file";
import { and, eq, isNull, ne, sql, type SQL } from "drizzle-orm";

import type { SlackClient } from "../external/slack-message-client";
import { type Db, writeDb$ } from "../external/db";
import { settle } from "../utils";

interface CanonicalSlackDeliveryRow {
  readonly assetId: string;
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly assetUrl: string | null;
  readonly operationId: string;
  readonly status: "pending" | "delivered" | "failed";
  readonly destination: {
    readonly channelId: string;
    readonly threadTs?: string;
    readonly title?: string;
    readonly initialComment?: string;
  };
  readonly externalId: string | null;
  readonly deliveryUrl: string | null;
  readonly lastError: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

type CanonicalSlackDeliveryResult =
  | {
      readonly status: "pending";
      readonly uploadUrl: string;
      readonly fileId: string;
    }
  | {
      readonly status: "delivered";
      readonly fileId: string;
      readonly permalink: string;
    }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly retryable: boolean;
    };

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
): CanonicalSlackDeliveryResult {
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

function failedResult(
  error: CanonicalSlackDeliveryFailure,
): CanonicalSlackDeliveryResult {
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

async function deliveryResultAfterTransitionConflict(
  db: Db,
  row: CanonicalSlackDeliveryRow,
): Promise<CanonicalSlackDeliveryResult> {
  const [current] = await db
    .select({
      status: canonicalAssetDeliveries.status,
      externalId: canonicalAssetDeliveries.externalId,
      deliveryUrl: canonicalAssetDeliveries.url,
      lastError: canonicalAssetDeliveries.lastError,
    })
    .from(canonicalAssetDeliveries)
    .where(deliveryIdentityCondition(row))
    .limit(1);
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
): CanonicalSlackDeliveryResult {
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
    operationId: canonicalAssetDeliveries.operationId,
    status: canonicalAssetDeliveries.status,
    destination: canonicalAssetDeliveries.destination,
    externalId: canonicalAssetDeliveries.externalId,
    deliveryUrl: canonicalAssetDeliveries.url,
    lastError: canonicalAssetDeliveries.lastError,
  };
}

async function completeExistingSlackFile(
  db: Db,
  client: SlackClient,
  row: CanonicalSlackDeliveryRow,
): Promise<CanonicalSlackDeliveryResult | null> {
  if (!row.externalId) {
    return null;
  }
  const recordReconciliationFailure = async (
    error: CanonicalSlackDeliveryFailure,
  ): Promise<CanonicalSlackDeliveryResult> => {
    const [failed] = await db
      .update(canonicalAssetDeliveries)
      .set({
        status: "failed",
        lastError: error,
        updatedAt: sql`now()`,
      })
      .where(deliveryTransitionCondition(row))
      .returning({ id: canonicalAssetDeliveries.id });
    return failed
      ? failedResult(error)
      : await deliveryResultAfterTransitionConflict(db, row);
  };
  const completed = await client.completeUploadExternal({
    fileId: row.externalId,
    channel: row.destination.channelId,
    threadTs: row.destination.threadTs,
    title: row.destination.title,
    initialComment: row.destination.initialComment,
  });
  if (completed.kind === "slack_error") {
    if (
      completed.error === "file_not_found" ||
      completed.error === "no_file_data"
    ) {
      return null;
    }
    return await recordReconciliationFailure({
      code: completed.error,
      message: `Slack delivery failed: ${completed.error}`,
      retryable: true,
    });
  }
  const info = await client.getFileInfo(row.externalId);
  const permalinkResult = resolveSlackFilePermalink(info);
  if (!permalinkResult.ok) {
    return await recordReconciliationFailure(permalinkResult.error);
  }
  const recordDeliverySuccess = async (
    permalink: string,
  ): Promise<CanonicalSlackDeliveryResult> => {
    const fileId = requiredSlackFileId(row.externalId);
    const deliveryUrl = requiredSlackPermalink(permalink);
    const [delivered] = await db
      .update(canonicalAssetDeliveries)
      .set(deliveredUpdateFields(deliveryUrl))
      .where(deliveryTransitionCondition(row))
      .returning({ id: canonicalAssetDeliveries.id });
    return delivered
      ? successfulDeliveryResult(fileId, deliveryUrl)
      : await deliveryResultAfterTransitionConflict(db, row);
  };
  return await recordDeliverySuccess(permalinkResult.permalink);
}

interface PrepareCanonicalSlackDeliveryArgs {
  readonly assetId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly userId: string;
  readonly client: SlackClient;
}

function slackDeliveryReadCondition(
  args: Readonly<
    Pick<
      PrepareCanonicalSlackDeliveryArgs,
      "assetId" | "runId" | "userId" | "operationId"
    >
  >,
): SQL | undefined {
  return and(
    eq(runUploadedFiles.id, args.assetId),
    eq(runUploadedFiles.runId, args.runId),
    eq(runUploadedFiles.userId, args.userId),
    eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
    eq(runUploadedFiles.classification, "published-output"),
    eq(runUploadedFiles.materializationStatus, "ready"),
    eq(canonicalAssetDeliveries.provider, "slack"),
    eq(canonicalAssetDeliveries.operationId, args.operationId),
  );
}

export const prepareCanonicalSlackDelivery$ = command(
  async (
    { set },
    args: PrepareCanonicalSlackDeliveryArgs,
    signal: AbortSignal,
  ): Promise<CanonicalSlackDeliveryResult | null> => {
    const db = set(writeDb$);
    const readDelivery = async (): Promise<
      CanonicalSlackDeliveryRow | undefined
    > => {
      const [row] = await db
        .select(slackDeliverySelection())
        .from(canonicalAssetDeliveries)
        .innerJoin(
          runUploadedFiles,
          eq(runUploadedFiles.id, canonicalAssetDeliveries.assetId),
        )
        .where(slackDeliveryReadCondition(args))
        .limit(1);
      if (!row) {
        return undefined;
      }
      if (row.destination.provider !== undefined) {
        throw new Error("Slack delivery has a Discord destination");
      }
      return { ...row, destination: row.destination };
    };
    const row = await readDelivery();
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    if (row.status === "delivered") {
      return deliveredResult(row);
    }

    const recordPreparationFailure = async (
      error: CanonicalSlackDeliveryFailure,
    ): Promise<CanonicalSlackDeliveryResult> => {
      const [failed] = await db
        .update(canonicalAssetDeliveries)
        .set({
          status: "failed",
          lastError: error,
          updatedAt: sql`now()`,
        })
        .where(deliveryTransitionCondition(row))
        .returning({ id: canonicalAssetDeliveries.id });
      return failed
        ? failedResult(error)
        : await deliveryResultAfterTransitionConflict(db, row);
    };

    const reconciliation = await settle(
      completeExistingSlackFile(db, args.client, row),
      signal,
    );
    signal.throwIfAborted();
    if (!reconciliation.ok) {
      return await recordPreparationFailure({
        code: "slack-request-failed",
        message: providerFailureMessage(reconciliation.error),
        retryable: true,
      });
    }
    const reconciled = reconciliation.value;
    if (reconciled) {
      return reconciled;
    }
    if (!row.filename || row.sizeBytes === null) {
      return await recordPreparationFailure({
        code: "asset-metadata-missing",
        message: "Canonical asset metadata is incomplete",
        retryable: false,
      });
    }

    const preparation = await settle(
      args.client.getUploadUrlExternal({
        filename: row.filename,
        length: row.sizeBytes,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!preparation.ok) {
      return await recordPreparationFailure({
        code: "slack-request-failed",
        message: providerFailureMessage(preparation.error),
        retryable: true,
      });
    }
    const prepared = preparation.value;
    if (prepared.kind === "slack_error") {
      return await recordPreparationFailure({
        code: prepared.error,
        message: `Slack delivery failed: ${prepared.error}`,
        retryable: true,
      });
    }

    const reservePreparedSlackFile = async (prepared: {
      readonly uploadUrl: string;
      readonly fileId: string;
    }): Promise<CanonicalSlackDeliveryResult> => {
      const [reserved] = await db
        .update(canonicalAssetDeliveries)
        .set({
          status: "pending",
          externalId: prepared.fileId,
          url: null,
          lastError: null,
          updatedAt: sql`now()`,
        })
        .where(deliveryTransitionCondition(row))
        .returning({ id: canonicalAssetDeliveries.id });
      if (!reserved) {
        return await deliveryResultAfterTransitionConflict(db, row);
      }
      return {
        status: "pending",
        uploadUrl: prepared.uploadUrl,
        fileId: prepared.fileId,
      };
    };
    const result = await reservePreparedSlackFile({
      uploadUrl: prepared.uploadUrl,
      fileId: prepared.fileId,
    });
    signal.throwIfAborted();
    return result;
  },
);

interface CompleteCanonicalSlackDeliveryArgs {
  readonly assetId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly userId: string;
  readonly fileId: string;
  readonly uploadError?: string;
  readonly client: SlackClient;
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
    (CanonicalSlackDeliveryResult & { readonly channelId: string }) | null
  > => {
    const db = set(writeDb$);
    const readDelivery = async (): Promise<
      CanonicalSlackDeliveryRow | undefined
    > => {
      const [row] = await db
        .select(slackDeliverySelection())
        .from(canonicalAssetDeliveries)
        .innerJoin(
          runUploadedFiles,
          eq(runUploadedFiles.id, canonicalAssetDeliveries.assetId),
        )
        .where(slackDeliveryReadCondition(args))
        .limit(1);
      if (!row) {
        return undefined;
      }
      if (row.destination.provider !== undefined) {
        throw new Error("Slack delivery has a Discord destination");
      }
      return { ...row, destination: row.destination };
    };
    const row = await readDelivery();
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const completeDelivery = async (
      deliverySignal: AbortSignal,
    ): Promise<CanonicalSlackDeliveryResult> => {
      const recordDeliveryFailure = async (
        error: CanonicalSlackDeliveryFailure,
      ): Promise<CanonicalSlackDeliveryResult> => {
        const [failed] = await db
          .update(canonicalAssetDeliveries)
          .set({
            status: "failed",
            lastError: error,
            updatedAt: sql`now()`,
          })
          .where(deliveryTransitionCondition(row))
          .returning({ id: canonicalAssetDeliveries.id });
        return failed
          ? failedResult(error)
          : await deliveryResultAfterTransitionConflict(db, row);
      };
      if (row.status === "delivered") {
        return deliveredResult(row);
      }
      if (row.externalId !== args.fileId) {
        return await deliveryResultAfterTransitionConflict(db, row);
      }
      if (args.uploadError) {
        return await recordDeliveryFailure({
          code: "slack-upload-failed",
          message: args.uploadError,
          retryable: true,
        });
      }

      const completion = await settle(
        args.client.completeUploadExternal({
          fileId: args.fileId,
          channel: row.destination.channelId,
          threadTs: row.destination.threadTs,
          title: row.destination.title,
          initialComment: row.destination.initialComment,
        }),
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
        args.client.getFileInfo(args.fileId),
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
      const permalinkResult = resolveSlackFilePermalink(info);
      if (!permalinkResult.ok) {
        return await recordDeliveryFailure(permalinkResult.error);
      }
      const recordDeliverySuccess = async (
        permalink: string,
      ): Promise<CanonicalSlackDeliveryResult> => {
        const fileId = requiredSlackFileId(row.externalId);
        const deliveryUrl = requiredSlackPermalink(permalink);
        const [delivered] = await db
          .update(canonicalAssetDeliveries)
          .set(deliveredUpdateFields(deliveryUrl))
          .where(deliveryTransitionCondition(row))
          .returning({ id: canonicalAssetDeliveries.id });
        return delivered
          ? successfulDeliveryResult(fileId, deliveryUrl)
          : await deliveryResultAfterTransitionConflict(db, row);
      };
      return await recordDeliverySuccess(permalinkResult.permalink);
    };
    const result = await completeDelivery(signal);
    return { ...result, channelId: row.destination.channelId };
  },
);
