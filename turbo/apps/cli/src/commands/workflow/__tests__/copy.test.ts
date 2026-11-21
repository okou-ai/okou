import { capturedRunToken } from "../../../test/fixtures/captured-run-token";
/**
 * Tests for okou workflow copy command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { copyCommand } from "../copy";
import chalk from "chalk";

const SOURCE_ID = "22222222-2222-2222-2222-222222222222";
const TARGET_AGENT_ID = "33333333-3333-3333-3333-333333333333";
const NEW_ID = "44444444-4444-4444-4444-444444444444";
const SOURCE_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const RESOLVED_SOURCE_ID = "66666666-6666-4666-8666-666666666666";
const AUTOMATION_ID = "77777777-7777-4777-8777-777777777777";
const THREAD_ID = "88888888-8888-4888-8888-888888888888";

const copiedAutomation = {
  id: AUTOMATION_ID,
  kind: "schedule",
  ownerUserId: "user-123",
  enabled: true,
  chatThreadId: THREAD_ID,
  nextRunAt: "2026-07-23T01:00:00Z",
  lastRunAt: null,
  schedule: {
    type: "cron",
    cronExpression: "0 9 * * *",
    timezone: "Asia/Shanghai",
  },
  scheduleSummary: "0 9 * * * (Asia/Shanghai)",
};

function workflowSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOLVED_SOURCE_ID,
    agentId: SOURCE_AGENT_ID,
    agentName: "source-agent",
    agentDisplayName: "Source Agent",
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

describe("okou workflow copy command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
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

  describe("successful copy", () => {
    beforeEach(() => {
      server.use(
        http.get("*/api/workflows/:workflowId", () => {
          return HttpResponse.json(workflowSummary());
        }),
        http.get("*/api/workflows", () => {
          return HttpResponse.json([]);
        }),
      );
    });

    it("should make a private workspace copy", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          `http://localhost:3000/api/workflows/${SOURCE_ID}/copy`,
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              {
                id: NEW_ID,
                agentId: TARGET_AGENT_ID,
                agentName: "target-agent",
                agentDisplayName: "Target Agent",
                name: "my-workflow",
                displayName: "My Workflow",
                description: "Research customer activity",
                visibility: "private",
                ownerUserId: "user-123",
                canManage: true,
                canPublish: true,
              },
              { status: 201 },
            );
          },
        ),
        http.get(
          "http://localhost:3000/api/workflows/:workflowId/automations",
          ({ params }) => {
            expect(params.workflowId).toBe(NEW_ID);
            return HttpResponse.json([copiedAutomation]);
          },
        ),
      );

      await copyCommand.parseAsync(["node", "cli", SOURCE_ID]);

      expect(capturedBody).toStrictEqual({});
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("copied");
      expect(logCalls).toContain(NEW_ID);
      expect(logCalls).toContain("Name:         my-workflow");
      expect(logCalls).toContain("Visibility:   private");
      expect(logCalls).not.toContain("Agent Name:   Target Agent");
      expect(logCalls).not.toContain(`Agent ID:     ${TARGET_AGENT_ID}`);
      expect(logCalls).toContain("Display Name: My Workflow");
      expect(logCalls).toContain("Description:  Research customer activity");
      expect(logCalls).toContain("Copied automations (1)");
      expect(logCalls).toContain(AUTOMATION_ID);
      expect(logCalls).toContain("enabled");
      expect(logCalls).toContain("0 9 * * * (Asia/Shanghai)");
    });

    it("should resolve a source workflow name before copying", async () => {
      let copiedWorkflowId: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/workflows", () => {
          return HttpResponse.json([
            { ...workflowSummary(), visibility: "public" },
          ]);
        }),
        http.post(
          "http://localhost:3000/api/workflows/:workflowId/copy",
          ({ params }) => {
            copiedWorkflowId = params.workflowId as string;
            return HttpResponse.json(
              {
                id: NEW_ID,
                agentId: TARGET_AGENT_ID,
                agentName: "target-agent",
                agentDisplayName: "Target Agent",
                name: "tell-a-joke",
                displayName: "Tell a joke",
                description: null,
                visibility: "private",
                ownerUserId: "user-123",
                canManage: true,
                canPublish: true,
              },
              { status: 201 },
            );
          },
        ),
        http.get(
          "http://localhost:3000/api/workflows/:workflowId/automations",
          ({ params }) => {
            expect(params.workflowId).toBe(NEW_ID);
            return HttpResponse.json([]);
          },
        ),
      );

      await copyCommand.parseAsync(["node", "cli", "tell-a-joke"]);

      expect(copiedWorkflowId).toBe(RESOLVED_SOURCE_ID);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Copied automations (0)");
      expect(logCalls).toContain("No automations copied");
    });
  });

  describe("error handling", () => {
    it("should handle workflow not found", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/workflows/${SOURCE_ID}/copy`,
          () => {
            return HttpResponse.json(
              { error: { message: "Workflow not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await copyCommand.parseAsync(["node", "cli", SOURCE_ID]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
