/**
 * Tests for okou agent delete command
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

const mockAgent = {
  agentId: "my-agent",
  isDefaultAgent: false,
  displayName: "My Agent",
  description: null,
  sound: null,
  connectors: ["github"],
};

describe("okou agent delete command", () => {
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
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("successful delete", () => {
    it("should delete with --yes flag without prompting", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.delete("http://localhost:3000/api/agents/my-agent", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await deleteCommand.parseAsync(["node", "cli", "my-agent", "--yes"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-agent");
      expect(logCalls).toContain("deleted");
    });
  });

  it.each([[true, "cannot be deleted"]])(
    "rejects deletion before confirmation for identity %s",
    async (identity, message) => {
      let deletes = 0;
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json({ ...mockAgent, isDefaultAgent: identity });
        }),
        http.delete("http://localhost:3000/api/agents/my-agent", () => {
          deletes++;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      await expect(
        deleteCommand.parseAsync(["node", "cli", "my-agent", "--yes"]),
      ).rejects.toThrow("process.exit called");
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(message!),
      );
      expect(deletes).toBe(0);
    },
  );

  describe("error handling", () => {
    it("should handle not found error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/missing", () => {
          return HttpResponse.json(
            { error: { message: "Agent not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "missing", "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --yes in non-interactive mode", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
      );

      // process.stdout.isTTY is undefined in test environment (non-interactive)
      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--yes flag is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
