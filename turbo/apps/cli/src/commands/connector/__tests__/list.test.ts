/**
 * Tests for okou connector list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";
import { stubConnectedConnectors } from "../../__tests__/helpers/connector-accounts";
import {
  authCodeMethod,
  catalogItem,
  stubConnectorCatalog,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  customMcpConnector,
  stubAgentCustomConnectors,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";

const AGENT_UUID = "550e8400-e29b-41d4-a716-446655440000";

function stubConnectors(savedSlugs: readonly string[]) {
  server.use(stubConnectedConnectors(savedSlugs));
  return stubConnectorCatalog(
    [...new Set(["github", "mercury", ...savedSlugs])].map((connectorSlug) => {
      return catalogItem({
        connectorSlug,
        authMethods: [authCodeMethod("oauth")],
      });
    }),
  );
}

function stubAgent(id: string, displayName: string | null) {
  return http.get(`http://localhost:3000/api/agents/${id}`, () => {
    return HttpResponse.json({
      agentId: id,
      ownerId: "owner-1",
      description: null,
      displayName,
      sound: null,
      avatarUrl: null,
    });
  });
}

function stubUserConnectors(id: string, enabledConnectorSlugs: string[]) {
  return http.get(
    `http://localhost:3000/api/agents/${id}/user-connectors`,
    () => {
      return HttpResponse.json({
        enabledConnectorSlugs: enabledConnectorSlugs,
      });
    },
  );
}

function stubAvailableConnectors(connectorSlugs: string[]) {
  server.use(stubConnectedConnectors([]));
  return stubConnectorCatalog(
    connectorSlugs.map((connectorSlug) => {
      return catalogItem({
        connectorSlug,
        authMethods: [authCodeMethod("oauth")],
      });
    }),
  );
}

describe("okou connector list command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error(
      `process.exit called: ${mockConsoleError.mock.calls.flat().join(" ")}`,
    );
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", undefined);
    listCommand.setOptionValue("agent", undefined);
    listCommand.setOptionValue("json", false);
    server.use(
      stubCustomConnectors([]),
      stubAgentCustomConnectors([]),
      stubConnectedConnectors([]),
    );
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("without agent context", () => {
    it("renders saved-account membership and directs users to inspect status", async () => {
      server.use(stubConnectors(["github"]));

      await listCommand.parseAsync(["node", "cli"]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("SLUG");
      expect(output).toContain("SAVED ACCOUNTS");
      expect(output).not.toContain("AUTHORIZED FOR");
      expect(output).toMatch(/github\s+saved accounts \(inspect status\)/u);
    });

    it("renders no saved accounts for catalog entries absent from the directory", async () => {
      server.use(stubConnectors([]));

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("(no saved accounts)");
    });

    it("renders custom connectors using saved-account directory membership", async () => {
      const connectedCustom = customConnector();
      const missingCustom = customConnector({
        id: "44444444-4444-4444-8444-444444444444",
        slug: "_weather-api",
        displayName: "Weather API",
      });
      server.use(
        stubAvailableConnectors(["github"]),
        stubCustomConnectors([connectedCustom, missingCustom]),
        stubConnectedConnectors([], [connectedCustom]),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const connectedRow = lines.find((line) => {
        return line.startsWith("_acme-search");
      });
      const missingRow = lines.find((line) => {
        return line.startsWith("_weather-api");
      });
      expect(connectedRow).toContain("saved accounts (inspect status)");
      expect(missingRow).toContain("(no saved accounts)");
    });

    it("emits current-context JSON with directory membership and no inferred account facts", async () => {
      const custom = customConnector();
      const mcp = customMcpConnector();
      server.use(
        stubConnectors(["github"]),
        stubCustomConnectors([custom, mcp]),
        stubConnectedConnectors(["github"], [mcp]),
      );

      await listCommand.parseAsync(["node", "cli", "--json"]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      const json: unknown = JSON.parse(output);
      expect(json).toStrictEqual(
        expect.objectContaining({
          context: "current",
          connectors: expect.arrayContaining([
            expect.objectContaining({
              kind: "builtin",
              connectorType: "builtin",
              target: { kind: "builtin", connectorSlug: "github" },
              slug: "github",
              hasSavedAccounts: true,
              authorized: null,
            }),
            expect.objectContaining({
              kind: "custom",
              id: custom.id,
              connectorType: "custom-http",
              hasSavedAccounts: false,
              authorized: null,
            }),
            expect.objectContaining({
              kind: "custom",
              id: mcp.id,
              connectorType: "custom-mcp",
              target: { kind: "custom", customConnectorId: mcp.id },
              hasSavedAccounts: true,
              authorized: null,
            }),
          ]),
        }),
      );
      expect(output).not.toContain("\u001b[");
    });
  });

  describe("with agent context", () => {
    it("renders AUTHORIZED FOR column with displayName when --agent is provided", async () => {
      server.use(
        stubConnectors(["github"]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("AUTHORIZED FOR maya");
      expect(logCalls).toContain("✓");
    });

    it("prefers canonical enabled connector slugs", async () => {
      server.use(
        stubConnectors(["github"]),
        stubAgent(AGENT_UUID, "maya"),
        http.get(
          `http://localhost:3000/api/agents/${AGENT_UUID}/user-connectors`,
          () => {
            return HttpResponse.json({
              enabledConnectorSlugs: ["github"],
            });
          },
        ),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("✓");
    });

    it("fails closed when a legacy run has no account context", async () => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Account used by this run is unavailable");
      expect(logCalls).toContain("start a new run");
    });

    it("does not let matching --agent bypass unavailable run context", async () => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Account used by this run is unavailable");
      expect(logCalls).not.toContain("AUTHORIZED FOR");
    });

    it("falls back to agent UUID when displayName is null", async () => {
      server.use(
        stubConnectors(["github"]),
        stubAgent(AGENT_UUID, null),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`AUTHORIZED FOR ${AGENT_UUID}`);
    });

    it("renders - for connectors the agent is not authorized for", async () => {
      server.use(
        stubConnectors(["github"]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("AUTHORIZED FOR maya");
      expect(logCalls).not.toContain("✓");
      expect(logCalls).toContain("-");
    });

    it("renders custom connector authorization for the agent", async () => {
      const connector = customConnector();
      server.use(
        stubAvailableConnectors(["github"]),
        stubCustomConnectors([connector]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
        stubAgentCustomConnectors([
          { customConnectorId: connector.id, permissionNames: [] },
        ]),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const customRow = (mockConsoleLog.mock.calls.flat() as string[]).find(
        (line) => {
          return line.startsWith(connector.slug);
        },
      );
      expect(customRow).toMatch(/✓$/u);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/connector-catalog", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Not authenticated",
                code: "UNAUTHORIZED",
              },
            },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Authentication failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  it("fails visibly when saved-account directory cannot be read", async () => {
    server.use(
      stubConnectors(["github"]),
      http.get("http://localhost:3000/api/connectors/connected", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Saved-account directory unavailable",
              code: "UNAVAILABLE",
            },
          },
          { status: 503 },
        );
      }),
    );

    await expect(
      listCommand.parseAsync(["node", "cli", "--json"]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Saved-account directory unavailable",
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  describe("auth method feature flag filtering", () => {
    it("excludes zapier when ZapierConnector feature switch is disabled (default)", async () => {
      server.use(
        stubConnectors(["github"]),
        stubAgent(AGENT_UUID, "test"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("zapier");
    });

    it("includes connectors with ungated api-token auth even when oauth is feature-gated", async () => {
      server.use(
        stubConnectors(["github"]),
        stubAgent(AGENT_UUID, "test"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      // mercury has an ungated api-token auth method, so it is always visible.
      expect(logCalls).toContain("mercury");
    });

    it("uses the server-visible catalog for feature-gated oauth connectors", async () => {
      server.use(stubAvailableConnectors(["google-ads"]));

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("google-ads");
    });
  });

  describe("alias", () => {
    it("should have ls alias", () => {
      expect(listCommand.alias()).toBe("ls");
    });
  });
});
