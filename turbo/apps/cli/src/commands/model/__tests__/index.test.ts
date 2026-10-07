import type { AvailableRunModelsResponse } from "@okouai/api-contracts/contracts/model-providers";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { modelCommand } from "../index";

const available: AvailableRunModelsResponse = {
  defaultModel: "okou-1.0",
  models: [
    {
      model: "okou-1.0",
      modelLabel: "Auto",
      defaultProviderType: "built-in",
      runtimeProviderType: "openrouter-codex",
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
    },
    {
      model: "gpt-6-sol",
      modelLabel: "GPT 6 Sol",
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: "00000000-0000-4000-8000-000000000102",
      routeStatus: "valid",
    },
    {
      model: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: "00000000-0000-4000-8000-000000000103",
      routeStatus: "valid",
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
    expect(output).toContain("Auto (okou-1.0) (default)");
    expect(output).toContain("GPT 6 Sol (gpt-6-sol)");
    expect(output).toContain("Claude Sonnet 5 (claude-sonnet-5)");
    expect(output).toContain("provider: subscription");
    expect(output).toContain("okou model select <model>");
  });

  it.each(["okou-1.0", "gpt-6-sol"])(
    "selects %s as the default for new chats",
    async (model) => {
      let saved: unknown;
      server.use(
        http.put(
          "http://localhost:3000/api/user-model-preference",
          async ({ request }) => {
            saved = await request.json();
            return HttpResponse.json({
              selectedModel: model,
              serviceTier: null,
              modelSettings: {},
              selectedImageModel: null,
              updatedAt: "2026-10-01T00:00:00Z",
            });
          },
        ),
      );
      await modelCommand.parseAsync(["node", "cli", "select", model]);
      expect(saved).toEqual({ selectedModel: model, serviceTier: null });
      expect(log.mock.calls.flat().join("\n")).toContain(
        `Default model selected: ${model}`,
      );
    },
  );
});
