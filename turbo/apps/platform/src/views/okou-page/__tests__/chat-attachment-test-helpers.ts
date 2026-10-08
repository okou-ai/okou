import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadArtifactsContract,
  chatThreadDraftContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatThreadArtifactFile,
  type ChatThreadDraft,
  type ImageAnnotation,
  type PersistedAttachment,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { waitFor } from "@testing-library/react";

import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  mockChatThreadSnapshotResponse,
  chatEventRowsResponse,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";
import { mockChatLifecycle, threadListSnapshot } from "./chat-test-helpers.ts";

type MockChatLifecycleOptions = NonNullable<
  Parameters<typeof mockChatLifecycle>[1]
>;

type AnnotatedPersistedAttachment = PersistedAttachment & {
  readonly annotatedFileId?: string;
  readonly annotations?: ImageAnnotation;
};

const ATTACHMENT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
export const ATTACHMENT_THREAD_ID = "b0000000-0000-4000-a000-000000000081";
export const SECOND_ATTACHMENT_THREAD_ID =
  "b0000000-0000-4000-a000-000000000082";
export const ATTACHMENT_RUN_ID = "d0000000-0000-4000-a000-000000000081";

export type AttachmentChatEvent = NonNullable<
  MockChatLifecycleOptions["chatEvents"]
>[number];

export function publicArtifactUrl(filename: string): string {
  return `https://cdn.vm7.io/artifacts/tests/chat-attachments/${filename}`;
}

export function privateAttachmentUrl(fileId: string): string {
  return `http://localhost/api/web/download-file?file_id=${encodeURIComponent(fileId)}`;
}

export function artifactFile(
  filename: string,
  overrides: Partial<ChatThreadArtifactFile> = {},
): ChatThreadArtifactFile {
  return {
    id: `artifact-${filename}`,
    filename,
    contentType: "application/octet-stream",
    size: 1024,
    url: publicArtifactUrl(filename),
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced", accountReady: true },
    ...overrides,
  };
}

export function draftAttachment(
  filename: string,
  overrides: Partial<AnnotatedPersistedAttachment> = {},
): AnnotatedPersistedAttachment {
  return {
    id: `draft-${filename}`,
    filename,
    contentType: "image/png",
    size: 1024,
    url: publicArtifactUrl(filename),
    ...overrides,
  };
}

export function boxAnnotation(
  marks: readonly {
    readonly id: string;
    readonly ordinal: number;
    readonly note?: string;
  }[],
): ImageAnnotation {
  return {
    marks: marks.map((mark, index) => {
      return {
        id: mark.id,
        ordinal: mark.ordinal,
        shape: "box" as const,
        rect: {
          x: 0.08 + index * 0.12,
          y: 0.1 + index * 0.1,
          width: 0.2,
          height: 0.16,
        },
        ink: "#F04438",
        ...(mark.note === undefined ? {} : { note: mark.note }),
      };
    }),
  };
}

/** One arrow, drawn top-left to bottom-right across the middle of the image. */
export function arrowAnnotation(id: string): ImageAnnotation {
  return {
    marks: [
      {
        id,
        ordinal: 1,
        shape: "arrow" as const,
        from: { x: 0.2, y: 0.2 },
        to: { x: 0.7, y: 0.6 },
        ink: "#5E6AD2",
      },
    ],
  };
}

/** One freehand stroke, as a short diagonal run of points. */
export function penAnnotation(id: string): ImageAnnotation {
  return {
    marks: [
      {
        id,
        ordinal: 1,
        shape: "pen" as const,
        points: [
          { x: 0.2, y: 0.25 },
          { x: 0.35, y: 0.4 },
          { x: 0.5, y: 0.45 },
        ],
        ink: "#5E6AD2",
      },
    ],
  };
}

export function draftForAttachment(
  attachment: AnnotatedPersistedAttachment,
  text = "Draft message",
): ChatThreadDraft {
  const { annotatedFileId, annotations, ...storedAttachment } = attachment;
  const filePart = {
    type: "file" as const,
    fileId: attachment.id,
    filenameSnapshot: attachment.filename,
    contentType: attachment.contentType,
    ...(annotatedFileId ? { annotatedFileId } : {}),
    ...(annotations ? { annotations } : {}),
  };
  return {
    draftUserMessage: {
      version: 1,
      parts: text ? [filePart, { type: "text", text }] : [filePart],
    },
    draftAttachments: [storedAttachment],
  };
}

type MockAttachmentChatOptions = {
  readonly threadId?: string;
  readonly chatEvents?: AttachmentChatEvent[];
  readonly draft?: ChatThreadDraft;
  readonly artifacts?: readonly ChatThreadArtifactFile[];
  readonly artifactRunId?: string;
  readonly threadTitle?: string;
  readonly onSendRequest?: MockChatLifecycleOptions["onSendRequest"];
};

export function mockAttachmentChat(
  context: TestContext,
  options: MockAttachmentChatOptions = {},
): void {
  const threadId = options.threadId ?? ATTACHMENT_THREAD_ID;
  mockChatLifecycle(context, {
    threadId,
    threadTitle: options.threadTitle ?? "Attachment chat",
    chatEvents: options.chatEvents ?? [],
    onSendRequest: options.onSendRequest,
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs:
        options.artifacts === undefined
          ? []
          : [
              {
                runId: options.artifactRunId ?? ATTACHMENT_RUN_ID,
                files: [...options.artifacts],
              },
            ],
    });
  });
  if (options.draft) {
    const draft = options.draft;
    context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
      return respond(200, draft);
    });
  }
}

export function mockPrivateUrlSequence(
  context: TestContext,
  urlsByFileId: Readonly<Record<string, readonly string[]>>,
  publicUrlsByFileId: Readonly<Record<string, string>> = {},
): void {
  const calls = new Map<string, number>();
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const urls = urlsByFileId[query.file_id];
    if (!urls || urls.length === 0) {
      return respond(404, {
        error: { code: "FILE_NOT_FOUND", message: "File not found" },
      });
    }
    const call = calls.get(query.file_id) ?? 0;
    calls.set(query.file_id, call + 1);
    return respond(200, {
      url: urls[Math.min(call, urls.length - 1)]!,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl:
        publicUrlsByFileId[query.file_id] ?? publicArtifactUrl(query.file_id),
    });
  });
}

type SplitAttachmentChat = {
  readonly threadId: string;
  readonly events: AttachmentChatEvent[];
  readonly artifacts?: readonly ChatThreadArtifactFile[];
  readonly title: string;
};

export function mockSplitAttachmentChats(
  context: TestContext,
  left: SplitAttachmentChat,
  right: SplitAttachmentChat,
): void {
  mockAttachmentChat(context, {
    threadId: left.threadId,
    chatEvents: left.events,
    artifacts: left.artifacts,
    threadTitle: left.title,
  });
  const chats = new Map(
    [left, right].map((chat) => {
      return [chat.threadId, chat] as const;
    }),
  );
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: threadListSnapshot(
          [left, right].map((chat) => {
            return {
              id: chat.threadId,
              title: chat.title,
              agent: { id: ATTACHMENT_AGENT_ID, avatarUrl: null },
              createdAt: "2026-03-10T00:00:00Z",
              updatedAt: "2026-03-10T00:00:00Z",
            };
          }),
        ),
        latestEventId: null,
        latestSeqId: null,
      }),
    );
  });
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      const chat = chats.get(params.threadId);
      if (!chat) {
        return respond(404, {
          error: { code: "THREAD_NOT_FOUND", message: "Thread not found" },
        });
      }
      const rows = mockChatEventRows(
        normalizeMockChatEvents(chat.events, params.threadId),
      )
        .filter((row) => {
          return row.seqId > query.sinceSeqId;
        })
        .slice(0, query.limit ?? 50);
      return respond(200, chatEventRowsResponse(rows, query));
    },
  );
  context.mocks.api(chatThreadArtifactsContract.list, ({ params, respond }) => {
    const chat = chats.get(params.threadId);
    if (!chat) {
      return respond(404, {
        error: { code: "THREAD_NOT_FOUND", message: "Thread not found" },
      });
    }
    return respond(200, {
      runs:
        chat.artifacts === undefined
          ? []
          : [{ runId: ATTACHMENT_RUN_ID, files: [...chat.artifacts] }],
    });
  });
}

export function userMessage(
  parts: UserMessageDocument["parts"],
): UserMessageDocument {
  return { version: 1, parts };
}

export function getNamedButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

export function queryNamedButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.trim() === name
      );
    }) ?? null
  );
}

export function queryNamedLink(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("link", container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.trim() === name
      );
    }) ?? null
  );
}

export function getNamedLink(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const links = queryAllByRoleFast("link", container);
  const link = links.find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!link) {
    const available = links.map((candidate) => {
      return candidate.getAttribute("aria-label") ?? candidate.textContent;
    });
    throw new Error(
      `Expected link named "${name}"; available links: ${JSON.stringify(available)}`,
    );
  }
  return link;
}

export function findNamedButton(
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    return getNamedButton(name, container);
  });
}

export function findNamedLink(
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    return getNamedLink(name, container);
  });
}

function getNamedMenuItem(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const menuItem = queryAllByRoleFast("menuitem", container).find(
    (candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.trim() === name
      );
    },
  );
  if (!menuItem) {
    throw new Error(`Expected menu item named "${name}"`);
  }
  return menuItem;
}

export function findNamedMenuItem(
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    return getNamedMenuItem(name, container);
  });
}

export function queryNamedButtons(
  name: string,
  container: ParentNode = document.body,
): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
}
