/**
 * Tests for okou workflow edit command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../../../mocks/server";
import { editCommand } from "../edit";
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
    instruction: "Updated instruction",
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

describe("okou workflow edit command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let workflowDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    workflowDir = join(tmpdir(), `test-workflow-edit-${Date.now()}`);
    mkdirSync(workflowDir, { recursive: true });
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(workflowDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe("successful edit", () => {
    it("should send new instruction via PATCH", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.patch(
          `http://localhost:3000/api/workflows/${WORKFLOW_ID}`,
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(detailResponse());
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        WORKFLOW_ID,
        "--instruction",
        "New steps",
      ]);

      expect(capturedBody?.instruction).toBe("New steps");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-workflow");
      expect(logCalls).toContain("updated");
    });

    it("should resolve a workflow name before PATCH", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      let patchedWorkflowId: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/workflows", () => {
          return HttpResponse.json([workflowSummary()]);
        }),
        http.patch(
          "http://localhost:3000/api/workflows/:workflowId",
          async ({ request, params }) => {
            patchedWorkflowId = params.workflowId as string;
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              detailResponse({
                id: RESOLVED_WORKFLOW_ID,
                name: "tell-a-joke",
                displayName: "Tell a joke",
              }),
            );
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        "tell-a-joke",
        "--agent",
        AGENT_ID,
        "--description",
        "Updated description",
      ]);

      expect(patchedWorkflowId).toBe(RESOLVED_WORKFLOW_ID);
      expect(capturedBody?.description).toBe("Updated description");
    });

    it("should send supplementary files from --dir", async () => {
      writeFileSync(join(workflowDir, "notes.md"), "Some notes.");

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.patch(
          `http://localhost:3000/api/workflows/${WORKFLOW_ID}`,
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(detailResponse());
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        WORKFLOW_ID,
        "--dir",
        workflowDir,
      ]);

      const files = capturedBody?.files as
        Array<{ path: string; content: string }> | undefined;
      expect(files).toBeDefined();
      expect(files).toHaveLength(1);
      expect(files?.[0]?.path).toBe("notes.md");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("1 file(s)");
    });
  });

  describe("error handling", () => {
    it("should fail when no update option is provided", async () => {
      await expect(async () => {
        await editCommand.parseAsync(["node", "cli", WORKFLOW_ID]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Nothing to update"),
      );
    });

    it("should reject SKILL.md in supplementary directory", async () => {
      writeFileSync(join(workflowDir, "SKILL.md"), "# nope");

      await expect(async () => {
        await editCommand.parseAsync([
          "node",
          "cli",
          WORKFLOW_ID,
          "--dir",
          workflowDir,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("SKILL.md is reserved"),
      );
    });
  });
});
