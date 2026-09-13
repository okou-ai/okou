/**
 * Tests for okou agent edit command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../../../mocks/server";
import { editCommand } from "../edit";
import chalk from "chalk";

const mockAgent = {
  agentId: "my-agent",
  isDefaultAgent: false,
  displayName: "My Agent",
  description: null,
  sound: null,
  avatarUrl: null,
  visibility: "private",
};

describe("okou agent edit command", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  describe("successful edit", () => {
    it("should update display name and show success", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.put(
          "http://localhost:3000/api/agents/my-agent",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({ ...mockAgent, displayName: "Updated" });
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--display-name",
        "Updated",
      ]);

      expect(capturedBody?.displayName).toBe("Updated");
      expect(capturedBody).not.toHaveProperty("visibility");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("updated");
    });

    it("should update agent metadata without workflow attachments in request body", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.put(
          "http://localhost:3000/api/agents/my-agent",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockAgent);
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--description",
        "Updated role",
      ]);

      expect(capturedBody?.description).toBe("Updated role");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("updated");
    });

    it("should update visibility", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.put(
          "http://localhost:3000/api/agents/my-agent",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({ ...mockAgent, visibility: "public" });
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--visibility",
        "public",
      ]);

      expect(capturedBody?.visibility).toBe("public");
    });

    it("should update avatar with preset and include it in request body", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.put(
          "http://localhost:3000/api/agents/my-agent",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockAgent);
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--avatar",
        "preset:3",
      ]);

      expect(capturedBody?.avatarUrl).toBe("preset:3");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("updated");
    });

    it("should compose svg avatar from descriptive flags", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.put(
          "http://localhost:3000/api/agents/my-agent",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockAgent);
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--avatar-hair-color",
        "teal",
        "--avatar-expression",
        "excited",
        "--avatar-intensity",
        "hyped",
      ]);

      expect(capturedBody?.avatarUrl).toBe("svg:r3s2h1c2f5h");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("updated");
    });

    it("should preserve existing avatar when no avatar flags given", async () => {
      const agentWithAvatar = { ...mockAgent, avatarUrl: "svg:r2s1h3c3f1m" };
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(agentWithAvatar);
        }),
        http.put(
          "http://localhost:3000/api/agents/my-agent",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(agentWithAvatar);
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--display-name",
        "Updated",
      ]);

      expect(capturedBody).not.toHaveProperty("avatarUrl");
    });

    describe("with instructions file", () => {
      let instructionsPath: string;

      beforeEach(() => {
        instructionsPath = join(tmpdir(), "new-instructions.md");
        writeFileSync(instructionsPath, "New instructions");
      });

      afterEach(() => {
        unlinkSync(instructionsPath);
      });

      it("should upload instructions content from file and show success message", async () => {
        let capturedInstructionsContent: string | undefined;
        server.use(
          http.get("http://localhost:3000/api/agents/my-agent", () => {
            return HttpResponse.json(mockAgent);
          }),
          http.put(
            "http://localhost:3000/api/agents/my-agent/instructions",
            async ({ request }) => {
              const body = (await request.json()) as { content: string };
              capturedInstructionsContent = body.content;
              return HttpResponse.json(mockAgent);
            },
          ),
        );

        await editCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--instructions-file",
          instructionsPath,
        ]);

        expect(capturedInstructionsContent).toBe("New instructions");
        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain("updated");
      });
    });
  });

  describe("default agent protection", () => {
    it.each([
      ["--display-name", "Renamed", "must keep the name Okou"],
      ["--avatar", "preset:2", "must keep its default avatar"],
      ["--visibility", "private", "must remain public"],
    ])(
      "rejects %s before metadata and instructions writes",
      async (flag, value, message) => {
        let writes = 0;
        server.use(
          http.get("http://localhost:3000/api/agents/my-agent", () => {
            return HttpResponse.json({
              ...mockAgent,
              isDefaultAgent: true,
              displayName: "Okou",
              visibility: "public",
            });
          }),
          http.put("http://localhost:3000/api/agents/my-agent", () => {
            writes++;
            return HttpResponse.json(mockAgent);
          }),
          http.put(
            "http://localhost:3000/api/agents/my-agent/instructions",
            () => {
              writes++;
              return HttpResponse.json(mockAgent);
            },
          ),
        );
        await expect(
          editCommand.parseAsync([
            "node",
            "cli",
            "my-agent",
            flag!,
            value!,
            "--description",
            "Must not be saved",
            "--instructions-file",
            "/unused-on-rejected-edit.md",
          ]),
        ).rejects.toThrow("process.exit called");
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockConsoleError).toHaveBeenCalledWith(
          expect.stringContaining(message!),
        );
        expect(writes).toBe(0);
      },
    );

    it("edits a default description and repeats canonical fields", async () => {
      const requests: unknown[] = [];
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            isDefaultAgent: true,
            displayName: "Okou",
            visibility: "public",
          });
        }),
        http.put(
          "http://localhost:3000/api/agents/my-agent",
          async ({ request }) => {
            requests.push(await request.json());
            return HttpResponse.json(mockAgent);
          },
        ),
      );
      await editCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--description",
        "New role",
        "--sound",
        "friendly",
      ]);
      await editCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--display-name",
        "Okou",
        "--visibility",
        "public",
      ]);
      expect(requests).toStrictEqual([
        { description: "New role", sound: "friendly" },
        { displayName: "Okou", visibility: "public" },
      ]);
    });
  });

  describe("validation", () => {
    it("should reject invalid visibility", async () => {
      await expect(async () => {
        await editCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--visibility",
          "unlisted",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail when no options provided", async () => {
      await expect(async () => {
        await editCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("At least one option is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject invalid avatar hair color", async () => {
      await expect(async () => {
        await editCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--avatar-hair-color",
          "purple",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid --avatar-hair-color"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject combining --avatar preset with --avatar-* flags", async () => {
      await expect(async () => {
        await editCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--avatar",
          "preset:0",
          "--avatar-skin",
          "dark",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("cannot be combined"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject unsupported model edit flags", async () => {
      await expect(async () => {
        await editCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--model-provider",
          "00000000-0000-4000-8000-000000000001",
          "--model",
          "claude-sonnet-4-6",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
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
        await editCommand.parseAsync([
          "node",
          "cli",
          "missing",
          "--display-name",
          "x",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
