import { randomUUID } from "node:crypto";
import type { SharedMessage } from "@okouai/api-contracts/contracts/shared-threads";
import { joinAll, onRejection, settle } from "../utils";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { agents } from "@okouai/db/schema/agent";
import { artifacts } from "@okouai/db/schema/artifact";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import type { SharedThreadMessageAttachments } from "@okouai/db/jsonb-contracts/shared-thread";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { command, state } from "ccstate";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import {
  recordSharedThreadPhase,
  measureSharedThreadPhase,
} from "./shared-thread-telemetry";
import {
  sharedThreadArtifactAuthorUserId,
  sharedThreadArtifactLogicalKey,
} from "../../lib/shared-thread-artifact";
import { db$, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  prepareSharedThreadMessageAttachments$,
  publishSharedThreadAttachments$,
  type SharedThreadAttachmentCopy,
} from "./shared-thread-attachments.service";
import { visibleChatEventPredicate } from "./chat-event-shared.service";
import { generateSharedThreadTitle } from "./chat-title.service";
import { projectUserMessageForPublicShare } from "./chat-user-message.service";
import {
  canonicalArchivedChatEventContent,
  canonicalArchivedChatEventError,
  canonicalArchivedChatEventUserMessage,
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import { readSharedThreadChatEventHistory$ } from "./chat-event-history.service";
import { privateArtifactCreationEnabled } from "./private-artifact-storage.service";
import {
  type SharedThreadArtifactPlan,
  prepareSharedThreadArtifacts$,
  SHARED_THREAD_LINK_LAYOUT_SEGMENT,
  SharedThreadArtifactUnavailable,
} from "./shared-thread-artifact-snapshot.service";
import {
  initializeSharedThreadArtifacts$,
  prepareSharedThreadArtifactCopies$,
  publishSharedThreadArtifacts$,
  removeSharedThreadArtifactCopies$,
  sharedThreadArtifactsReadable$,
} from "./shared-thread-artifacts.service";

const SHARED_THREAD_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

interface CreateSharedThreadArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly eventIds: readonly string[];
  readonly canReadAttachments: boolean;
  /** Client-generated ID, so the caller can copy the link before creation. */
  readonly id?: string;
}

type CreateSharedThreadResult =
  | { readonly kind: "created"; readonly id: string }
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "attachments-forbidden" }
  | { readonly kind: "no-shareable-messages" }
  | { readonly kind: "artifact-unavailable" }
  | { readonly kind: "too-large" }
  | { readonly kind: "id-conflict" };

interface SharedThreadSourceRow {
  readonly eventType: ChatEventRow["eventType"];
  readonly content: string | null;
  readonly userMessage: ReturnType<
    typeof canonicalArchivedChatEventUserMessage
  >;
  readonly runId: string | null;
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

const loadSharedThreadSourceRows$ = command(
  async (
    { get, set },
    args: {
      readonly threadId: string;
      readonly selectedEventIds: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<readonly SharedThreadSourceRow[]> => {
    const database = get(db$);
    const { threadId, selectedEventIds } = args;
    const hotSelectedRows = await database
      .select({
        id: chatEvents.id,
        eventType: chatEvents.eventType,
        content: canonicalChatEventContent(),
        userMessage: canonicalChatEventUserMessage(),
        runId: chatEvents.runId,
        isVisible: sql`COALESCE(
        ${visibleChatEventPredicate()},
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
      const history = await set(
        readSharedThreadChatEventHistory$,
        threadId,
        signal,
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
        },
      ];
    });
  },
);

const ownsSharedThreadSource$ = command(
  async (
    { get },
    args: CreateSharedThreadArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [thread] = await get(db$)
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
  },
);

const sharedThreadIdExists$ = command(
  async ({ get }, id: string, signal: AbortSignal): Promise<boolean> => {
    const [row] = await get(db$)
      .select({ id: sharedThreads.id })
      .from(sharedThreads)
      .where(eq(sharedThreads.id, id))
      .limit(1);
    signal.throwIfAborted();
    return row !== undefined;
  },
);

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
      messages.push({
        messageIndex: messages.length,
        role: row.eventType === "output.message" ? "assistant" : "user",
        content,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(runIndex === undefined ? {} : { runIndex }),
      });
    }
    return { kind: "prepared", messages, attachmentCopies };
  },
);

interface SharedThreadSnapshot {
  readonly id: string;
  readonly title: Promise<string>;
  readonly createdAt: Date;
  readonly messages: readonly SharedMessage[];
  readonly plan: SharedThreadArtifactPlan | null;
}

// Successful SQL receipts remain owned by their publication attempt, including
// cancellation after the response. Concurrent attempts never overwrite them.
const insertedSharedThreads$ = state<
  readonly {
    readonly publicationId: string;
    readonly id: string;
  }[]
>([]);

const insertSharedThreadIdentity$ = command(
  async (
    { set },
    args: CreateSharedThreadArgs,
    snapshot: SharedThreadSnapshot & { readonly publicationId: string },
    initialTitle: string,
    signal: AbortSignal,
  ) => {
    const { id, createdAt, messages, plan, publicationId } = snapshot;
    const database = set(writeDb$);
    const insertion = database
      .insert(sharedThreads)
      .values({
        id,
        userId: args.userId,
        orgId: args.orgId,
        hasArtifactSnapshot: plan !== null,
        sourceChatThreadId: args.threadId,
        title: initialTitle,
        ...sharedThreadMessageColumns(plan?.messages ?? messages),
        linkLayoutSegment: SHARED_THREAD_LINK_LAYOUT_SEGMENT,
        createdAt,
      })
      .returning({ id: sharedThreads.id });
    if (plan) {
      const inserted = (await insertion)[0];
      if (inserted) {
        set(insertedSharedThreads$, (previous) => {
          return [...previous, { publicationId, id: inserted.id }];
        });
      }
      signal.throwIfAborted();
      if (!inserted) {
        throw new Error("Shared thread insert did not return a row");
      }
    } else {
      // The ordinary share and its catalog entry are one SQL statement.
      // The CTE gates catalog creation on this request's actual insert.
      const created = database.$with("created_shared_thread").as(insertion);
      await database
        .with(created)
        .insert(artifacts)
        .select(
          database
            .select({
              id: sql`${randomUUID()}::uuid`.mapWith(artifacts.id).as("id"),
              orgId: sql`${args.orgId}`.mapWith(artifacts.orgId).as("org_id"),
              authorUserId:
                sql`${sharedThreadArtifactAuthorUserId(args.userId)}`
                  .mapWith(artifacts.authorUserId)
                  .as("author_user_id"),
              kind: sql`'file'`.mapWith(artifacts.kind).as("kind"),
              entityId: created.id,
              logicalKey: sql`${sharedThreadArtifactLogicalKey(id)}`
                .mapWith(artifacts.logicalKey)
                .as("logical_key"),
              projectionFileId: sql`NULL::uuid`
                .mapWith(nullableDriverValueDecoder(artifacts.projectionFileId))
                .as("projection_file_id"),
              projectionCreatedAt: sql`${createdAt}::timestamp`
                .mapWith(artifacts.projectionCreatedAt)
                .as("projection_created_at"),
              title: sql`${initialTitle}`.mapWith(artifacts.title).as("title"),
              thumbnail: sql`NULL::jsonb`
                .mapWith(nullableDriverValueDecoder(artifacts.thumbnail))
                .as("thumbnail"),
              createdAt: sql`${createdAt}::timestamp`
                .mapWith(artifacts.createdAt)
                .as("created_at"),
              updatedAt: sql`${createdAt}::timestamp`
                .mapWith(artifacts.updatedAt)
                .as("updated_at"),
            })
            .from(created),
        );
    }
    signal.throwIfAborted();
  },
);

const updateSharedThreadTitle$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly userId: string;
      readonly title: string;
    },
    signal: AbortSignal,
  ) => {
    const updated = await set(writeDb$)
      .update(sharedThreads)
      .set({ title: args.title })
      .where(
        and(
          eq(sharedThreads.id, args.id),
          eq(sharedThreads.userId, args.userId),
        ),
      )
      .returning({ id: sharedThreads.id });
    signal.throwIfAborted();
    if (updated.length === 0) {
      throw new SharedThreadArtifactUnavailable();
    }
  },
);

const removeSharedThreadIdentity$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    const database = set(writeDb$);
    const removed = database.$with("removed_shared_thread").as(
      database
        .delete(sharedThreads)
        .where(
          and(
            eq(sharedThreads.id, args.id),
            eq(sharedThreads.userId, args.userId),
            eq(sharedThreads.orgId, args.orgId),
          ),
        )
        .returning({ id: sharedThreads.id }),
    );
    await database
      .with(removed)
      .delete(artifacts)
      .where(
        and(
          eq(artifacts.logicalKey, sharedThreadArtifactLogicalKey(args.id)),
          eq(
            artifacts.authorUserId,
            sharedThreadArtifactAuthorUserId(args.userId),
          ),
          eq(artifacts.orgId, args.orgId),
        ),
      );
    signal.throwIfAborted();
  },
);

const persistSharedThread$ = command(
  async (
    { get, set },
    args: CreateSharedThreadArgs,
    snapshot: SharedThreadSnapshot,
    signal: AbortSignal,
  ) => {
    const { id, title, plan } = snapshot;
    // In-memory ownership only, not another persisted idempotency protocol.
    const publicationId = randomUUID();
    let policyClaimed = false;
    async function persistAndPublish() {
      if (plan) {
        await set(initializeSharedThreadArtifacts$, plan, signal);
        policyClaimed = true;
      }
      const initialTitle = plan ? "Shared conversation" : await title;
      signal.throwIfAborted();
      await set(
        insertSharedThreadIdentity$,
        args,
        { ...snapshot, publicationId },
        initialTitle,
        signal,
      );
      if (plan) {
        await set(prepareSharedThreadArtifactCopies$, plan, signal);
        const finalTitle = await title;
        signal.throwIfAborted();
        await set(
          updateSharedThreadTitle$,
          { id, userId: args.userId, title: finalTitle },
          signal,
        );
        await set(publishSharedThreadArtifacts$, plan, signal);
      }
    }
    return await onRejection(persistAndPublish(), async () => {
      if (plan && policyClaimed) {
        // Cleanup owns a bounded lifetime even after the HTTP client disconnects.
        // Retain the identity if cleanup fails, so deletion can be retried.
        const cleanupSignal = AbortSignal.timeout(30_000);
        await set(
          removeSharedThreadArtifactCopies$,
          {
            id,
            userId: args.userId,
            orgId: args.orgId,
            linkLayoutSegment: SHARED_THREAD_LINK_LAYOUT_SEGMENT,
            hasArtifactSnapshot: true,
          },
          cleanupSignal,
        );
        cleanupSignal.throwIfAborted();
        if (
          get(insertedSharedThreads$).some((receipt) => {
            return receipt.publicationId === publicationId && receipt.id === id;
          })
        ) {
          await set(
            removeSharedThreadIdentity$,
            { id, userId: args.userId, orgId: args.orgId },
            cleanupSignal,
          );
        }
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
      if (args.id !== undefined && isUniqueViolation(publication.error)) {
        return { kind: "id-conflict" } as const;
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
    { set },
    args: CreateSharedThreadArgs,
    signal: AbortSignal,
  ): Promise<CreateSharedThreadResult> => {
    const startedAt = performance.now();
    if (!(await set(ownsSharedThreadSource$, args, signal))) {
      return { kind: "thread-not-found" };
    }
    if (
      args.id !== undefined &&
      (await set(sharedThreadIdExists$, args.id, signal))
    ) {
      return { kind: "id-conflict" };
    }

    const selectedEventIds = [...new Set(args.eventIds)];
    const rows = await set(
      loadSharedThreadSourceRows$,
      {
        threadId: args.threadId,
        selectedEventIds,
      },
      signal,
    );
    signal.throwIfAborted();

    const shareId = args.id ?? randomUUID();
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
  async ({ get, set }, id: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        id: sharedThreads.id,
        title: sharedThreads.title,
        messages: sharedThreads.messages,
        messageAttachments: sharedThreads.messageAttachments,
        // Selects the stored shared-artifact layout of existing shares.
        linkLayoutSegment: sharedThreads.linkLayoutSegment,
        userId: sharedThreads.userId,
        orgId: sharedThreads.orgId,
        hasArtifactSnapshot: sharedThreads.hasArtifactSnapshot,
      })
      .from(sharedThreads)
      .where(eq(sharedThreads.id, id))
      .limit(1);
    signal.throwIfAborted();
    return row && (await set(sharedThreadArtifactsReadable$, row, signal))
      ? {
          id: row.id,
          title: visiblePiMemoryCitationText(row.title),
          messages: row.messages.map((message) => {
            const attachments = row.messageAttachments[message.messageIndex];
            return {
              ...message,
              content:
                message.role === "assistant"
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
  async ({ get, set }, id: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        id: sharedThreads.id,
        userId: sharedThreads.userId,
        orgId: sharedThreads.orgId,
        hasArtifactSnapshot: sharedThreads.hasArtifactSnapshot,
        title: sharedThreads.title,
        // Selects the stored shared-artifact layout of existing shares.
        linkLayoutSegment: sharedThreads.linkLayoutSegment,
      })
      .from(sharedThreads)
      .where(eq(sharedThreads.id, id))
      .limit(1);
    signal.throwIfAborted();
    return row && (await set(sharedThreadArtifactsReadable$, row, signal))
      ? {
          title: visiblePiMemoryCitationText(row.title),
          hasArtifactSnapshot: row.hasArtifactSnapshot,
        }
      : null;
  },
);
