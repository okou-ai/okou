import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { switchCommand, modelCommand } from "../index";

const MODEL_POLICIES_RESPONSE = {
  workspaceDefaultModel: "claude-sonnet-4-6",
  workspaceDefaultPolicyId: "00000000-0000-4000-8000-000000000001",
  policies: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      isDefault: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      model: "gpt-5.5",
      modelLabel: "GPT 5.5",
      isDefault: false,
      defaultProviderType: "openai-api-key",
      credentialScope: "org",
      modelProviderId: "00000000-0000-4000-8000-000000000102",
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("okou model command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    mockConsoleLog.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should expose model discovery and switching subcommands", () => {
    expect(modelCommand.name()).toBe("model");
    expect(modelCommand.description()).toBe(
      "List available models and model-switching guidance",
    );
    expect(
      modelCommand.commands.map((command) => {
        return command.name();
      }),
    ).toEqual(["list", "switch"]);
  });

  it("should list allowed models, providers, and built-in price tiers", async () => {
    server.use(
      http.get("http://localhost:3000/api/model-policies", () => {
        return HttpResponse.json(MODEL_POLICIES_RESPONSE);
      }),
    );

    await modelCommand.parseAsync(["node", "cli", "ls"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Allowed Models:");
    expect(logCalls).toContain("Claude Sonnet 4.6");
    expect(logCalls).toContain("provider: built-in (Built-in model; built-in)");
    expect(logCalls).toContain("price tier: $$");
    expect(logCalls).toContain("GPT 5.5");
    expect(logCalls).toContain("provider: api key");
    expect(logCalls).not.toContain("price tier: $$$");
    expect(logCalls).toContain("okou model-provider set --help");
  });

  it("lists the effective subscription without organization API prices", async () => {
    server.use(
      http.get("http://localhost:3000/api/model-policies", () => {
        return HttpResponse.json({
          ...MODEL_POLICIES_RESPONSE,
          policies: MODEL_POLICIES_RESPONSE.policies.map((policy) => {
            return {
              ...policy,
              memberEffective: {
                providerType: policy.model.startsWith("claude")
                  ? "claude-code-oauth-token"
                  : "codex-oauth-token",
                runtimeProviderType: policy.model.startsWith("claude")
                  ? "claude-code-oauth-token"
                  : "codex-oauth-token",
                credentialScope: "member",
                availability: "available",
                accountSelection: "capture_required",
              },
            };
          }),
        });
      }),
    );

    await modelCommand.parseAsync(["node", "cli", "ls"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("provider: subscription");
    expect(output).toContain("codex-oauth-token");
    expect(output).not.toContain("price tier:");
    expect(output).not.toContain("provider: built-in");
    expect(output).not.toContain("provider: api key");
  });

  it("should show Web switching guidance", async () => {
    await switchCommand.parseAsync(["node", "cli"]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      "Open https://app.okou.ai and switch models from the model selector next to the input box.",
    );
  });
});
