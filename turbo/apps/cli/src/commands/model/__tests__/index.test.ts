import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { MODEL_CATALOG_RESPONSE } from "../../../mocks/handlers/model-catalog";
import { switchCommand, modelCommand } from "../index";

const MODEL_POLICIES_RESPONSE = {
  workspaceDefaultModel: "okou-1.0",
  workspaceDefaultPolicyId: "00000000-0000-4000-8000-000000000009",
  policies: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      model: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      isDefault: false,
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
      model: "gpt-5.6-luna",
      modelLabel: "GPT 5.6 Luna",
      isDefault: false,
      defaultProviderType: "openai-api-key",
      credentialScope: "org",
      modelProviderId: "00000000-0000-4000-8000-000000000102",
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000009",
      model: "okou-1.0",
      modelLabel: "Auto",
      isDefault: true,
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
    expect(logCalls).toContain("Claude Sonnet 5");
    expect(logCalls).toContain("provider: built-in (Built-in model; built-in)");
    expect(logCalls).toContain("price tier: $$");
    expect(logCalls).toContain("GPT 5.6 Luna");
    expect(logCalls).toContain("provider: api key");
    expect(logCalls).not.toContain("price tier: $$$");
    expect(logCalls).toContain("okou model-provider set --help");
    expect(logCalls).toContain("Auto (okou-1.0) (default)");
    expect(logCalls).toContain("Claude Sonnet 5 (claude-sonnet-5)\n");
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

  it("takes names, order, default, and retirement from the model catalog", async () => {
    const retiredPolicy = {
      ...MODEL_POLICIES_RESPONSE.policies[0]!,
      id: "00000000-0000-4000-8000-000000000003",
      model: "claude-opus-4-8",
      modelLabel: "Claude Opus 4.8",
    };
    server.use(
      http.get("http://localhost:3000/api/model-policies", () => {
        return HttpResponse.json({
          ...MODEL_POLICIES_RESPONSE,
          policies: [...MODEL_POLICIES_RESPONSE.policies, retiredPolicy],
        });
      }),
      http.get("http://localhost:3000/api/model-catalog", () => {
        return HttpResponse.json({
          ...MODEL_CATALOG_RESPONSE,
          systemDefaultModel: "claude-sonnet-5",
          models: MODEL_CATALOG_RESPONSE.models.map((entry) => {
            return entry.model === "claude-sonnet-5"
              ? { ...entry, displayName: "Sonnet Five", priceTier: "$$$$" }
              : { ...entry, isSystemDefault: false };
          }),
        });
      }),
    );

    await modelCommand.parseAsync(["node", "cli", "ls"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Sonnet Five (claude-sonnet-5) (default)");
    expect(output).toContain("price tier: $$$$");
    expect(output).toContain("Auto (okou-1.0)\n");
    expect(output).not.toContain("Auto (okou-1.0) (default)");
    expect(output).not.toContain("claude-opus-4-8");
    expect(output.indexOf("okou-1.0")).toBeLessThan(
      output.indexOf("claude-sonnet-5"),
    );
    expect(output.indexOf("claude-sonnet-5")).toBeLessThan(
      output.indexOf("gpt-5.6-luna"),
    );
  });

  it("should show Web switching guidance", async () => {
    await switchCommand.parseAsync(["node", "cli"]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      "Open https://app.okou.ai and switch models from the model selector next to the input box.",
    );
  });
});
