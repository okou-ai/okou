import { composerDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  agentsByIdContract,
  agentsMainContract,
  agentInstructionsContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  chatSearchContract,
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMetadataContract,
  chatThreadDraftContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadComputerUseHostContract,
  chatThreadModelSelectionContract,
  chatThreadEventsContract,
  chatThreadUsageContract,
  chatThreadArtifactsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { mockApi } from "../msw-contract.ts";

const DEFAULT_AGENTS: AgentResponse[] = [
  {
    agentId: "c0000000-0000-4000-a000-000000000001",
    isDefaultAgent: true,
    ownerId: "user_mock",
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "private",
  },
];

let mockAgents: AgentResponse[] = [...DEFAULT_AGENTS];

type MockAgentResponse = Pick<AgentResponse, "agentId"> &
  Partial<Omit<AgentResponse, "agentId">>;

function createMockAgentResponse(agent: MockAgentResponse): AgentResponse {
  return {
    isDefaultAgent: false,
    ownerId: "user_mock",
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "private",
    ...agent,
  };
}

export function setMockAgents(agents: MockAgentResponse[]): void {
  mockAgents = agents.map((agent) => {
    return createMockAgentResponse(agent);
  });
}

export function resetMockAgents(): void {
  mockAgents = [...DEFAULT_AGENTS];
}

export const apiAgentsHandlers = [
  // GET /api/agents
  mockApi(agentsMainContract.list, ({ respond }) => {
    return respond(200, mockAgents);
  }),

  // GET /api/agents/:id
  mockApi(agentsByIdContract.get, ({ respond }) => {
    return respond(200, {
      agentId: "c0000000-0000-4000-a000-000000000001",
      isDefaultAgent: false,
      ownerId: "test-user-123",
      description: null,
      displayName: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    });
  }),

  // GET /api/agents/:id/instructions
  mockApi(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, {
      content: null,
      filename: null,
    });
  }),

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
    return respond(200, { agents: {}, threads: {}, unreadAt: {} });
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

  // Legacy transcript attachment metadata, not the thread resource list.
  mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, { runs: [] });
  }),

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
  mockApi(chatThreadMarkAgentReadContract.markAgentRead, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/chat-threads/:id/mark-read
  mockApi(chatThreadMarkReadContract.markRead, ({ respond }) => {
    return respond(200, { lastReadAt: null });
  }),
];
