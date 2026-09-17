import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import {
  MODEL_PROVIDER_SET_GUIDANCE,
  setCommand,
  modelProviderCommand,
} from "../index";

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
      id: "00000000-0000-4000-8000-000000000003",
      model: "gpt-5.6-sol",
      modelLabel: "GPT 5.6 Sol",
      isDefault: false,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
      routeStatus: "missing_provider",
      routeStatusReason: "No personal subscription connected",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("okou model-provider command", () => {
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

  it("should expose provider routing subcommands", () => {
    expect(modelProviderCommand.name()).toBe("model-provider");
    expect(modelProviderCommand.description()).toBe(
      "Inspect model provider routing",
    );
    expect(
      modelProviderCommand.commands.map((command) => {
        return command.name();
      }),
    ).toEqual(["list", "set"]);
  });

  it("should list each allowed model's provider route", async () => {
    server.use(
      http.get("http://localhost:3000/api/model-policies", () => {
        return HttpResponse.json(MODEL_POLICIES_RESPONSE);
      }),
    );

    await modelProviderCommand.parseAsync(["node", "cli", "ls"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Model Provider Routes:");
    expect(logCalls).toContain("Claude Sonnet 4.6");
    expect(logCalls).toContain("provider: built-in");
    expect(logCalls).toContain("provider type: built-in (Built-in model)");
    expect(logCalls).toContain("GPT 5.6 Luna");
    expect(logCalls).toContain("provider: api key");
    expect(logCalls).toContain("GPT 5.6 Sol");
    expect(logCalls).toContain("provider: subscription");
    expect(logCalls).toContain("No personal subscription connected");
  });

  it("shows reconnect guidance for the personal route instead of the admin API", async () => {
    server.use(
      http.get("http://localhost:3000/api/model-policies", () => {
        return HttpResponse.json({
          ...MODEL_POLICIES_RESPONSE,
          policies: [
            {
              ...MODEL_POLICIES_RESPONSE.policies[1],
              memberEffective: {
                providerType: "codex-oauth-token",
                runtimeProviderType: "codex-oauth-token",
                credentialScope: "member",
                availability: "reconnect_required",
                accountSelection: "capture_required",
              },
            },
          ],
        });
      }),
    );

    await modelProviderCommand.parseAsync(["node", "cli", "ls"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("provider: subscription");
    expect(output).toContain(
      "provider type: codex-oauth-token (ChatGPT (Codex))",
    );
    expect(output).toContain(
      "reconnect_required: Reconnect your personal subscription",
    );
    expect(output).not.toContain("provider type: openai-api-key");
  });

  it("should show web-app provider routing guidance in set help", async () => {
    const helpChunks: string[] = [];
    setCommand.configureOutput({
      writeOut: (value) => {
        helpChunks.push(value);
      },
    });
    setCommand.outputHelp();

    const helpText = helpChunks.join("");
    expect(helpText).toContain(
      "Model provider routing is configured in the web app",
    );
    expect(helpText).toContain("top-left organization menu");
    expect(helpText).toContain("Preferences / Personal Models");

    await setCommand.parseAsync(["node", "cli"]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toBe(
      MODEL_PROVIDER_SET_GUIDANCE,
    );
  });
});
