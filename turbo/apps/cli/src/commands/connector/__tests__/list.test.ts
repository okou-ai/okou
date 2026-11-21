import { capturedRunToken } from "../../../test/fixtures/captured-run-token";
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
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";

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
    listCommand.setOptionValue("json", false);
    server.use(stubCustomConnectors([]), stubConnectedConnectors([]));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("saved accounts outside a Run", () => {
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
            }),
            expect.objectContaining({
              kind: "custom",
              id: custom.id,
              connectorType: "custom-http",
              hasSavedAccounts: false,
            }),
            expect.objectContaining({
              kind: "custom",
              id: mcp.id,
              connectorType: "custom-mcp",
              target: { kind: "custom", customConnectorId: mcp.id },
              hasSavedAccounts: true,
            }),
          ]),
        }),
      );
      expect(output).not.toContain("\u001b[");
    });
  });

  it("reports unavailable account context in a Run", async () => {
    vi.stubEnv("OKOU_TOKEN", capturedRunToken(["connector:read"]));
    await listCommand.parseAsync(["node", "cli", "--json"]);
    expect(
      JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
    ).toStrictEqual({
      context: "run",
      state: "unavailable",
      reason: "legacy-or-missing",
      connectors: [],
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
