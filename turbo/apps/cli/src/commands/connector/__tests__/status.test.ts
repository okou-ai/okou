/**
 * Tests for okou connector status command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { statusCommand } from "../status";
import chalk from "chalk";
import {
  catalogAccountConnections,
  stubConnectorAccounts,
} from "../../__tests__/helpers/connector-accounts";
import {
  authCodeMethod,
  catalogStatusItem,
  stubConnectorCatalog,
  stubConnectorCatalogDetail,
} from "../../__tests__/helpers/connector-catalog";

const AGENT_UUID = "550e8400-e29b-41d4-a716-446655440000";

const connectedGithub = {
  id: "1",
  slug: "github",
  authMethod: "oauth",
  externalId: "12345",
  externalUsername: "octocat",
  externalEmail: "octocat@github.com",
  oauthScopes: ["repo", "project"],
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

function stubStatus(
  connectors: Parameters<typeof stubConnectorCatalogDetail>[0],
  origin = "http://localhost:3000",
) {
  server.use(stubConnectorCatalog(connectors, origin));
  return stubConnectorCatalogDetail(connectors, origin);
}

function stubConnector(
  body: Record<string, unknown>,
  status = 200,
  connectorSlug = "github",
) {
  if (status === 200) {
    server.use(
      stubConnectorAccounts(
        catalogAccountConnections([statusItemFromConnector(body)]),
      ),
    );
    return stubStatus([statusItemFromConnector(body)]);
  }
  if (status === 404) {
    return stubStatus([
      catalogStatusItem({
        connectorSlug,
        authMethods: [authCodeMethod("oauth")],
      }),
    ]);
  }
  return http.get("http://localhost:3000/api/connector-catalog", () => {
    return HttpResponse.json(body, { status });
  });
}

function stubAgent(
  id: string,
  displayName: string | null,
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/agents/${id}`, () => {
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

function stubUserConnectors(
  id: string,
  enabledConnectorSlugs: string[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/agents/${id}/user-connectors`, () => {
    return HttpResponse.json({ enabledConnectorSlugs: enabledConnectorSlugs });
  });
}

function stubAvailableConnectors(connectorSlugs: string[]) {
  return stubStatus(
    connectorSlugs.map((connectorSlug) => {
      return catalogStatusItem({
        connectorSlug,
        authMethods: [authCodeMethod("oauth")],
      });
    }),
  );
}

describe("okou connector status command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_APP_URL", "");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", undefined);
    vi.stubEnv("OKOU_AGENT_ID", "");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "");
    statusCommand.setOptionValue("agent", undefined);
    statusCommand.setOptionValue("json", false);
    server.use(stubConnectorAccounts([]));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("without agent context", () => {
    it.each(["github", "GitHub", "builtin:github", "builtin:GitHub"])(
      "displays connected status selected by %s",
      async (selector) => {
        server.use(stubConnector(connectedGithub));

        await statusCommand.parseAsync(["node", "cli", selector]);

        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain("github");
        expect(logCalls).toContain("connected");
        expect(logCalls).toContain("@octocat");
        expect(logCalls).toContain("oauth");
        expect(logCalls).not.toContain("Authorized:");
      },
    );

    it("displays not connected status", async () => {
      server.use(
        stubConnector(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          404,
        ),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("not connected");
      expect(logCalls).toContain("[Connect github](");
      expect(logCalls).toContain("/connectors/github/connect");
      expect(logCalls).not.toContain("Authorized:");
      expect(logCalls).not.toContain("Diagnose it with");
      expect(logCalls).not.toContain("okou connector check");
    });

    it("does not print connect guidance for unavailable connectors", async () => {
      server.use(stubAvailableConnectors([]));

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorOutput).toContain("Unknown or unavailable connector: github");
      expect(errorOutput).toContain("Available connectors:");
    });

    it("shows reconnect guidance when connector needs reconnect", async () => {
      server.use(
        stubConnector({
          ...connectedGithub,
          connectionStatus: "reconnect-required",
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("reconnect needed");
      expect(logCalls).toContain(
        "The github connector is connected but needs to be reconnected.",
      );
      expect(logCalls).toContain("[Reconnect github](");
      expect(logCalls).toContain("/connectors");
      expect(logCalls).not.toContain("okou connector check");
    });

    it("emits parseable current-context JSON without ANSI", async () => {
      server.use(stubConnector(connectedGithub));

      await statusCommand.parseAsync(["node", "cli", "github", "--json"]);

      const output = String(mockConsoleLog.mock.calls[0]?.[0]);
      const json: unknown = JSON.parse(output);
      expect(json).toStrictEqual(
        expect.objectContaining({
          context: "current",
          connector: expect.objectContaining({
            slug: "github",
            memberStatus: "connected",
            connectorType: "builtin",
            target: { kind: "builtin", connectorSlug: "github" },
          }),
          authorization: null,
        }),
      );
      expect(output).not.toContain("\u001b[");
    });
  });

  describe("with agent context", () => {
    it("shows authorized prose when agent is authorized", async () => {
      server.use(
        stubConnector(connectedGithub),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        `The github connector is authorized for agent maya (${AGENT_UUID}).`,
      );
      expect(logCalls).not.toContain("is not authorized");
      expect(logCalls).not.toContain("is not connected");
      expect(logCalls).not.toContain("[Authorize github]");
      expect(logCalls).not.toContain("[Connect github]");
    });

    it("shows authorize link when connected but agent is not authorized", async () => {
      server.use(
        stubConnector(connectedGithub),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        `The github connector is not authorized for agent maya (${AGENT_UUID}).`,
      );
      expect(logCalls).toContain("[Authorize github](");
      expect(logCalls).toContain(
        `/connectors/github/authorize?agentId=${AGENT_UUID}`,
      );
      expect(logCalls).not.toContain("is not connected");
      expect(logCalls).not.toContain("[Connect github]");
      expect(logCalls).not.toContain("okou connector check");
      expect(logCalls).not.toContain("callbackPrompt=");
    });

    it("does not attach run callback context to a standalone agent lookup", async () => {
      vi.stubEnv("OKOU_CHAT_THREAD_ID", "thread-abc-123");
      server.use(
        stubConnector(connectedGithub),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        `/connectors/github/authorize?agentId=${AGENT_UUID}`,
      );
      expect(logCalls).not.toContain("threadId=thread-abc-123");
      expect(logCalls).not.toContain("callbackPrompt=");
    });

    it("fails closed for canonical run context without a projection", async () => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Account used by this run is unavailable");
    });

    it("uses the production app origin in authorization links", async () => {
      const apiOrigin = "https://api.okou.ai";
      vi.stubEnv("APP_URL", "https://unrelated.example.test");
      vi.stubEnv("OKOU_API_BACKEND_URL", apiOrigin);
      server.use(
        stubStatus([statusItemFromConnector(connectedGithub)], apiOrigin),
        stubConnectorAccounts(
          catalogAccountConnections([statusItemFromConnector(connectedGithub)]),
          apiOrigin,
        ),
        stubAgent(AGENT_UUID, "maya", apiOrigin),
        stubUserConnectors(AGENT_UUID, [], apiOrigin),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        `[Authorize github](https://app.okou.ai/connectors/github/authorize?agentId=${AGENT_UUID})`,
      );
    });

    it("prefers OKOU_APP_URL in authorization links", async () => {
      const apiOrigin = "https://api.example.test";
      const appOrigin = "https://app.example.test";
      vi.stubEnv("OKOU_API_BACKEND_URL", apiOrigin);
      vi.stubEnv("OKOU_APP_URL", `${appOrigin}/ignored-path`);
      server.use(
        stubStatus([statusItemFromConnector(connectedGithub)], apiOrigin),
        stubConnectorAccounts(
          catalogAccountConnections([statusItemFromConnector(connectedGithub)]),
          apiOrigin,
        ),
        stubAgent(AGENT_UUID, "maya", apiOrigin),
        stubUserConnectors(AGENT_UUID, [], apiOrigin),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        `[Authorize github](${appOrigin}/connectors/github/authorize?agentId=${AGENT_UUID})`,
      );
    });

    it("shows connect link when connector is not connected", async () => {
      server.use(
        stubConnector(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          404,
        ),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        `The github connector is not connected. Once connected, it will be authorized for agent maya (${AGENT_UUID}).`,
      );
      expect(logCalls).toContain("Connect and authorize it at:");
      expect(logCalls).toContain(
        `/connectors/github/connect?agentId=${AGENT_UUID}`,
      );
      expect(logCalls).not.toContain("[Authorize github]");
      expect(logCalls).not.toContain("okou connector check");
    });

    it("shows connect guidance when connector is authorized but not connected", async () => {
      server.use(
        stubConnector(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          404,
        ),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("not connected");
      expect(logCalls).toContain(
        `The github connector is authorized for agent maya (${AGENT_UUID}), but it is not connected.`,
      );
      expect(logCalls).toContain("[Connect github](");
      expect(logCalls).toContain(
        `/connectors/github/connect?agentId=${AGENT_UUID}`,
      );
      expect(logCalls).not.toContain("[Authorize github]");
      expect(logCalls).not.toContain("okou connector check");
    });

    it("shows reconnect guidance when connector needs reconnect", async () => {
      server.use(
        stubConnector({
          ...connectedGithub,
          connectionStatus: "reconnect-required",
        }),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("reconnect needed");
      expect(logCalls).toContain(
        `The github connector is connected but needs to be reconnected before agent maya (${AGENT_UUID}) can use it.`,
      );
      expect(logCalls).toContain("[Reconnect github](");
      expect(logCalls).toContain("/connectors");
      expect(logCalls).not.toContain("[Authorize github]");
      expect(logCalls).not.toContain("okou connector check");
    });

    it("uses $OKOU_AGENT_ID to detect legacy run context", async () => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Account used by this run is unavailable");
    });

    it("does not let matching --agent bypass unavailable run context", async () => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Account used by this run is unavailable");
      expect(logCalls).not.toContain("authorized for agent");
    });

    it("falls back to UUID-only label when displayName is null", async () => {
      server.use(
        stubConnector(connectedGithub),
        stubAgent(AGENT_UUID, null),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        `The github connector is authorized for agent ${AGENT_UUID}.`,
      );
      expect(logCalls).not.toContain(`${AGENT_UUID} (${AGENT_UUID})`);
    });
  });

  describe("input validation", () => {
    it("should reject unavailable connector slugs", async () => {
      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "invalid-type"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Unknown or unavailable connector: invalid-type",
        ),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Available connectors:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        stubConnector(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          401,
        ),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Authentication failed"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("OKOU_TOKEN is invalid or expired"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
