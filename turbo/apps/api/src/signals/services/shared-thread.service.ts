import { randomUUID } from "node:crypto";
import type { SharedMessage } from "@okouai/api-contracts/contracts/shared-threads";
import { joinAll, onRejection, settle } from "../utils";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";
import { isRetiredGoalArchiveText } from "@okouai/api-contracts/contracts/retired-goal-archive";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agents } from "@okouai/db/schema/agent";
import { artifacts } from "@okouai/db/schema/artifact";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import type { SharedThreadMessageAttachments } from "@okouai/db/jsonb-contracts/shared-thread";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { command, computed, type Computed } from "ccstate";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import {
  recordSharedThreadPhase,
  measureSharedThreadPhase,
} from "./shared-thread-telemetry";
import {
  sharedThreadArtifactAuthorUserId,
  sharedThreadArtifactLogicalKey,
} from "../../lib/shared-thread-artifact";
import { db$, writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  prepareSharedThreadMessageAttachments$,
  publishSharedThreadAttachments$,
  type SharedThreadAttachmentCopy,
} from "./shared-thread-attachments.service";
import { visibleChatEventCondition } from "./chat-event-shared.service";
import { generateSharedThreadTitle } from "./chat-title.service";
import { projectUserMessageForPublicShare } from "./chat-user-message.service";
import {
  canonicalArchivedChatEventContent,
  canonicalArchivedChatEventError,
  canonicalArchivedChatEventGoalId,
  canonicalArchivedChatEventUserMessage,
  canonicalChatEventVisibleContent,
  canonicalChatEventGoalId,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import { readCurrentChatEventHistory } from "./chat-event-history.service";
import { privateArtifactCreationEnabled } from "./private-artifact-storage.service";
import {
  type SharedThreadArtifactPlan,
  prepareSharedThreadArtifacts$,
  SharedThreadArtifactUnavailable,
} from "./shared-thread-artifact-snapshot.service";
import {
  initializeSharedThreadArtifacts$,
  prepareSharedThreadArtifactCopies$,
  publishSharedThreadArtifacts$,
  removeSharedThreadArtifactCopies,
  sharedThreadArtifactsReadable,
} from "./shared-thread-artifacts.service";

const SHARED_THREAD_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

interface CreateSharedThreadArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly eventIds: readonly string[];
  readonly publicBrand: PublicBrand;
  readonly canReadAttachments: boolean;
}

type CreateSharedThreadResult =
  | { readonly kind: "created"; readonly id: string }
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "attachments-forbidden" }
  | { readonly kind: "no-shareable-messages" }
  | { readonly kind: "artifact-unavailable" }
  | { readonly kind: "too-large" };

interface SharedThreadSourceRow {
  readonly eventType: ChatEventRow["eventType"];
  readonly content: string | null;
  readonly userMessage: ReturnType<
    typeof canonicalArchivedChatEventUserMessage
  >;
  readonly runId: string | null;
  readonly runGroupId: string | null;
}

function isShareableEventType(row: ChatEventRow): row is ChatEventRow & {
  readonly eventType: "input.prompt" | "input.automation" | "output.message";
} {
  return (
    row.eventType === "input.prompt" ||
    row.eventType === "input.automation" ||
    row.eventType === "output.message"
  );
}

function archivedEventIsVisible(
  row: ChatEventRow,
  revokedEventIds: ReadonlySet<string>,
): boolean {
  if (revokedEventIds.has(row.id)) {
    return false;
  }
  if (
    (row.eventType === "input.prompt" ||
      row.eventType === "input.automation") &&
    row.runId === null &&
    row.revokesEventId !== null &&
    canonicalArchivedChatEventError(row) === null
  ) {
    return false;
  }
  return true;
}

function archivedSharedThreadRows(
  history: readonly ChatEventRow[],
  selectedEventIds: ReadonlySet<string>,
): readonly SharedThreadSourceRow[] {
  const revokedEventIds = new Set(
    history.flatMap((row) => {
      return row.revokesEventId === null ? [] : [row.revokesEventId];
    }),
  );
  return history.flatMap((row) => {
    if (
      !selectedEventIds.has(row.id) ||
      !isShareableEventType(row) ||
      !archivedEventIsVisible(row, revokedEventIds)
    ) {
      return [];
    }
    return [
      {
        eventType: row.eventType,
        content: canonicalArchivedChatEventContent(row),
        userMessage: canonicalArchivedChatEventUserMessage(row),
        runId: row.runId,
        runGroupId: canonicalArchivedChatEventGoalId(row),
      },
    ];
  });
}

function localIndex(
  sourceId: string | null,
  indices: Map<string, number>,
): number | undefined {
  if (sourceId === null) {
    return undefined;
  }
  const existing = indices.get(sourceId);
  if (existing !== undefined) {
    return existing;
  }
  const next = indices.size;
  indices.set(sourceId, next);
  return next;
}

function loadSharedThreadSourceRows(
  args: {
    readonly database: Db;
    readonly threadId: string;
    readonly selectedEventIds: readonly string[];
  },
  signal: AbortSignal,
): Computed<Promise<readonly SharedThreadSourceRow[]>> {
  return computed(async (get) => {
    const { database, threadId, selectedEventIds } = args;
    const hotSelectedRows = await database
      .select({
        id: chatEvents.id,
        eventType: chatEvents.eventType,
        content: canonicalChatEventVisibleContent(),
        userMessage: canonicalChatEventUserMessage(),
        runId: chatEvents.runId,
        runGroupId: canonicalChatEventGoalId(),
        isVisible: sql`COALESCE(
        ${visibleChatEventCondition(database)},
        false
      )`.mapWith(pgBooleanDecoder),
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, threadId),
          inArray(chatEvents.id, [...selectedEventIds]),
        ),
      )
      .orderBy(asc(chatEvents.seqId));
    signal.throwIfAborted();

    if (hotSelectedRows.length !== selectedEventIds.length) {
      const history = await get(
        readCurrentChatEventHistory(
          {
            db: database,
            bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          },
          threadId,
          signal,
        ),
      );
      return archivedSharedThreadRows(history, new Set(selectedEventIds));
    }

    return hotSelectedRows.flatMap((row) => {
      if (
        !row.isVisible ||
        (row.eventType !== "input.prompt" &&
          row.eventType !== "input.automation" &&
          row.eventType !== "output.message")
      ) {
        return [];
      }
      return [
        {
          eventType: row.eventType,
          content: row.content,
          userMessage: row.userMessage,
          runId: row.runId,
          runGroupId: row.runGroupId,
        },
      ];
    });
  });
}

async function ownsSharedThreadSource(
  database: Db,
  args: CreateSharedThreadArgs,
  signal: AbortSignal,
): Promise<boolean> {
  const [thread] = await database
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
        eq(agents.orgId, args.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return thread !== undefined;
}

function sharedThreadMessageColumns(messages: readonly SharedMessage[]) {
  // Previous API readers validate messages strictly. Keep attachment metadata
  // outside that persisted shape so those readers can still serve the text.
  const messageAttachments: SharedThreadMessageAttachments = {};
  const persistedMessages = messages.map(({ attachments, ...message }) => {
    if (attachments !== undefined) {
      messageAttachments[message.messageIndex] = attachments;
    }
    return message;
  });
  return { messages: persistedMessages, messageAttachments };
}

type PreparedSharedThreadMessages =
  | { readonly kind: "attachments-forbidden" }
  | {
      readonly kind: "prepared";
      readonly messages: readonly SharedMessage[];
      readonly attachmentCopies: ReadonlyMap<
        string,
        SharedThreadAttachmentCopy
      >;
    };

const prepareSharedThreadMessages$ = command(
  async (
    { set },
    args: CreateSharedThreadArgs,
    rows: readonly SharedThreadSourceRow[],
    shareId: string,
    signal: AbortSignal,
  ): Promise<PreparedSharedThreadMessages> => {
    const runIndices = new Map<string, number>();
    const runGroupIndices = new Map<string, number>();
    const attachmentCopies = new Map<string, SharedThreadAttachmentCopy>();
    const messages: SharedMessage[] = [];
    for (const row of rows) {
      if (
        !args.canReadAttachments &&
        row.userMessage?.parts.some((part) => {
          return part.type === "file";
        })
      ) {
        return { kind: "attachments-forbidden" };
      }
      const content =
        row.eventType === "output.message"
          ? row.content
          : row.userMessage
            ? projectUserMessageForPublicShare(row.userMessage)
            : row.content;
      const attachments = await set(
        prepareSharedThreadMessageAttachments$,
        {
          userId: args.userId,
          orgId: args.orgId,
          publicBrand: args.publicBrand,
          shareId,
          document: row.eventType === "output.message" ? null : row.userMessage,
          copies: attachmentCopies,
        },
        signal,
      );
      if (
        content === null ||
        (content.length === 0 && attachments.length === 0)
      ) {
        continue;
      }
      const runIndex = localIndex(row.runId, runIndices);
      const runGroupIndex = localIndex(row.runGroupId, runGroupIndices);
      messages.push({
        messageIndex: messages.length,
        role: row.eventType === "output.message" ? "assistant" : "user",
        content,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(runIndex === undefined ? {} : { runIndex }),
        ...(runGroupIndex === undefined ? {} : { runGroupIndex }),
      });
    }
    return { kind: "prepared", messages, attachmentCopies };
  },
);

const persistSharedThread$ = command(
  async (
    { get, set },
    args: CreateSharedThreadArgs,
    snapshot: {
      readonly id: string;
      readonly title: Promise<string>;
      readonly createdAt: Date;
      readonly messages: readonly SharedMessage[];
      readonly plan: SharedThreadArtifactPlan | null;
    },
    signal: AbortSignal,
  ) => {
    const { id, title, createdAt, messages, plan } = snapshot;
    const database = set(writeDb$);
    async function persistAndPublish() {
      if (plan) {
        await set(initializeSharedThreadArtifacts$, plan, signal);
      }
      // A durable, denied identity lets deletion/revocation find in-flight
      // snapshots. Only artifact snapshots may exist before the title settles.
      const initialTitle = plan ? "Shared conversation" : await title;
      signal.throwIfAborted();
      await database.transaction(async (transaction) => {
        const [sharedThread] = await transaction
          .insert(sharedThreads)
          .values({
            id,
            userId: args.userId,
            orgId: args.orgId,
            hasArtifactSnapshot: plan !== null,
            sourceChatThreadId: args.threadId,
            title: initialTitle,
            ...sharedThreadMessageColumns(plan?.messages ?? messages),
            publicBrand: args.publicBrand,
            createdAt,
          })
          .returning({ id: sharedThreads.id });
        if (!sharedThread) {
          throw new Error("Shared thread insert did not return a row");
        }
        if (plan) {
          return;
        }
        await transaction.insert(artifacts).values({
          orgId: args.orgId,
          authorUserId: sharedThreadArtifactAuthorUserId(args.userId),
          kind: "file",
          entityId: sharedThread.id,
          logicalKey: sharedThreadArtifactLogicalKey(sharedThread.id),
          projectionFileId: null,
          projectionCreatedAt: createdAt,
          title: initialTitle,
          thumbnail: null,
          createdAt,
          updatedAt: createdAt,
        });
      });
      signal.throwIfAborted();
      if (plan) {
        await set(prepareSharedThreadArtifactCopies$, plan, signal);
        // Never hold the deletion lock or a DB transaction while awaiting LLM.
        const finalTitle = await title;
        signal.throwIfAborted();
        const updated = await database
          .update(sharedThreads)
          .set({ title: finalTitle })
          .where(
            and(
              eq(sharedThreads.id, id),
              eq(sharedThreads.userId, args.userId),
            ),
          )
          .returning({ id: sharedThreads.id });
        signal.throwIfAborted();
        if (updated.length === 0) {
          throw new SharedThreadArtifactUnavailable();
        }
        await set(publishSharedThreadArtifacts$, plan, signal);
      }
    }
    return await onRejection(persistAndPublish(), async () => {
      if (plan) {
        // Cleanup owns a bounded lifetime even after the HTTP client disconnects.
        // Retain the identity if cleanup fails, so deletion can be retried.
        const cleanupSignal = AbortSignal.timeout(30_000);
        await get(
          removeSharedThreadArtifactCopies(
            {
              id,
              userId: args.userId,
              orgId: args.orgId,
              publicBrand: args.publicBrand,
              hasArtifactSnapshot: true,
            },
            cleanupSignal,
          ),
        );
        cleanupSignal.throwIfAborted();
        await database.transaction(async (tx) => {
          await tx
            .delete(artifacts)
            .where(
              eq(artifacts.logicalKey, sharedThreadArtifactLogicalKey(id)),
            );
          await tx
            .delete(sharedThreads)
            .where(
              and(
                eq(sharedThreads.id, id),
                eq(sharedThreads.userId, args.userId),
              ),
            );
        });
      }
    });
  },
);

const prepareAndPersistSharedThread$ = command(
  async (
    { get, set },
    args: CreateSharedThreadArgs,
    snapshot: {
      readonly id: string;
      readonly messages: readonly SharedMessage[];
      readonly attachmentCopies: ReadonlyMap<
        string,
        SharedThreadAttachmentCopy
      >;
      readonly title: Promise<string>;
    },
    signal: AbortSignal,
  ) => {
    const { id, messages, attachmentCopies, title } = snapshot;
    const preparationStartedAt = performance.now();
    const enabled = await get(
      privateArtifactCreationEnabled(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const preparation =
      enabled ||
      [...attachmentCopies.values()].some((copy) => {
        return copy.isPrivate;
      })
        ? await settle(
            set(
              prepareSharedThreadArtifacts$,
              { ...args, threadId: id, messages },
              signal,
            ),
            signal,
          )
        : { ok: true as const, value: { messages, plan: null } };
    recordSharedThreadPhase({
      shareId: id,
      phase: "prepare",
      durationMs: Math.round(performance.now() - preparationStartedAt),
      status: preparation.ok ? "success" : "failed",
    });
    if (!preparation.ok) {
      if (preparation.error instanceof SharedThreadArtifactUnavailable) {
        return { kind: "artifact-unavailable" } as const;
      }
      throw preparation.error;
    }
    const { plan, messages: preparedMessages } = preparation.value;
    if (
      Buffer.byteLength(JSON.stringify(preparedMessages)) >
      SHARED_THREAD_MAX_SERIALIZED_BYTES
    ) {
      return { kind: "too-large" } as const;
    }
    await set(
      publishSharedThreadAttachments$,
      attachmentCopies.values(),
      signal,
    );
    const publication = await settle(
      set(
        persistSharedThread$,
        args,
        {
          id,
          title,
          createdAt: nowDate(),
          messages: preparedMessages,
          plan,
        },
        signal,
      ),
      signal,
    );
    if (!publication.ok) {
      if (publication.error instanceof SharedThreadArtifactUnavailable) {
        return { kind: "artifact-unavailable" } as const;
      }
      throw publication.error;
    }
    await publishUserSignal(
      [args.userId],
      `chatThreadArtifactsChanged:${args.threadId}`,
    );
    signal.throwIfAborted();
    return { kind: "created", id } as const;
  },
);

export const createSharedThread$ = command(
  async (
    { get, set },
    args: CreateSharedThreadArgs,
    signal: AbortSignal,
  ): Promise<CreateSharedThreadResult> => {
    const startedAt = performance.now();
    const database = set(writeDb$);
    if (!(await ownsSharedThreadSource(database, args, signal))) {
      return { kind: "thread-not-found" };
    }

    const selectedEventIds = [...new Set(args.eventIds)];
    const rows = await get(
      loadSharedThreadSourceRows(
        {
          database,
          threadId: args.threadId,
          selectedEventIds,
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    const shareId = randomUUID();
    const prepared = await set(
      prepareSharedThreadMessages$,
      args,
      rows,
      shareId,
      signal,
    );
    if (prepared.kind === "attachments-forbidden") {
      return prepared;
    }
    const { messages, attachmentCopies } = prepared;

    if (messages.length === 0) {
      return { kind: "no-shareable-messages" };
    }
    const serializedMessages = JSON.stringify(messages);
    if (
      new TextEncoder().encode(serializedMessages).byteLength >
      SHARED_THREAD_MAX_SERIALIZED_BYTES
    ) {
      return { kind: "too-large" };
    }

    const title = measureSharedThreadPhase(
      { shareId, phase: "title" },
      generateSharedThreadTitle(messages, signal),
    );
    // Join every started branch even when preparation fails or the request is
    // cancelled; no copy may outlive rollback and write into a revoked share.
    const [, result] = await measureSharedThreadPhase(
      { shareId, phase: "total" },
      joinAll([
        title,
        set(
          prepareAndPersistSharedThread$,
          args,
          { id: shareId, messages, attachmentCopies, title },
          signal,
        ),
      ]),
      ([, publication]) => {
        return publication.kind;
      },
      startedAt,
    );
    signal.throwIfAborted();
    return result;
  },
);

export const readSharedThread$ = command(
  async ({ get }, id: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        id: sharedThreads.id,
        title: sharedThreads.title,
        messages: sharedThreads.messages,
        messageAttachments: sharedThreads.messageAttachments,
        publicBrand: sharedThreads.publicBrand,
        userId: sharedThreads.userId,
        orgId: sharedThreads.orgId,
        hasArtifactSnapshot: sharedThreads.hasArtifactSnapshot,
      })
      .from(sharedThreads)
      .where(eq(sharedThreads.id, id))
      .limit(1);
    signal.throwIfAborted();
    return row && (await get(sharedThreadArtifactsReadable(row, signal)))
      ? {
          id: row.id,
          publicBrand: row.publicBrand,
          title: visiblePiMemoryCitationText(row.title),
          messages: row.messages.map((message) => {
            const attachments = row.messageAttachments[message.messageIndex];
            return {
              ...message,
              content:
                message.role === "assistant" &&
                !(
                  message.runIndex === undefined &&
                  message.runGroupIndex === undefined &&
                  isRetiredGoalArchiveText(message.content)
                )
                  ? visiblePiMemoryCitationText(message.content)
                  : message.content,
              ...(attachments === undefined ? {} : { attachments }),
            };
          }),
        }
      : null;
  },
);

export const readSharedThreadMeta$ = command(
  async ({ get }, id: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        id: sharedThreads.id,
        userId: sharedThreads.userId,
        orgId: sharedThreads.orgId,
        hasArtifactSnapshot: sharedThreads.hasArtifactSnapshot,
        title: sharedThreads.title,
        publicBrand: sharedThreads.publicBrand,
      })
      .from(sharedThreads)
      .where(eq(sharedThreads.id, id))
      .limit(1);
    signal.throwIfAborted();
    return row && (await get(sharedThreadArtifactsReadable(row, signal)))
      ? {
          publicBrand: row.publicBrand,
          title: visiblePiMemoryCitationText(row.title),
          hasArtifactSnapshot: row.hasArtifactSnapshot,
        }
      : null;
  },
);
