import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import type { TeamsUploadCompleteResponse } from "@okouai/api-contracts/contracts/integrations";
import {
  canonicalAssetDeliveries,
  runUploadedFiles,
} from "@okouai/db/schema/run-uploaded-file";
import type { CanonicalAssetTeamsDeliveryState } from "@okouai/db/jsonb-contracts/run-uploaded-file";

import { db$, writeDb$ } from "../external/db";
import { sendTeamsMessage } from "../external/teams-bot-client";
import { settleIncludingAbort } from "../utils";
import { conflict } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { materializeCanonicalPublishedAsset$ } from "./canonical-asset.service";
import { artifactStorageBucket } from "./private-artifact-storage.service";
import { uploadedArtifactFetchUrl$ } from "./uploaded-artifact.service";
import { resolveTeamsWriteTarget$ } from "./teams-write-access.service";
import { routeError } from "./teams-message-target.service";

interface TeamsUploadIdentity {
  readonly assetId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
}

const teamsUploadDelivery$ = command(
  async ({ get }, args: TeamsUploadIdentity, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        id: canonicalAssetDeliveries.id,
        destination: canonicalAssetDeliveries.destination,
        providerState: canonicalAssetDeliveries.providerState,
        status: canonicalAssetDeliveries.status,
        activityId: canonicalAssetDeliveries.externalId,
        deliveryUrl: canonicalAssetDeliveries.url,
        filename: runUploadedFiles.filename,
        contentType: runUploadedFiles.contentType,
        size: runUploadedFiles.sizeBytes,
        storageKey: runUploadedFiles.storageKey,
        metadata: runUploadedFiles.metadata,
      })
      .from(canonicalAssetDeliveries)
      .innerJoin(
        runUploadedFiles,
        eq(runUploadedFiles.id, canonicalAssetDeliveries.assetId),
      )
      .where(
        and(
          eq(canonicalAssetDeliveries.assetId, args.assetId),
          eq(canonicalAssetDeliveries.provider, "teams"),
          eq(canonicalAssetDeliveries.operationId, args.operationId),
          eq(runUploadedFiles.runId, args.runId),
          eq(runUploadedFiles.userId, args.userId),
          eq(runUploadedFiles.orgId, args.orgId),
          eq(runUploadedFiles.assetVersion, 1),
          eq(runUploadedFiles.idempotencyKey, args.operationId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return undefined;
    }
    if (
      row.destination.provider !== "teams" ||
      row.providerState?.provider !== "teams" ||
      !row.filename ||
      !row.contentType ||
      row.size === null ||
      !row.storageKey
    ) {
      throw new Error(
        "Canonical Teams delivery has an invalid file or destination",
      );
    }
    return {
      ...row,
      destination: row.destination,
      providerState: row.providerState,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      storageKey: row.storageKey,
    };
  },
);

type TeamsUploadDelivery = NonNullable<
  Awaited<ReturnType<typeof teamsUploadDelivery$.write>>
>;

function deliveredResponse(row: TeamsUploadDelivery, url: string) {
  const body: TeamsUploadCompleteResponse = {
    ...(row.activityId ? { activityId: row.activityId } : {}),
    conversationId: row.destination.conversationId,
    filename: row.filename,
    mimetype: row.contentType,
    size: row.size,
    url,
  };
  return { status: 200 as const, body };
}

function uncertainResponse(operationId: string) {
  return conflict(
    `Teams delivery ${operationId} is already attempted or in progress. Check its outcome before another send; this operation will not resend automatically.`,
  );
}

/** Return even an aborted provider outcome so its attempt can be finalized. */
const tryTeamsUploadMessage$ = command(
  (_, args: Parameters<typeof sendTeamsMessage>[0], signal: AbortSignal) => {
    return settleIncludingAbort(sendTeamsMessage(args, signal));
  },
);

const failTeamsUploadAttempt$ = command(
  async (
    { set },
    deliveryId: string,
    operationId: string,
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .update(canonicalAssetDeliveries)
      .set({
        status: "failed",
        lastError: {
          code: "DELIVERY_UNCERTAIN",
          message: `Inspect Teams upload operation ${operationId} before another send.`,
          retryable: false,
        },
        updatedAt: nowDate(),
      })
      .where(eq(canonicalAssetDeliveries.id, deliveryId));
    signal.throwIfAborted();
    return uncertainResponse(operationId);
  },
);

/** Persist the destination and attempt before provider I/O; retain success receipts. */
export const completeCanonicalTeamsUpload$ = command(
  async ({ set }, args: TeamsUploadIdentity, signal: AbortSignal) => {
    const row = await set(teamsUploadDelivery$, args, signal);
    if (!row) {
      return routeError(
        404,
        "Teams upload operation not found for this Run",
        "NOT_FOUND",
      );
    }
    if (row.status === "delivered") {
      if (!row.deliveryUrl) {
        throw new Error("Delivered Teams upload has no receipt URL");
      }
      return deliveredResponse(row, row.deliveryUrl);
    }
    if (row.providerState.attempt || row.status !== "pending") {
      return uncertainResponse(args.operationId);
    }
    const materialized = await set(
      materializeCanonicalPublishedAsset$,
      args,
      signal,
    );
    if (!materialized.ok) {
      return routeError(
        materialized.code === "NOT_FOUND" ? 404 : 400,
        materialized.message,
        materialized.code,
      );
    }
    const { destination } = row;
    const fetchUrl = await set(
      uploadedArtifactFetchUrl$,
      {
        isPrivate: true,
        bucket: artifactStorageBucket(row.metadata),
        key: row.storageKey,
        url: materialized.url,
      },
      signal,
    );
    // Completion input cannot replace the persisted Run, installation or conversation.
    const target = await set(
      resolveTeamsWriteTarget$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        tenantId: destination.tenantId,
        allowSource: destination.source,
        sourceOnly: destination.source,
        body: {
          conversationId: destination.conversationId,
          activityId: destination.activityId,
        },
      },
      signal,
    );
    if ("status" in target) {
      return target;
    }
    const providerState: CanonicalAssetTeamsDeliveryState = {
      provider: "teams",
      attempt: { id: randomUUID(), startedAt: nowDate().toISOString() },
    };
    const db = set(writeDb$);
    const [attempted] = await db
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
    // Once persisted, an interrupted or uncertain attempt must not be replayed.
    if (!attempted) {
      const current = await set(teamsUploadDelivery$, args, signal);
      return current?.status === "delivered" && current.deliveryUrl
        ? deliveredResponse(current, current.deliveryUrl)
        : uncertainResponse(args.operationId);
    }
    // A provider result must be recorded before propagating later cancellation.
    const sent = await set(
      tryTeamsUploadMessage$,
      {
        serviceUrl: target.installation.serviceUrl,
        tenantId: destination.tenantId,
        conversationId: destination.conversationId,
        activityId: destination.activityId,
        text: [destination.text, `[${row.filename}](${materialized.url})`]
          .filter(Boolean)
          .join("\n\n"),
        attachments: [
          {
            contentType: row.contentType,
            contentUrl: fetchUrl,
            name: row.filename,
          },
        ],
      },
      signal,
    );
    if (!sent.ok || sent.value.kind === "teams-error") {
      return await set(
        failTeamsUploadAttempt$,
        row.id,
        args.operationId,
        signal,
      );
    }
    const activityId = sent.value.activityId;
    await db
      .update(canonicalAssetDeliveries)
      .set({
        status: "delivered",
        externalId: activityId ?? null,
        url: materialized.url,
        lastError: null,
        updatedAt: nowDate(),
      })
      .where(eq(canonicalAssetDeliveries.id, row.id));
    signal.throwIfAborted();
    return deliveredResponse(
      { ...row, activityId: activityId ?? null },
      materialized.url,
    );
  },
);
