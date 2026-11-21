import { capturedRunToken } from "../../../test/fixtures/captured-run-token";
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

const githubAccount = {
  authMethod: "oauth",
  externalId: "12345",
  externalUsername: "octocat",
  externalEmail: "octocat@github.com",
  oauthScopes: ["repo", "project"],
  connectionStatus: "connected" as const,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const connectedGithub = catalogStatusItem({
  connectorSlug: "github",
  authMethods: [authCodeMethod("oauth")],
  account: githubAccount,
});

function stubStatus(
  connectors: Parameters<typeof stubConnectorCatalogDetail>[0],
  origin = "http://localhost:3000",
) {
  server.use(stubConnectorCatalog(connectors, origin));
  return stubConnectorCatalogDetail(connectors, origin);
}

function stubConnector(connector: ReturnType<typeof catalogStatusItem>) {
  server.use(stubConnectorAccounts(catalogAccountConnections([connector])));
  return stubStatus([connector]);
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
    statusCommand.setOptionValue("json", false);
    server.use(stubConnectorAccounts([]));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("saved accounts outside a Run", () => {
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
      server.use(stubAvailableConnectors(["github"]));

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
        stubConnector(
          catalogStatusItem({
            connectorSlug: "github",
            authMethods: [authCodeMethod("oauth")],
            account: {
              ...githubAccount,
              connectionStatus: "reconnect-required",
            },
          }),
        ),
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
        }),
      );
      expect(output).not.toContain("\u001b[");
    });
  });

  it("reports unavailable account context in a Run", async () => {
    vi.stubEnv("OKOU_TOKEN", capturedRunToken(["connector:read"]));
    await statusCommand.parseAsync(["node", "cli", "github", "--json"]);
    expect(
      JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
    ).toStrictEqual({
      context: "run",
      state: "unavailable",
      reason: "legacy-or-missing",
      connector: null,
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
        http.get("http://localhost:3000/api/connector-catalog", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
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
