import {
  runsByIdContract,
  runAgentEventsContract,
  runsQueueContract,
  runsCancelContract,
  runContextContract,
  runNetworkLogsContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { queuePositionContract } from "@okouai/api-contracts/contracts/queue-position";
import { mockApi } from "../msw-contract.ts";

export const apiRunsHandlers = [
  // GET /api/runs/:id
  mockApi(runsByIdContract.getById, ({ respond }) =>
    respond(200, {
      runId: "a0000000-0000-4000-a000-000000000001",
      status: "completed",
      prompt: "Test prompt",
      appendSystemPrompt: null,
      source: {
        providerType: null,
        runtimeProviderType: null,
        model: null,
        credentialScope: null,
        account: { status: "unknown" },
      },
      result: { agentSessionId: "session-1", output: "" },
      createdAt: "2026-03-10T00:00:00Z",
    }),
  ),

  // GET /api/runs/:id/telemetry/agent
  mockApi(runAgentEventsContract.getAgentEvents, ({ respond }) =>
    respond(200, {
      events: [],
      hasMore: false,
      status: "completed",
      lastEventSequence: null,
    }),
  ),

  // GET /api/runs/queue
  mockApi(runsQueueContract.getQueue, ({ respond }) =>
    respond(200, {
      concurrency: {
        tier: "free",
        limit: 1,
        active: 0,
        available: 1,
        memberUsage: [],
      },
      queue: [],
      runningTasks: [],
      estimatedTimePerRun: 30_000,
    }),
  ),

  // POST /api/runs/:id/cancel
  mockApi(runsCancelContract.cancel, ({ params, respond }) =>
    respond(200, {
      id: params.id,
      status: "cancelled",
      message: "Run cancelled",
    }),
  ),

  // GET /api/runs/:id/context
  mockApi(runContextContract.getContext, ({ params, respond }) =>
    respond(200, {
      prompt: "Test prompt",
      appendSystemPrompt: null,
      runId: params.id,
      sessionId: null,
      secretNames: [],
      vars: null,
      environment: {},
      firewalls: [],
      networkPolicies: null,
      volumes: [],
      artifact: null,
      featureFlags: null,
    }),
  ),

  // GET /api/runs/:id/network
  mockApi(runNetworkLogsContract.getNetworkLogs, ({ respond }) =>
    respond(200, { networkLogs: [], hasMore: false }),
  ),

  // POST /api/chat/events
  mockApi(chatEventsContract.send, ({ respond }) =>
    respond(201, {
      runId: "a0000000-0000-4000-a000-000000000001",
      threadId: "b0000000-0000-4000-a000-000000000001",
      status: "pending",
      createdAt: "2026-03-10T00:00:00Z",
    }),
  ),

  // GET /api/queue-position
  mockApi(queuePositionContract.getPosition, ({ respond }) =>
    respond(200, { position: 0, total: 0 }),
  ),
];
