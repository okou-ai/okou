import { capturedRunToken } from "../../../test/fixtures/captured-run-token";
/**
 * Tests for okou workflow create command
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
import { createCommand } from "../create";
import chalk from "chalk";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const CHAT_THREAD_ID = "33333333-3333-4333-8333-333333333333";

const mockWorkflow = {
  id: "22222222-2222-2222-2222-222222222222",
  agentId: AGENT_ID,
  agentName: "my-agent",
  agentDisplayName: "My Agent",
  name: "my-workflow",
  displayName: "My Workflow",
  description: "A test workflow",
  visibility: "private",
  ownerUserId: "user-123",
  canManage: true,
  canPublish: true,
};

describe("okou workflow create command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let workflowDir: string;

  beforeEach(() => {
    server.use(
      http.get("*/api/agents", () => {
        return HttpResponse.json([{ agentId: AGENT_ID, isDefaultAgent: true }]);
      }),
    );
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", capturedRunToken(["agent:write"]));
    vi.stubEnv("OKOU_AGENT_ID", "");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "");

    workflowDir = join(tmpdir(), `test-workflow-${Date.now()}`);
    mkdirSync(workflowDir, { recursive: true });
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(workflowDir, { recursive: true, force: true });
  });

  describe("successful create", () => {
    it("should send instruction and supplementary files from --dir", async () => {
      mkdirSync(join(workflowDir, "templates"), { recursive: true });
      writeFileSync(
        join(workflowDir, "templates", "prompt.md"),
        "You are a helpful assistant.",
      );

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/workflows",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockWorkflow, { status: 201 });
          },
        ),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "my-workflow",
        "--instruction",
        "Summarize the inbox",
        "--dir",
        workflowDir,
        "--display-name",
        "My Workflow",
        "--description",
        "A test workflow",
      ]);

      expect(capturedBody?.agentId).toBe(AGENT_ID);
      expect(capturedBody?.name).toBe("my-workflow");
      expect(capturedBody?.instruction).toBe("Summarize the inbox");
      expect(capturedBody?.displayName).toBe("My Workflow");

      const files = capturedBody?.files as Array<{
        path: string;
        content: string;
      }>;
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe("templates/prompt.md");
      expect(files[0]?.content).toBe("You are a helpful assistant.");

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-workflow");
      expect(logCalls).toContain("created");
      expect(logCalls).not.toContain("Agent Name:   My Agent");
      expect(logCalls).not.toContain(`Agent ID:     ${AGENT_ID}`);
      expect(logCalls).toContain("1 file(s)");
    });

    it("should forward OKOU_CHAT_THREAD_ID when creating from a chat thread", async () => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
      vi.stubEnv("OKOU_CHAT_THREAD_ID", CHAT_THREAD_ID);

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/workflows",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockWorkflow, { status: 201 });
          },
        ),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "my-workflow",
        "--instruction",
        "Do things",
      ]);

      expect(capturedBody?.agentId).toBe(AGENT_ID);
      expect(capturedBody?.chatThreadId).toBe(CHAT_THREAD_ID);
    });
  });

  describe("error handling", () => {
    it("should fail when the workspace has no executor", async () => {
      server.use(
        http.get("*/api/agents", () => {
          return HttpResponse.json([]);
        }),
      );
      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "my-workflow",
          "--instruction",
          "Do things",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("no available Okou executor"),
      );
    });

    it("should reject SKILL.md in supplementary directory", async () => {
      writeFileSync(join(workflowDir, "SKILL.md"), "# nope");

      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "my-workflow",
          "--instruction",
          "Do things",
          "--dir",
          workflowDir,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("SKILL.md is reserved"),
      );
    });

    it("should handle authentication error", async () => {
      server.use(
        http.post("http://localhost:3000/api/workflows", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "my-workflow",
          "--instruction",
          "Do things",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
