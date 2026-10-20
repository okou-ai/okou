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
import {
  catalogAccountSummaries,
  customAccountSummaries,
  stubConnectorAccountSummaries,
} from "../../__tests__/helpers/connector-accounts";
import {
  authCodeMethod,
  catalogStatusItem,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  customMcpConnector,
  stubAgentCustomConnectors,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";

const AGENT_UUID = "550e8400-e29b-41d4-a716-446655440000";

const connectedGithub = {
  id: "1",
  slug: "github",
  authMethod: "oauth",
  externalId: "12345",
  externalUsername: "octocat",
  externalEmail: "octocat@github.com",
  oauthScopes: ["repo", "project", "workflow"],
  connectionStatus: "connected",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

function statusItemFromConnector(connector: Record<string, unknown>) {
  return catalogStatusItem({
    connectorSlug: connector.slug as string,
    authMethods: [authCodeMethod(connector.authMethod as string)],
    connection: {
      authMethod: connector.authMethod as string,
      externalUsername: (connector.externalUsername as string | null) ?? null,
      externalEmail: (connector.externalEmail as string | null) ?? null,
      reconnectReason: null,
    },
    connected: true,
    connectionStatus:
      (connector.connectionStatus as "connected" | "reconnect-required") ??
      "connected",
  });
}

function stubConnectors(connectors: Array<Record<string, unknown>>) {
  const connectedBySlug = new Map(
    connectors.map((connector) => {
      return [connector.slug as string, statusItemFromConnector(connector)];
    }),
  );
  const visibleConnectorSlugs = new Set([
    "github",
    "mercury",
    ...connectedBySlug.keys(),
  ]);
  server.use(
    stubConnectorAccountSummaries(
      catalogAccountSummaries([...connectedBySlug.values()]),
    ),
  );
  return stubConnectorCatalogStatus(
    [...visibleConnectorSlugs].map((connectorSlug) => {
      return (
        connectedBySlug.get(connectorSlug) ??
        catalogStatusItem({
          connectorSlug,
          authMethods: [authCodeMethod("oauth")],
        })
      );
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
  server.use(stubConnectorAccountSummaries([]));
  return stubConnectorCatalogStatus(
    connectorSlugs.map((connectorSlug) => {
      return catalogStatusItem({
        connectorSlug,
        authMethods: [authCodeMethod("oauth")],
      });
    }),
  );
}

describe("okou connector list command", () => {
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
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", undefined);
    listCommand.setOptionValue("agent", undefined);
    listCommand.setOptionValue("json", false);
    server.use(
      stubCustomConnectors([]),
      stubAgentCustomConnectors([]),
      stubConnectorAccountSummaries([]),
    );
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("without agent context", () => {
    it("reads catalog metadata without legacy default projections", async () => {
      const current = statusItemFromConnector(connectedGithub);
      const {
        connected: _connected,
        connection: _connection,
        connectionStatus: _connectionStatus,
        scopeMismatch: _scopeMismatch,
        authMethodSupportsRefresh: _authMethodSupportsRefresh,
        tokenExpiresAt: _tokenExpiresAt,
        ...metadata
      } = current;
      server.use(
        stubConnectorAccountSummaries(catalogAccountSummaries([current])),
        http.get("http://localhost:3000/api/connector-catalog/status", () => {
          return HttpResponse.json({ connectors: [metadata] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("github");
      expect(output).toContain("@octocat");
      expect(output).not.toContain("not connected");
    });

    it("renders SLUG and CONNECTED AS columns for a connected connector", async () => {
      server.use(stubConnectors([connectedGithub]));

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("SLUG");
      expect(logCalls).toContain("CONNECTED AS");
      expect(logCalls).not.toContain("ACCOUNT");
      expect(logCalls).not.toContain("STATUS");
      expect(logCalls).not.toContain("AUTHORIZED FOR");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("@octocat");
    });

    it("renders (not connected) for slugs with no connector", async () => {
      server.use(stubConnectors([]));

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("(not connected)");
      expect(logCalls).not.toContain("@octocat");
    });

    it("renders reconnect-needed state", async () => {
      server.use(
        stubConnectors([
          { ...connectedGithub, connectionStatus: "reconnect-required" },
        ]),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("@octocat (reconnect needed)");
    });

    it("renders custom connectors with their connection status", async () => {
      const connectedCustom = customConnector({
        connected: true,
        connectedAccountId: "55555555-5555-4555-8555-555555555555",
        missingRequiredFields: [],
        configuredFieldKeys: ["apiKey"],
      });
      const missingCustom = customConnector({
        id: "44444444-4444-4444-8444-444444444444",
        slug: "_weather-api",
        displayName: "Weather API",
      });
      server.use(
        stubAvailableConnectors(["github"]),
        stubCustomConnectors([connectedCustom, missingCustom]),
        stubConnectorAccountSummaries(
          customAccountSummaries([connectedCustom, missingCustom]),
        ),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const connectedRow = lines.find((line) => {
        return line.startsWith("_acme-search");
      });
      const missingRow = lines.find((line) => {
        return line.startsWith("_weather-api");
      });
      expect(connectedRow).toContain("Account #55555555");
      expect(connectedRow).not.toContain("not connected");
      expect(missingRow).toContain("not connected");
      expect(missingRow).not.toContain("missing apiKey");
    });

    it("emits parseable current-context JSON without ANSI", async () => {
      const custom = customConnector();
      const mcp = customMcpConnector();
      server.use(
        stubConnectors([connectedGithub]),
        stubCustomConnectors([custom, mcp]),
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
              connectionStatus: "connected",
            }),
            expect.objectContaining({
              kind: "custom",
              id: custom.id,
              connectorType: "custom-http",
              connected: false,
              missingRequiredFields: ["apiKey"],
            }),
            expect.objectContaining({
              kind: "custom",
              id: mcp.id,
              connectorType: "custom-mcp",
              target: { kind: "custom", customConnectorId: mcp.id },
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
        stubConnectors([connectedGithub]),
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
        stubConnectors([connectedGithub]),
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
      expect(logCalls).not.toContain("CONNECTED AS");
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
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, null),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`AUTHORIZED FOR ${AGENT_UUID}`);
    });

    it("renders - for connectors the agent is not authorized for", async () => {
      server.use(
        stubConnectors([connectedGithub]),
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
        http.get("http://localhost:3000/api/connector-catalog/status", () => {
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

  describe("auth method feature flag filtering", () => {
    it("excludes zapier when ZapierConnector feature switch is disabled (default)", async () => {
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "test"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("zapier");
    });

    it("includes connectors with ungated api-token auth even when oauth is feature-gated", async () => {
      server.use(
        stubConnectors([connectedGithub]),
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
