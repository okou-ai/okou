import type { AvailableRunModelsResponse } from "@okouai/api-contracts/contracts/model-providers";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { modelCommand } from "../index";

const available: AvailableRunModelsResponse = {
  models: [
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
    {
      model: "gpt-6-sol",
      modelLabel: "GPT 6 Sol",
      modelProviderId: "00000000-0000-4000-8000-000000000102",
      memberEffective: {
        providerType: "codex-oauth-token",
        runtimeProviderType: "codex-oauth-token",
        credentialScope: "member",
        availability: "available",
        accountSelection: "capture_required",
      },
      subscriptionOptions: {
        efforts: ["medium", "high"],
        serviceTier: "priority",
      },
    },
    {
      model: "gpt-6-sol-mini",
      modelLabel: "GPT 6 Sol Mini",
      modelProviderId: "00000000-0000-4000-8000-000000000102",
      memberEffective: {
        providerType: "codex-oauth-token",
        runtimeProviderType: "codex-oauth-token",
        credentialScope: "member",
        availability: "available",
        accountSelection: "capture_required",
      },
      subscriptionOptions: {
        efforts: ["medium", "high"],
        serviceTier: "priority",
      },
    },
    {
      model: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      modelProviderId: "00000000-0000-4000-8000-000000000103",
      memberEffective: {
        providerType: "claude-code-oauth-token",
        runtimeProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        availability: "available",
        accountSelection: "capture_required",
      },
    },
  ],
};

describe("okou model command", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    log.mockClear();
    server.use(
      http.get("http://localhost:3000/api/run-models", () => {
        return HttpResponse.json(available);
      }),
    );
  });
  afterEach(() => {
    return vi.unstubAllEnvs();
  });

  it("lists Auto and connected personal subscription models", async () => {
    await modelCommand.parseAsync(["node", "cli", "ls"]);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Auto (auto) (default)");
    expect(output).toContain("GPT 6 Sol (gpt-6-sol)");
    expect(output).toContain("Claude Sonnet 5 (claude-sonnet-5)");
    expect(output).toContain("provider: subscription");
    expect(output).toContain("okou model select <model>");
  });

  function serveSelection(stored: {
    readonly selectedModel: string | null;
    readonly serviceTier: "priority" | "ultrafast" | null;
  }): { saved?: unknown } {
    const captured: { saved?: unknown } = {};
    server.use(
      http.get("http://localhost:3000/api/user-model-preference", () => {
        return HttpResponse.json({
          ...stored,
          modelSettings: {},
          selectedImageModel: null,
          updatedAt: "2026-10-01T00:00:00Z",
        });
      }),
      http.put(
        "http://localhost:3000/api/user-model-preference",
        async ({ request }) => {
          const body = (await request.json()) as {
            selectedModel: string | null;
            serviceTier: string | null;
          };
          captured.saved = body;
          return HttpResponse.json({
            ...body,
            modelSettings: {},
            selectedImageModel: null,
            updatedAt: "2026-10-02T00:00:00Z",
          });
        },
      ),
    );
    return captured;
  }

  async function select(...args: string[]): Promise<string> {
    // Commander keeps parsed option values on the command between runs.
    for (const command of modelCommand.commands) {
      command.setOptionValue("priority", undefined);
    }
    await modelCommand.parseAsync(["node", "cli", "select", ...args]);
    return log.mock.calls.flat().join("\n");
  }

  it.each([null, "auto"])(
    "selects Auto from API choice %s with predecessor-compatible intent",
    async (model) => {
      server.use(
        http.get("http://localhost:3000/api/run-models", () => {
          return HttpResponse.json({
            ...available,
            models: available.models.map((row) => {
              return row.model === null ? { ...row, model } : row;
            }),
          });
        }),
      );
      const request = serveSelection({
        selectedModel: "gpt-6-sol",
        serviceTier: null,
      });
      const output = await select("auto");
      expect(request.saved).toEqual({ selectedModel: null, serviceTier: null });
      expect(output).toContain("Default model selected: Auto");
    },
  );

  it("selects a subscription model as the default for new chats", async () => {
    const request = serveSelection({ selectedModel: null, serviceTier: null });
    const output = await select("gpt-6-sol");
    expect(request.saved).toEqual({
      selectedModel: "gpt-6-sol",
      serviceTier: null,
    });
    expect(output).toContain("Default model selected: gpt-6-sol");
  });

  it("keeps the saved Fast preference when reselecting the same model", async () => {
    const request = serveSelection({
      selectedModel: "gpt-6-sol",
      serviceTier: "priority",
    });
    const output = await select("gpt-6-sol");
    expect(request.saved).toEqual({
      selectedModel: "gpt-6-sol",
      serviceTier: "priority",
    });
    expect(output).toContain("Service tier: priority");
  });

  it("keeps the saved Fast preference on another subscription model that offers it", async () => {
    const request = serveSelection({
      selectedModel: "gpt-6-sol",
      serviceTier: "priority",
    });
    await select("gpt-6-sol-mini");
    expect(request.saved).toEqual({
      selectedModel: "gpt-6-sol-mini",
      serviceTier: "priority",
    });
  });

  it("drops the saved Fast preference for a model that does not offer it", async () => {
    const request = serveSelection({
      selectedModel: "gpt-6-sol",
      serviceTier: "priority",
    });
    const output = await select("claude-sonnet-5");
    expect(request.saved).toEqual({
      selectedModel: "claude-sonnet-5",
      serviceTier: null,
    });
    expect(output).not.toContain("Service tier");
  });

  it("writes the tier requested by --priority and --no-priority", async () => {
    const enabled = serveSelection({ selectedModel: null, serviceTier: null });
    await select("gpt-6-sol", "--priority");
    expect(enabled.saved).toEqual({
      selectedModel: "gpt-6-sol",
      serviceTier: "priority",
    });

    const disabled = serveSelection({
      selectedModel: "gpt-6-sol",
      serviceTier: "priority",
    });
    await select("gpt-6-sol", "--no-priority");
    expect(disabled.saved).toEqual({
      selectedModel: "gpt-6-sol",
      serviceTier: null,
    });
  });
});
