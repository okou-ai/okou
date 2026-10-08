/**
 * Tests for okou chat model command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend metadata, run-model, and model-selection routes via MSW
 * - Real (internal): CLI argument parsing, API client, env handling
 */

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MODEL_CATALOG_RESPONSE } from "../../../mocks/handlers/model-catalog";
import { server } from "../../../mocks/server";
import { chatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000002";
const GET_URL = `http://localhost:3000/api/chat-threads/${THREAD_ID}/metadata`;
const OTHER_GET_URL = `http://localhost:3000/api/chat-threads/${OTHER_THREAD_ID}/metadata`;
const OTHER_MODEL_SELECTION_URL = `http://localhost:3000/api/chat-threads/${OTHER_THREAD_ID}/model-selection`;
const MODEL_SELECTION_URL = `http://localhost:3000/api/chat-threads/${THREAD_ID}/model-selection`;
const MODEL_RUN_MODELS_URL = "http://localhost:3000/api/run-models";

const AVAILABLE_MODELS_RESPONSE = {
  models: [
    {
      model: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      modelProviderId: null,
      memberEffective: {
        providerType: "claude-code-oauth-token",
        runtimeProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        availability: "available",
        accountSelection: "capture_required",
      },
    },
    {
      model: "gpt-5.6-luna",
      modelLabel: "GPT 5.6 Luna",
      modelProviderId: null,
      memberEffective: {
        providerType: "codex-oauth-token",
        runtimeProviderType: "codex-oauth-token",
        credentialScope: "member",
        availability: "reconnect_required",
        accountSelection: "capture_required",
      },
    },
    {
      model: null,
      modelLabel: "Auto",
      modelProviderId: null,
      memberEffective: {
        providerType: "built-in",
        runtimeProviderType: "openrouter-codex",
        credentialScope: "org",
        availability: "available",
        accountSelection: "not_applicable",
      },
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
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json(AVAILABLE_MODELS_RESPONSE);
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "model", "--help"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Usage: chat model");
    expect(output).toContain("Switchable models:");
    expect(output).toContain("Claude Sonnet 5");
    expect(output).toContain("claude-sonnet-5");
    expect(output).toContain("--thread <id>");
    expect(output).toContain("--effort <level>");
    expect(output).toContain("Claude uses extra where Codex uses xhigh");
    expect(output).toContain(
      "efforts: low, medium, high, extra, max, ultracode",
    );
    expect(output).not.toContain("gpt-5.6-luna");
    expect(output).toContain("Auto (auto) (default)");
  });

  it("prints the current chat model and switchable models without an argument", async () => {
    server.use(
      http.get(GET_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          id: THREAD_ID,
          title: "Launch plan",
          selectedModel: "claude-sonnet-5",
          modelSettings: {},
        });
      }),
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json(AVAILABLE_MODELS_RESPONSE);
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "model"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat thread loaded");
    expect(output).toContain(
      "Model:  Claude Sonnet 5 (claude-sonnet-5) · effort high",
    );
    expect(output).toContain("Switchable models:");
    expect(output).toContain("provider: built-in (Built-in model; built-in)");
    expect(output).toContain(`okou chat model --thread ${THREAD_ID} <model>`);
  });

  it("shows Auto for a null selection", async () => {
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          title: "Launch plan",
          selectedModel: null,
        });
      }),
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json(AVAILABLE_MODELS_RESPONSE);
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "model"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Model:  Auto\n");
    expect(output).toContain("Auto (auto) (default)");
  });

  it("switches to Auto with auto by sending a null selection", async () => {
    server.use(
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json(AVAILABLE_MODELS_RESPONSE);
      }),
      http.post(MODEL_SELECTION_URL, async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({ model: null });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "model", "auto"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat model updated");
    expect(output).toContain("Model:  Auto");
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
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json(AVAILABLE_MODELS_RESPONSE);
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
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json(AVAILABLE_MODELS_RESPONSE);
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

  it("switches a model and effort together without a tier patch so the server preserves it", async () => {
    server.use(
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json({
          ...AVAILABLE_MODELS_RESPONSE,
          models: [
            {
              ...AVAILABLE_MODELS_RESPONSE.models[0],
              model: "claude-opus-5-5",
              modelLabel: "Claude Opus 5.5",
            },
          ],
        });
      }),
      http.post(OTHER_MODEL_SELECTION_URL, async ({ request }) => {
        expect(await request.json()).toStrictEqual({
          model: "claude-opus-5-5",
          reasoningEffort: "extra",
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
      "claude-opus-5-5",
      "--effort",
      "extra",
    ]);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Model:  Claude Opus 5.5 (claude-opus-5-5) · effort extra",
    );
  });

  it("updates only effort by reading and resending the selected model", async () => {
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          selectedModel: "gpt-6-sol",
          serviceTier: "priority",
          modelSettings: { "gpt-6-sol": { effort: "high" } },
        });
      }),
      http.post(MODEL_SELECTION_URL, async ({ request }) => {
        expect(await request.json()).toStrictEqual({
          model: "gpt-6-sol",
          reasoningEffort: "max",
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await chatCommand.parseAsync(["node", "cli", "model", "--effort", "max"]);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "gpt-6-sol) · effort max",
    );
  });

  it("validates an effort-only change on an Auto thread against Auto", async () => {
    let requests = 0;
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          selectedModel: null,
          modelSettings: {},
        });
      }),
      http.post(MODEL_SELECTION_URL, () => {
        requests++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(
      chatCommand.parseAsync(["node", "cli", "model", "--effort", "max"]),
    ).rejects.toThrow("process.exit called");
    expect(requests).toBe(0);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Auto supports: none",
    );
  });

  it("rejects an unsupported model-effort pair before sending a request", async () => {
    let requests = 0;
    server.use(
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json({
          ...AVAILABLE_MODELS_RESPONSE,
          models: [
            {
              ...AVAILABLE_MODELS_RESPONSE.models[0],
              model: "claude-opus-5-5",
              modelLabel: "Claude Opus 5.5",
            },
          ],
        });
      }),
      http.post(MODEL_SELECTION_URL, () => {
        requests++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(
      chatCommand.parseAsync([
        "node",
        "cli",
        "model",
        "claude-opus-5-5",
        "--effort",
        "xhigh",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(requests).toBe(0);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "claude-opus-5-5 supports: low, medium, high, extra, max, ultracode",
    );
  });

  it("rejects extra for a Codex model before sending a request", async () => {
    let requests = 0;
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          selectedModel: "gpt-6-sol",
          modelSettings: {},
        });
      }),
      http.post(MODEL_SELECTION_URL, () => {
        requests++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(
      chatCommand.parseAsync(["node", "cli", "model", "--effort", "extra"]),
    ).rejects.toThrow("process.exit called");
    expect(requests).toBe(0);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "gpt-6-sol supports: low, medium, high, xhigh, max, ultra",
    );
  });

  it("rejects models that are not switchable for this user", async () => {
    server.use(
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json(AVAILABLE_MODELS_RESPONSE);
      }),
    );

    await expect(async () => {
      await chatCommand.parseAsync(["node", "cli", "model", "gpt-5.6-luna"]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Model is not switchable: gpt-5.6-luna");
    expect(stderr).toContain("Reconnect your personal subscription");
    expect(stderr).toContain("Run: okou chat model --help");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
  it("lists and switches to a model that exists only in the catalog", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);
    const model = "acme-nova-1";
    server.use(
      http.get("http://localhost:3000/api/model-catalog", () => {
        return HttpResponse.json({
          ...MODEL_CATALOG_RESPONSE,
          models: [
            ...MODEL_CATALOG_RESPONSE.models,
            {
              model,
              displayName: "Acme Nova",
              sortOrder: 100_000,
              replacedBy: null,
              resolvedModel: model,
              builtInOnRestrictedPlans: false,
            },
          ],
          routes: [
            ...MODEL_CATALOG_RESPONSE.routes,
            {
              model,
              providerType: "codex-oauth-token",
              concreteProviderType: "openrouter-codex",
              upstreamModel: "openai/gpt-6-luna",
              enabled: true,
              priority: 0,
              serviceTiers: [],
              efforts: ["low", "high"],
              defaultEffort: "high",
            },
          ],
        });
      }),
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json({
          models: [
            ...AVAILABLE_MODELS_RESPONSE.models,
            {
              model,
              modelLabel: "Acme Nova",
              modelProviderId: null,
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
        await expect(request.json()).resolves.toStrictEqual({ model });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "model", "--help"]);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Acme Nova (acme-nova-1)",
    );
    mockConsoleLog.mockClear();

    await chatCommand.parseAsync([
      "node",
      "cli",
      "model",
      "--thread",
      OTHER_THREAD_ID,
      model,
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat model updated");
    expect(output).toContain("Model:  Acme Nova (acme-nova-1)");
  });

  it("applies an effort-only change to the replacement of a retired selection", async () => {
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          selectedModel: "claude-opus-4-8",
        });
      }),
      http.post(MODEL_SELECTION_URL, async ({ request }) => {
        expect(await request.json()).toStrictEqual({
          model: "claude-opus-5-5",
          reasoningEffort: "extra",
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "model", "--effort", "extra"]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Model:  Claude Opus 5.5 (claude-opus-5-5) · effort extra",
    );
  });

  it("offers and switches a connected personal subscription model", async () => {
    server.use(
      http.get(MODEL_RUN_MODELS_URL, () => {
        return HttpResponse.json({
          ...AVAILABLE_MODELS_RESPONSE,
          models: [
            {
              ...AVAILABLE_MODELS_RESPONSE.models[1],
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

  it.each(["reconnect_required", "plan_restricted"])(
    "rejects a %s personal subscription route despite a valid route status",
    async (availability) => {
      server.use(
        http.get(MODEL_RUN_MODELS_URL, () => {
          return HttpResponse.json({
            ...AVAILABLE_MODELS_RESPONSE,
            models: [
              {
                ...AVAILABLE_MODELS_RESPONSE.models[0],
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
