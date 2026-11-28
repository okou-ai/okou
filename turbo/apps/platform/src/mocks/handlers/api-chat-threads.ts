import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  chatSearchContract,
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMetadataContract,
  chatThreadDraftContract,
  chatThreadMarkAllReadContract,
  chatThreadMarkReadContract,
  chatThreadComputerUseHostContract,
  chatThreadModelSelectionContract,
  chatThreadEventsContract,
  chatThreadUsageContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { mockApi } from "../msw-contract.ts";

export const chatThreadHandlers = [
  // GET /api/chat-drafts/composer
  mockApi(composerDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: null,
      draftAttachments: null,
    });
  }),

  // PATCH /api/chat-drafts/composer
  mockApi(composerDraftContract.patch, ({ respond }) => {
    return respond(204);
  }),

  // GET /api/chat-threads/snapshot
  mockApi(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });
  }),

  // GET /api/chat-threads/events
  mockApi(chatThreadsContract.events, ({ respond }) => {
    return respond(200, {
      events: [],
      hasMore: false,
    });
  }),

  // GET /api/chat/search
  mockApi(chatSearchContract.search, ({ respond }) => {
    return respond(200, { results: [] });
  }),

  // GET /api/indicators
  mockApi(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { threads: {}, unreadAt: {} });
  }),

  // GET /api/chat-thread-drafts
  mockApi(chatThreadsContract.drafts, ({ respond }) => {
    return respond(200, { draftThreadIds: [] });
  }),

  // POST /api/chat-threads (create new thread)
  mockApi(chatThreadsContract.create, ({ body, respond }) => {
    return respond(201, {
      id: body.clientThreadId ?? "b0000000-0000-4000-a000-000000000001",
      title: null,
      createdAt: "2026-03-10T00:00:00Z",
      selectedModel: body.model === undefined ? "claude-sonnet-5" : body.model,
      serviceTier: body.serviceTier ?? null,
    });
  }),

  mockApi(chatThreadUsageContract.read, ({ respond }) =>
    respond(200, { runs: [] }),
  ),

  // POST /api/chat/events/catch-up
  mockApi(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    return respond(200, {
      events: Object.fromEntries(
        body.map(([threadId]) => {
          return [threadId, []];
        }),
      ),
      notFoundThreads: [],
    });
  }),

  // GET /api/chat-threads/:threadId/event-snapshot
  mockApi(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(404, {
      error: {
        message: "Chat event snapshot not found",
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
      },
    });
  }),

  // GET /api/chat-threads/:threadId/event-rows
  mockApi(chatThreadEventsContract.rows, ({ respond }) => {
    return respond(200, {
      rows: [],
      cursor: { lastEventId: null, lastSeqId: 0 },
      hasMore: false,
    });
  }),

  // Canonical directory list, including thread-scoped resource panels.
  mockApi(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  }),

  // A message URL can have a content reader without a managed catalog entry.
  mockApi(artifactReferencesContract.byUrl, ({ respond }) =>
    respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    }),
  ),

  mockApi(chatRelationsContract.children, ({ respond }) => {
    return respond(200, { items: [] });
  }),

  mockApi(chatRelationsContract.communications, ({ respond }) => {
    return respond(200, { items: [] });
  }),

  // GET /api/chat-threads/:id (thread detail)
  mockApi(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: "2026-03-10T00:00:00Z",
      cancellationRecoveryPending: false,
    });
  }),

  // GET /api/chat-threads/:id/metadata
  mockApi(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "CHAT_THREAD_NOT_FOUND",
        message: "Chat thread not found",
      },
    });
  }),

  // GET /api/chat-threads/:id/draft
  mockApi(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: null,
      draftAttachments: null,
    });
  }),

  // PATCH /api/chat-threads/:id (update draft)
  mockApi(chatThreadByIdContract.patch, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/chat-threads/:id/model-selection
  mockApi(chatThreadModelSelectionContract.update, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/chat-threads/:id/computer-use-host
  mockApi(chatThreadComputerUseHostContract.update, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/chat-thread-unreads/mark-read
  mockApi(chatThreadMarkAllReadContract.markAllRead, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/chat-threads/:id/mark-read
  mockApi(chatThreadMarkReadContract.markRead, ({ respond }) => {
    return respond(200, { lastReadAt: null });
  }),
];
