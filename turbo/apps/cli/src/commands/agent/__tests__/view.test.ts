/**
 * Tests for okou agent view command
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

const mockAgent = {
  agentId: "comp_abc123",
  displayName: "My Agent",
  description: "A test agent",
  sound: "professional",
  visibility: "private",
};

describe("okou agent view command", () => {
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

  describe("successful view", () => {
    it("should display agent info", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("comp_abc123");
      expect(logCalls).toContain("A test agent");
      expect(logCalls).toContain("professional");
      expect(logCalls).toContain("Visibility:   private");
    });

    it("should display preset avatar", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            avatarUrl: "preset:2",
          });
        }),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Avatar:");
      expect(logCalls).toContain(
        "preset:2 (medium skin, pink hair, neutral, chill)",
      );
    });

    it("should display custom svg avatar", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            avatarUrl: "svg:r3s4h1c2f5h",
          });
        }),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Avatar:");
      expect(logCalls).toContain(
        "custom (dark skin, teal hair, excited, hyped)",
      );
    });

    it("should not display avatar when null", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            avatarUrl: null,
          });
        }),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("Avatar:");
    });

    it("should show instructions content with --instructions flag", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/instructions",
          () => {
            return HttpResponse.json({
              content: "Do the thing",
              filename: "CLAUDE.md",
            });
          },
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--instructions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Do the thing");
    });

    it("should show empty instructions message when no instructions set", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/instructions",
          () => {
            return HttpResponse.json({ content: null, filename: null });
          },
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--instructions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No instructions set");
    });
  });

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
        await viewCommand.parseAsync(["node", "cli", "missing"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
