import { capturedRunToken } from "../../../test/fixtures/captured-run-token";
/**
 * Tests for okou workflow delete command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { deleteCommand } from "../delete";
import chalk from "chalk";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const WORKFLOW_ID = "22222222-2222-2222-2222-222222222222";
const RESOLVED_WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";

function detailResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "my-agent",
    agentDisplayName: "My Agent",
    name: "my-workflow",
    displayName: "My Workflow",
    description: null,
    visibility: "private",
    ownerUserId: "user-123",
    canManage: true,
    canPublish: true,
    instruction: "# Workflow",
    files: [],
    fileContents: [],
    automations: [],
    ...overrides,
  };
}

function workflowSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOLVED_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "my-agent",
    agentDisplayName: "My Agent",
    name: "tell-a-joke",
    displayName: "Tell a joke",
    description: null,
    visibility: "private",
    ownerUserId: "user-123",
    canManage: true,
    canPublish: true,
    shadowedBy: null,
    ...overrides,
  };
}

describe("okou workflow delete command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    server.use(
      http.get("*/api/agents", () => {
        return HttpResponse.json([{ agentId: AGENT_ID, isDefaultAgent: true }]);
      }),
    );
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", capturedRunToken(["agent:write"]));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("successful delete", () => {
    it("should delete with --yes flag without prompting", async () => {
      server.use(
        http.get(`http://localhost:3000/api/workflows/${WORKFLOW_ID}`, () => {
          return HttpResponse.json(detailResponse());
        }),
        http.delete(
          `http://localhost:3000/api/workflows/${WORKFLOW_ID}`,
          () => {
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );

      await deleteCommand.parseAsync(["node", "cli", WORKFLOW_ID, "--yes"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-workflow");
      expect(logCalls).toContain("deleted");
    });

    it("should resolve a workflow name before deleting", async () => {
      let deletedWorkflowId: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/workflows", () => {
          return HttpResponse.json([workflowSummary()]);
        }),
        http.get(
          `http://localhost:3000/api/workflows/${RESOLVED_WORKFLOW_ID}`,
          () => {
            return HttpResponse.json(
              detailResponse({
                id: RESOLVED_WORKFLOW_ID,
                name: "tell-a-joke",
                displayName: "Tell a joke",
              }),
            );
          },
        ),
        http.delete(
          "http://localhost:3000/api/workflows/:workflowId",
          ({ params }) => {
            deletedWorkflowId = params.workflowId as string;
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );

      await deleteCommand.parseAsync(["node", "cli", "tell-a-joke", "--yes"]);

      expect(deletedWorkflowId).toBe(RESOLVED_WORKFLOW_ID);
    });
  });

  describe("error handling", () => {
    it("should handle not found error", async () => {
      const missingId = "99999999-9999-9999-9999-999999999999";
      server.use(
        http.get(`http://localhost:3000/api/workflows/${missingId}`, () => {
          return HttpResponse.json(
            { error: { message: "Workflow not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", missingId, "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --yes in non-interactive mode", async () => {
      server.use(
        http.get(`http://localhost:3000/api/workflows/${WORKFLOW_ID}`, () => {
          return HttpResponse.json(detailResponse({ displayName: null }));
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", WORKFLOW_ID]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--yes flag is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
