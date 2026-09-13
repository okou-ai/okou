import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadEventsContract,
  chatThreadMetadataContract,
  type ChatThreadDraft,
  type ChatThreadSnapshotProjection,
  type PersistedAttachment,
  type UserMessageInputDocument,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

import type { SetupPageAuth } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListAuth,
  cachedChatListEvents,
  chatListThread,
  installActiveChatBoundaries,
  installChatListAgent,
  installChatListModelPolicies,
  installChatListStream,
  sidebarThreadLinks,
} from "./chat-list-test-helpers.ts";

interface ContinuityDraftPatch {
  readonly threadId: string;
  readonly draftUserMessage: UserMessageInputDocument | null;
  readonly draftAttachments: PersistedAttachment[] | null;
}

interface ContinuityWorkspaceOptions {
  readonly caseId: number;
  readonly threads: readonly ChatThreadSnapshotProjection[];
  readonly chatListRemoteGate?: Promise<void>;
  readonly drafts?: ReadonlyMap<string, ChatThreadDraft>;
  readonly beforeDraftResponse?: (threadId: string) => Promise<void>;
  readonly beforeMetadataResponse?: (threadId: string) => Promise<void>;
  readonly chatEventRows?: readonly ChatEventRow[];
  readonly chatEventPageSize?: number;
  readonly resolveAttachment?: (
    fileId: string,
  ) => "available" | "missing" | Promise<"available" | "missing">;
}

interface ContinuityWorkspace {
  /**
   * Page stories must install the cache projection together with its identity.
   * Keeping these options inseparable prevents callers from falling back to
   * scheduler-dependent IndexedDB hydration before visible assertions.
   */
  readonly pageOptions: {
    readonly auth: Exclude<SetupPageAuth, null>;
    readonly cachedChatThreadEvents: ReturnType<typeof cachedChatListEvents>;
  };
  readonly draftPatches: ContinuityDraftPatch[];
  readonly eventRowQueries: ContinuityEventRowQuery[];
  readonly setDraft: (threadId: string, draft: ChatThreadDraft) => void;
  readonly setChatEventRows: (rows: readonly ChatEventRow[]) => void;
}

interface ContinuityEventRowQuery {
  readonly threadId: string;
  readonly sinceSeqId: number;
  readonly sinceEventId: string | null;
}

export function continuityThread(
  caseId: number,
  slot: number,
  title: string,
): ChatThreadSnapshotProjection {
  const timestamp = `2026-08-${((caseId % 20) + 1)
    .toString()
    .padStart(2, "0")}T0${slot}:00:00.000Z`;
  return chatListThread(caseId * 10 + slot, title, {
    createdAt: timestamp,
    updatedAt: timestamp,
    sortAt: timestamp,
  });
}

export function continuityAttachment(
  caseId: number,
  slot: number,
  filename: string,
  contentType = "text/plain",
  size = 32,
): PersistedAttachment {
  const suffix = caseId * 100 + slot;
  return {
    id: `f7000000-0000-4000-a000-${suffix.toString().padStart(12, "0")}`,
    url: `https://cdn.vm7.io/chat-continuity/${caseId}/${encodeURIComponent(filename)}`,
    filename,
    contentType,
    size,
  };
}

export function continuityEventRow(
  caseId: number,
  sequence: number,
  threadId: string,
  eventType: ChatEventRow["eventType"],
  options: {
    readonly payload?: ChatEventRow["payload"];
    readonly runId?: string;
    readonly runGroupId?: string;
    readonly revokesEventId?: string;
  } = {},
): ChatEventRow {
  const threadSuffix = Number.parseInt(threadId.slice(-6), 10);
  const suffix = threadSuffix * 1000 + sequence;
  const second = (sequence % 60).toString().padStart(2, "0");
  return {
    id: `a8000000-0000-4000-a000-${suffix.toString().padStart(12, "0")}`,
    chatThreadId: threadId,
    eventType,
    payload: options.payload ?? null,
    runId: options.runId ?? null,
    revokesEventId: options.revokesEventId ?? null,
    contextType: options.runGroupId === undefined ? null : "goal",
    contextId: options.runGroupId ?? null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: sequence,
    createdAt: `2026-08-${((caseId % 20) + 1)
      .toString()
      .padStart(2, "0")}T12:00:${second}.000Z`,
  };
}

export function continuityDraft(
  parts: readonly UserMessagePart[],
  attachments: readonly PersistedAttachment[] = [],
): ChatThreadDraft {
  const inputParts = parts.filter((part) => {
    return part.type !== "model";
  });
  return {
    draftUserMessage:
      inputParts.length > 0
        ? { version: 1, parts: inputParts as UserMessageInputDocument["parts"] }
        : null,
    draftAttachments: attachments.length > 0 ? [...attachments] : null,
  };
}

export function textContinuityDraft(
  text: string,
  attachments: readonly PersistedAttachment[] = [],
): ChatThreadDraft {
  const parts: UserMessageInputDocument["parts"] = [];
  if (text.length > 0) {
    parts.push({ type: "text", text });
  }
  for (const attachment of attachments) {
    parts.push({
      type: "file",
      fileId: attachment.id,
      filenameSnapshot: attachment.filename,
      contentType: attachment.contentType,
    });
  }
  return {
    draftUserMessage: parts.length > 0 ? { version: 1, parts } : null,
    draftAttachments: attachments.length > 0 ? [...attachments] : null,
  };
}

export function draftPlainText(
  document: UserMessageInputDocument | null,
): string {
  if (!document) {
    return "";
  }
  return document.parts
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }
      if (part.type === "feedback") {
        return part.note.flatMap((notePart) => {
          return notePart.type === "text" ? [notePart.text] : [];
        });
      }
      return [];
    })
    .join("\n");
}

export function installContinuityWorkspace(
  context: TestContext,
  options: ContinuityWorkspaceOptions,
): ContinuityWorkspace {
  const auth = chatListAuth(200 + options.caseId);
  installChatListAgent(context);
  installChatListModelPolicies(context);
  installChatListStream(context, {
    caseId: options.caseId,
    snapshot: options.threads,
    remoteGate: options.chatListRemoteGate,
  });
  installActiveChatBoundaries(context);

  const threadById = new Map(
    options.threads.map((thread) => {
      return [thread.id, thread] as const;
    }),
  );
  const drafts = new Map(options.drafts ?? []);
  const draftPatches: ContinuityDraftPatch[] = [];
  let chatEventRows = [...(options.chatEventRows ?? [])];
  const eventRowQueries: ContinuityEventRowQuery[] = [];

  if (options.chatEventRows !== undefined) {
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ params, query, respond }) => {
        const requestCursor =
          query.sinceEventId === undefined
            ? ({ lastEventId: null, lastSeqId: 0 } as const)
            : {
                lastEventId: query.sinceEventId,
                lastSeqId: query.sinceSeqId,
              };
        eventRowQueries.push({
          threadId: params.threadId,
          sinceSeqId: requestCursor.lastSeqId,
          sinceEventId: requestCursor.lastEventId,
        });
        const remainingRows = chatEventRows
          .filter((row) => {
            return (
              row.chatThreadId === params.threadId &&
              row.seqId > requestCursor.lastSeqId
            );
          })
          .sort((left, right) => {
            return left.seqId - right.seqId;
          });
        const page = remainingRows.slice(
          0,
          options.chatEventPageSize ?? query.limit,
        );
        const lastRow = page.at(-1);
        return respond(200, {
          rows: page,
          cursor: lastRow
            ? { lastEventId: lastRow.id, lastSeqId: lastRow.seqId }
            : requestCursor,
          hasMore: page.length < remainingRows.length,
        });
      },
    );
  }

  context.mocks.api(
    chatThreadMetadataContract.get,
    async ({ params, respond }) => {
      await options.beforeMetadataResponse?.(params.id);
      const thread = threadById.get(params.id);
      if (!thread) {
        return respond(404, {
          error: {
            code: "CHAT_THREAD_NOT_FOUND",
            message: "Chat thread not found",
          },
        });
      }
      return respond(200, {
        id: thread.id,
        agentId: thread.agentId,
        title: thread.title,
        selectedModel: thread.selectedModel,
        modelSettings: thread.modelSettings ?? {},
        serviceTier: thread.serviceTier,
        pinnedAt: thread.pinnedAt,
        computerUseHostId: thread.computerUseHostId,
        cloudBrowserEnabled: thread.cloudBrowserEnabled ?? false,
        selectedVideoModel: thread.selectedVideoModel ?? null,
        selectedImageModel: thread.selectedImageModel ?? null,
      });
    },
  );
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    if (!threadById.has(params.id)) {
      return respond(404, {
        error: {
          code: "CHAT_THREAD_NOT_FOUND",
          message: "Chat thread not found",
        },
      });
    }
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(
    chatThreadDraftContract.get,
    async ({ params, respond }) => {
      await options.beforeDraftResponse?.(params.id);
      const draft = drafts.get(params.id);
      if (!draft) {
        return respond(404, {
          error: {
            code: "CHAT_THREAD_NOT_FOUND",
            message: "Chat draft not found",
          },
        });
      }
      return respond(200, draft);
    },
  );
  context.mocks.api(
    chatThreadByIdContract.patch,
    ({ body, params, respond }) => {
      const patch: ContinuityDraftPatch = {
        threadId: params.id,
        draftUserMessage: body.draftUserMessage,
        draftAttachments: body.draftAttachments ?? null,
      };
      draftPatches.push(patch);
      drafts.set(params.id, {
        draftUserMessage: patch.draftUserMessage,
        draftAttachments: patch.draftAttachments,
      });
      return respond(204);
    },
  );
  context.mocks.api(webFilesContract.fileUrl, async ({ query, respond }) => {
    const resolution =
      (await options.resolveAttachment?.(query.file_id)) ?? "available";
    if (resolution === "missing") {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "File not found" },
      });
    }
    return respond(200, {
      url: `https://download.vm7.io/chat-continuity/${query.file_id}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: `https://cdn.vm7.io/artifacts/tests/chat-continuity/${query.file_id}`,
    });
  });

  return {
    pageOptions: {
      auth,
      cachedChatThreadEvents: cachedChatListEvents(
        options.caseId,
        options.threads,
      ),
    },
    draftPatches,
    eventRowQueries,
    setDraft(threadId, draft) {
      drafts.set(threadId, draft);
    },
    setChatEventRows(rows) {
      chatEventRows = [...rows];
    },
  };
}

export function continuitySidebarLink(threadId: string): HTMLAnchorElement {
  const activeThreadList =
    document.querySelector<HTMLElement>("[data-sidebar-expanded]") ??
    document.querySelector<HTMLElement>('[data-testid="chat-list-column"]');
  if (!activeThreadList) {
    throw new Error("Expected an active chat thread list");
  }
  const link = sidebarThreadLinks().find((candidate) => {
    return (
      candidate.isConnected &&
      activeThreadList.contains(candidate) &&
      candidate.dataset.sidebarChatThreadId === threadId
    );
  });
  if (!link) {
    throw new Error(`Expected sidebar link for ${threadId}`);
  }
  return link;
}
