import { artifacts } from "@okouai/db/schema/artifact";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";
import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import {
  chatConnectorExecutionFromRows,
  chatConnectorExecutionReadPlan,
} from "./chat-connector-execution";

export type DriveConnectorAccountResolution =
  | { readonly type: "resolved"; readonly connectorId: string }
  | { readonly type: "connect" }
  | { readonly type: "unavailable" };

export const chatGoogleDriveAccount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly connectionId?: string;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ): Promise<DriveConnectorAccountResolution> => {
    const { orgId, userId, threadId, runId } = args;
    const rows = await set(writeDb$)
      .select()
      .from(
        chatConnectorExecutionReadPlan(
          runId
            ? { kind: "run", runId, orgId, userId }
            : { kind: "chat", chatThreadId: threadId, orgId, userId },
          "google-drive",
        ).as("drive_chat_accounts"),
      );
    signal.throwIfAborted();
    if (!rows.length) {
      return !runId && (await set(ownedGoogleDriveThreadContext$, args, signal))
        ? { type: "connect" }
        : { type: "unavailable" };
    }
    const [current] = chatConnectorExecutionFromRows(rows).selections;
    if (
      rows[0]?.chatThreadId !== threadId ||
      !current ||
      (args.connectionId && args.connectionId !== current.connectionId)
    ) {
      return { type: "unavailable" };
    }
    return { type: "resolved", connectorId: current.connectionId };
  },
);

/** Validate the current view before using its account or agent context. */
export const ownedGoogleDriveThreadContext$ = command(
  async (
    { get },
    args: {
      readonly threadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const [thread] = await get(db$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.orgId, args.orgId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return thread !== undefined;
  },
);

/** Authorize the stored resource, never the chat that happened to produce it. */
export const ownedGoogleDriveArtifact$ = command(
  async (
    { set },
    args: {
      readonly artifactId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly catalogOnly?: boolean;
    },
    signal: AbortSignal,
  ) => {
    const [file] = await set(writeDb$)
      .select({
        runId: runUploadedFiles.runId,
        threadId: runUploadedFiles.chatThreadId,
        source: runUploadedFiles.source,
        externalId: runUploadedFiles.externalId,
        filename: runUploadedFiles.filename,
        contentType: runUploadedFiles.contentType,
        url: runUploadedFiles.url,
        metadata: runUploadedFiles.metadata,
      })
      .from(runUploadedFiles)
      .leftJoin(artifacts, eq(runUploadedFiles.id, artifacts.projectionFileId))
      .where(
        and(
          or(
            and(
              eq(artifacts.id, args.artifactId),
              eq(artifacts.orgId, args.orgId),
              eq(artifacts.authorUserId, args.userId),
              isNull(artifacts.deletedAt),
            ),
            args.catalogOnly
              ? undefined
              : eq(runUploadedFiles.id, args.artifactId),
          ),
          eq(runUploadedFiles.orgId, args.orgId),
          eq(runUploadedFiles.userId, args.userId),
          isNull(runUploadedFiles.deletedAt),
          isNotNull(runUploadedFiles.url),
          // Noncanonical upload/host writers legitimately omit assetVersion
          // and materializationStatus. Only canonical assets have a ready gate.
          or(
            isNull(runUploadedFiles.assetVersion),
            eq(runUploadedFiles.materializationStatus, "ready"),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return file ?? null;
  },
);
