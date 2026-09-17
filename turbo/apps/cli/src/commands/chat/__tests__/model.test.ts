/**
 * Tests for okou chat model command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend metadata, model policy, and model-selection routes via MSW
 * - Real (internal): CLI argument parsing, API client, env handling
 */

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { chatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000002";
const GET_URL = `http://localhost:3000/api/chat-threads/${THREAD_ID}/metadata`;
const OTHER_GET_URL = `http://localhost:3000/api/chat-threads/${OTHER_THREAD_ID}/metadata`;
const OTHER_MODEL_SELECTION_URL = `http://localhost:3000/api/chat-threads/${OTHER_THREAD_ID}/model-selection`;
const MODEL_POLICIES_URL = "http://localhost:3000/api/model-policies";

const MODEL_POLICIES_RESPONSE = {
  workspaceDefaultModel: "claude-sonnet-5",
  workspaceDefaultPolicyId: "00000000-0000-4000-8000-000000000101",
  policies: [
    {
      id: "00000000-0000-4000-8000-000000000101",
      model: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      isDefault: true,
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      model: "gpt-5.6-luna",
      modelLabel: "GPT 5.6 Luna",
      isDefault: false,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
      routeStatus: "missing_provider",
      routeStatusReason: "No personal subscription connected",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000103",
      model: "deepseek-v4-flash",
      modelLabel: "DeepSeek V4 Flash",
      isDefault: false,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("okou chat model command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("shows dynamic help with switchable models", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);
    server.use(
      http.get(MODEL_POLICIES_URL, () => {
        return HttpResponse.json(MODEL_POLICIES_RESPONSE);
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "model", "--help"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Usage: chat model");
    expect(output).toContain("Switchable models:");
    expect(output).toContain("Claude Sonnet 5");
    expect(output).toContain("claude-sonnet-5");
    expect(output).toContain("--thread <id>");
    expect(output).not.toContain("No personal subscription connected");
    expect(output).not.toContain("gpt-5.6-luna");
  });

  it("prints the current chat model and switchable models without an argument", async () => {
    server.use(
      http.get(GET_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          id: THREAD_ID,
          title: "Launch plan",
          selectedModel: "claude-sonnet-5",
        });
      }),
      http.get(MODEL_POLICIES_URL, () => {
        return HttpResponse.json(MODEL_POLICIES_RESPONSE);
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "model"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat thread loaded");
    expect(output).toContain("Model:  Claude Sonnet 5 (claude-sonnet-5)");
    expect(output).toContain("Switchable models:");
    expect(output).toContain("provider: built-in (Built-in model; built-in)");
    expect(output).toContain(`okou chat model --thread ${THREAD_ID} <model>`);
  });

  it("shows the model for --thread outside a web chat environment", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);
    server.use(
      http.get(OTHER_GET_URL, () => {
        return HttpResponse.json({
          id: OTHER_THREAD_ID,
          title: "Daily report",
          selectedModel: "claude-sonnet-5",
        });
      }),
      http.get(MODEL_POLICIES_URL, () => {
        return HttpResponse.json(MODEL_POLICIES_RESPONSE);
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "model",
      "--thread",
      OTHER_THREAD_ID,
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(`Thread: ${OTHER_THREAD_ID}`);
    expect(output).toContain("Model:  Claude Sonnet 5 (claude-sonnet-5)");
  });

  it("switches the model for --thread outside a web chat environment", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);
    server.use(
      http.get(MODEL_POLICIES_URL, () => {
        return HttpResponse.json(MODEL_POLICIES_RESPONSE);
      }),
      http.post(OTHER_MODEL_SELECTION_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        await expect(request.json()).resolves.toStrictEqual({
          model: "claude-sonnet-5",
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "model",
      "--thread",
      OTHER_THREAD_ID,
      "claude-sonnet-5",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat model updated");
    expect(output).toContain(`Thread: ${OTHER_THREAD_ID}`);
    expect(output).toContain("Model:  Claude Sonnet 5 (claude-sonnet-5)");
  });

  it("rejects models that are not switchable for this user", async () => {
    server.use(
      http.get(MODEL_POLICIES_URL, () => {
        return HttpResponse.json(MODEL_POLICIES_RESPONSE);
      }),
    );

    await expect(async () => {
      await chatCommand.parseAsync(["node", "cli", "model", "gpt-5.6-luna"]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Model is not switchable: gpt-5.6-luna");
    expect(stderr).toContain("No personal subscription connected");
    expect(stderr).toContain("Run: okou chat model --help");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
  it("offers and switches a personal candidate despite a missing administrative provider", async () => {
    server.use(
      http.get(MODEL_POLICIES_URL, () => {
        return HttpResponse.json({
          ...MODEL_POLICIES_RESPONSE,
          policies: [
            {
              ...MODEL_POLICIES_RESPONSE.policies[1],
              defaultProviderType: "openai-api-key",
              credentialScope: "org",
              memberEffective: {
                providerType: "codex-oauth-token",
                runtimeProviderType: "codex-oauth-token",
                credentialScope: "member",
                availability: "available",
                accountSelection: "capture_required",
              },
            },
          ],
        });
      }),
      http.post(OTHER_MODEL_SELECTION_URL, async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({
          model: "gpt-5.6-luna",
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "model", "--help"]);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "provider: subscription (ChatGPT (Codex); codex-oauth-token)",
    );
    await chatCommand.parseAsync([
      "node",
      "cli",
      "model",
      "--thread",
      OTHER_THREAD_ID,
      "gpt-5.6-luna",
    ]);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Chat model updated",
    );
  });

  it.each(["reconnect_required", "plan_restricted", "unavailable"])(
    "rejects a %s member route despite a valid administrative provider",
    async (availability) => {
      server.use(
        http.get(MODEL_POLICIES_URL, () => {
          return HttpResponse.json({
            ...MODEL_POLICIES_RESPONSE,
            policies: [
              {
                ...MODEL_POLICIES_RESPONSE.policies[0],
                memberEffective: {
                  providerType: "claude-code-oauth-token",
                  runtimeProviderType: "claude-code-oauth-token",
                  credentialScope: "member",
                  availability,
                  accountSelection: "capture_required",
                },
              },
            ],
          });
        }),
      );

      await expect(
        chatCommand.parseAsync(["node", "cli", "model", "claude-sonnet-5"]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        availability,
      );
    },
  );
});
