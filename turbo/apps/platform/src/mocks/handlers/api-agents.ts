import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
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
  chatThreadArtifactsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { mockApi } from "../msw-contract.ts";

const DEFAULT_AGENTS: AgentResponse[] = [
  {
    agentId: "c0000000-0000-4000-a000-000000000001",
    isDefaultAgent: false,
    ownerId: "user_mock",
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
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
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
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

const mockEnabledConnectorSlugsByAgent = new Map<string, string[]>();
const mockCustomConnectorGrantsByAgent = new Map<
  string,
  AgentCustomConnectorGrant[]
>();

export function resetMockUserConnectors(): void {
  mockEnabledConnectorSlugsByAgent.clear();
  mockCustomConnectorGrantsByAgent.clear();
}

function mockConnectorUpdateResponse(
  current: readonly string[],
  requested: readonly string[],
  operation: "replace" | "add" | "remove" | undefined,
): string[] {
  if (operation === "add") {
    return Array.from(new Set([...current, ...requested]));
  }
  if (operation === "remove") {
    return current.filter((value) => {
      return !requested.includes(value);
    });
  }
  return [...requested];
}

function mockCustomConnectorGrantUpdateResponse(
  current: readonly AgentCustomConnectorGrant[],
  requested: readonly AgentCustomConnectorGrant[],
  operation: "replace" | "add" | "remove" | undefined,
): AgentCustomConnectorGrant[] {
  if (operation === "add") {
    const byConnectorId = new Map(
      current.map((grant) => {
        return [grant.customConnectorId, grant] as const;
      }),
    );
    for (const grant of requested) {
      byConnectorId.set(grant.customConnectorId, grant);
    }
    return [...byConnectorId.values()];
  }
  if (operation === "remove") {
    const removedIds = new Set(
      requested.map((grant) => {
        return grant.customConnectorId;
      }),
    );
    return current.filter((grant) => {
      return !removedIds.has(grant.customConnectorId);
    });
  }
  return [...requested];
}

export const apiAgentsHandlers = [
  // GET /api/agents
  mockApi(agentsMainContract.list, ({ respond }) => {
    return respond(200, mockAgents);
  }),

  // GET /api/agents/:id/user-connectors
  mockApi(userBuiltinConnectorsContract.get, ({ params, respond }) => {
    const enabledConnectorSlugs =
      mockEnabledConnectorSlugsByAgent.get(params.id) ?? [];
    return respond(200, {
      enabledConnectorSlugs,
    });
  }),

  // GET /api/agents/:id/custom-connectors
  mockApi(agentCustomConnectorsContract.get, ({ params, respond }) => {
    const grants = mockCustomConnectorGrantsByAgent.get(params.id) ?? [];
    return respond(200, { grants });
  }),

  // PUT /api/agents/:id/user-connectors
  mockApi(userBuiltinConnectorsContract.update, ({ body, params, respond }) => {
    const enabledConnectorSlugs = mockConnectorUpdateResponse(
      mockEnabledConnectorSlugsByAgent.get(params.id) ?? [],
      body.enabledConnectorSlugs,
      body.operation,
    );
    mockEnabledConnectorSlugsByAgent.set(params.id, enabledConnectorSlugs);
    return respond(200, {
      enabledConnectorSlugs,
    });
  }),

  // PUT /api/agents/:id/custom-connectors
  mockApi(agentCustomConnectorsContract.update, ({ body, params, respond }) => {
    const current = mockCustomConnectorGrantsByAgent.get(params.id) ?? [];
    const grants = mockCustomConnectorGrantUpdateResponse(
      current,
      body.grants,
      body.operation,
    );
    mockCustomConnectorGrantsByAgent.set(params.id, grants);
    return respond(200, { grants });
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
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
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

  // GET /api/agents/:id/draft
  mockApi(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: null,
      draftAttachments: null,
    });
  }),

  // PATCH /api/agents/:id/draft
  mockApi(agentDraftContract.patch, ({ respond }) => {
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
    return respond(200, { agents: {}, threads: {} });
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
      selectedModel: body.model ?? "claude-sonnet-4-6",
      serviceTier: body.serviceTier ?? null,
    });
  }),

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

  // GET /api/chat-threads/:threadId/artifacts
  mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, { runs: [] });
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

  // GET /api/chat-thread-unreads
  mockApi(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, { unreads: [] });
  }),

  // POST /api/chat-thread-unreads/mark-read
  mockApi(chatThreadMarkAgentReadContract.markAgentRead, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/chat-threads/:id/mark-read
  mockApi(chatThreadMarkReadContract.markRead, ({ respond }) => {
    return respond(200, { lastReadAt: null, unreads: [] });
  }),
];
