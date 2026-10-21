/**
 * App Logs API Handlers
 *
 * Mock handlers for /api/logs endpoints
 */

import {
  logsByIdContract,
  type LogDetail,
} from "@okouai/api-contracts/contracts/logs";
import { mockApi } from "../msw-contract.ts";

// Mock data for log details
const mockLogDetails: LogDetail[] = [
  {
    id: "a0000000-0000-4000-a000-000000000001",
    sessionId: "session_1",
    agentId: "test-agent",
    displayName: null,
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    status: "completed",
    prompt: "Test prompt",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2024-01-01T00:00:00Z",
    startedAt: "2024-01-01T00:00:01Z",
    completedAt: "2024-01-01T00:00:10Z",
  },
  {
    id: "a0000000-0000-4000-a000-000000000002",
    sessionId: "session_2",
    agentId: "another-agent",
    displayName: null,
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "test",
    status: "completed",
    prompt: "Another prompt",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2024-01-02T00:00:00Z",
    startedAt: "2024-01-02T00:00:01Z",
    completedAt: "2024-01-02T00:00:10Z",
  },
];

export const appLogsHandlers = [
  // GET /api/logs/:id - Get log detail
  mockApi(logsByIdContract.getById, ({ params, respond }) => {
    const { id } = params;
    const logDetail = mockLogDetails.find((log) => log.id === id);

    if (!logDetail) {
      return respond(404, {
        error: { message: "Log not found", code: "NOT_FOUND" },
      });
    }

    return respond(200, logDetail);
  }),
];
