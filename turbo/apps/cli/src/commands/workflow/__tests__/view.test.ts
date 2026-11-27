import { capturedRunToken } from "../../../test/fixtures/captured-run-token";
/**
 * Tests for okou workflow view command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { viewCommand } from "../view";
import chalk from "chalk";

const WORKFLOW_ID = "22222222-2222-2222-2222-222222222222";
const PRIVATE_WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const OFFICIAL_WORKFLOW_ID = "44444444-4444-4444-8444-444444444444";

const OFFICIAL_METADATA = {
  definitionName: "tell-a-joke",
  installationState: "installed",
  definitionLifecycle: "active",
  readOnly: true,
};

function workflowSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: "tell-a-joke",
    displayName: "Tell a joke",
    description: "Tell one short joke",
    visibility: "public",
    ownerUserId: "user-123",
    canManage: true,
    canPublish: false,
    shadowedBy: null,
    ...overrides,
  };
}

describe("okou workflow view command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const ownerProfileRequest = vi.fn(() => {
    return HttpResponse.json({ displayName: null, imageUrl: null });
  });

  beforeEach(() => {
    server.use(
      http.get(
        "http://localhost:3000/api/workflows/:workflowId/owner-profile",
        ownerProfileRequest,
      ),
    );
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", capturedRunToken([]));
  });

  afterEach(() => {
    expect(ownerProfileRequest).not.toHaveBeenCalled();
    ownerProfileRequest.mockClear();
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("successful view", () => {
    it("keeps explicit-ID access to an Official Workflow", async () => {
      server.use(
        http.get(
          `http://localhost:3000/api/workflows/${OFFICIAL_WORKFLOW_ID}`,
          () => {
            return HttpResponse.json({
              ...workflowSummary({
                id: OFFICIAL_WORKFLOW_ID,
                visibility: "private",
                official: OFFICIAL_METADATA,
                canManage: false,
              }),
              instruction: "Read the official instructions by ID.",
              files: [],
              fileContents: [],
              automations: [],
            });
          },
        ),
      );

      await viewCommand.parseAsync(["node", "cli", OFFICIAL_WORKFLOW_ID]);

      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        "Read the official instructions by ID.",
      );
    });

    it("should display workflow with instruction", async () => {
      server.use(
        http.get(`http://localhost:3000/api/workflows/${WORKFLOW_ID}`, () => {
          return HttpResponse.json({
            id: WORKFLOW_ID,
            name: "my-workflow",
            displayName: "My Workflow",
            description: "A helpful workflow",
            visibility: "private",
            ownerUserId: "user-123",
            canManage: true,
            canPublish: true,
            instruction: "Do helpful things.",
            files: [],
            fileContents: [],
            automations: [],
          });
        }),
      );

      await viewCommand.parseAsync(["node", "cli", WORKFLOW_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-workflow");
      expect(logCalls).toContain("My Workflow");
      expect(logCalls).toContain("A helpful workflow");
      expect(logCalls).toContain("Do helpful things.");
    });

    it("should resolve a workflow name in the workspace using the runtime winner", async () => {
      let capturedUrl: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/workflows", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json([
            workflowSummary({
              id: WORKFLOW_ID,
              shadowedBy: {
                id: PRIVATE_WORKFLOW_ID,
                name: "tell-a-joke",
                displayName: "Tell a joke private",
              },
            }),
            workflowSummary({
              id: PRIVATE_WORKFLOW_ID,
              visibility: "private",
              displayName: "Tell a joke private",
              shadowedBy: null,
            }),
          ]);
        }),
        http.get(
          `http://localhost:3000/api/workflows/${PRIVATE_WORKFLOW_ID}`,
          () => {
            return HttpResponse.json({
              ...workflowSummary({
                id: PRIVATE_WORKFLOW_ID,
                visibility: "private",
                displayName: "Tell a joke private",
              }),
              instruction: "Tell one short joke.",
              files: [],
              fileContents: [],
              automations: [],
            });
          },
        ),
      );

      await viewCommand.parseAsync(["node", "cli", "tell-a-joke"]);

      expect(capturedUrl).toContain("scope=workspace");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`ID:           ${PRIVATE_WORKFLOW_ID}`);
      expect(logCalls).toContain("Tell a joke private");
    });
  });

  describe("error handling", () => {
    it("should reject invalid workflow refs before sending requests", async () => {
      await expect(async () => {
        await viewCommand.parseAsync(["node", "cli", "/tell-a-joke"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid workflow ref"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle workflow not found", async () => {
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
        await viewCommand.parseAsync(["node", "cli", missingId]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
