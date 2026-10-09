/**
 * Tests for okou connector search command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, scoring algorithm, formatters
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { searchCommand } from "../search";
import chalk from "chalk";
import {
  authCodeMethod,
  catalogItem,
  catalogStatusItem,
  stubConnectorCatalog,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  customMcpConnector,
  stubAgentCustomConnectors,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import {
  stubRunConnectorAccountInspection,
  writeRunConnectorAccountContext,
} from "../../__tests__/helpers/run-connector-accounts";

const AGENT_UUID = "550e8400-e29b-41d4-a716-446655440000";
const ALT_AGENT_UUID = "550e8400-e29b-41d4-a716-446655440099";
const RUN_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_UUID = "22222222-2222-4222-8222-222222222222";

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

function stubConnectors(connectors: Array<Record<string, unknown>>) {
  const connectedBySlug = new Map(
    connectors.map((connector) => {
      const scopeMismatch =
        Array.isArray(connector.oauthScopes) &&
        connector.oauthScopes.length === 1 &&
        connector.oauthScopes[0] === "repo";
      return [
        connector.slug as string,
        catalogStatusItem({
          connectorSlug: connector.slug as string,
          authMethods: [authCodeMethod(connector.authMethod as string)],
          tags: connector.slug === "github" ? ["vcs"] : [],
          connection: {
            authMethod: connector.authMethod as string,
            externalUsername:
              (connector.externalUsername as string | null) ?? null,
            externalEmail: (connector.externalEmail as string | null) ?? null,
            reconnectReason: null,
          },
          connected: true,
          connectionStatus: scopeMismatch
            ? "scope-mismatch"
            : ((connector.connectionStatus as
                "connected" | "reconnect-required") ?? "connected"),
          scopeMismatch,
        }),
      ] as const;
    }),
  );
  const visibleConnectorSlugs = new Set([
    "github",
    "mercury",
    ...connectedBySlug.keys(),
  ]);
  return stubConnectorCatalogStatus(
    [...visibleConnectorSlugs].map((connectorSlug) => {
      return (
        connectedBySlug.get(connectorSlug) ??
        catalogStatusItem({
          connectorSlug,
          authMethods: [authCodeMethod("oauth")],
          tags: connectorSlug === "github" ? ["vcs"] : [],
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
  return stubConnectorCatalogStatus(
    connectorSlugs.map((connectorSlug) => {
      return catalogStatusItem({
        connectorSlug,
        label: connectorSlug.replaceAll("-", " "),
        authMethods: [authCodeMethod("oauth")],
        tags: connectorSlug === "google-ads" ? ["ads"] : [],
      });
    }),
  );
}

function findDataRows(lines: readonly string[]): string[] {
  const contextIndex = lines.indexOf("Connection context:");
  const tableLines = contextIndex === -1 ? lines : lines.slice(0, contextIndex);
  return tableLines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("SLUG")) return false;
    if (trimmed.startsWith("No exact match")) return false;
    if (trimmed.startsWith("Supported connector matches")) return false;
    if (trimmed.startsWith("No matches found")) return false;
    return true;
  });
}

describe("okou connector search command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  let directory = "";
  let contextPath = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "okou-search-run-account-"));
    contextPath = join(directory, "context.json");
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", contextPath);
    searchCommand.setOptionValue("agent", undefined);
    searchCommand.setOptionValue("limit", undefined);
    searchCommand.setOptionValue("callbackPrompt", undefined);
    searchCommand.setOptionValue("json", false);
    server.use(stubCustomConnectors([]), stubAgentCustomConnectors([]));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  describe("JSON output", () => {
    it("identifies all three connector types and separates current connection from Agent grants", async () => {
      const custom = customConnector({ connectedAccountId: RUN_CONNECTION_ID });
      const mcp = customMcpConnector();
      server.use(
        stubConnectorCatalogStatus([
          catalogStatusItem({ connectorSlug: "acme", label: "Acme Builtin" }),
        ]),
        stubCustomConnectors([custom, mcp]),
        stubAgent(AGENT_UUID, "Agent"),
        stubUserConnectors(AGENT_UUID, ["acme"]),
        stubAgentCustomConnectors([
          { customConnectorId: custom.id, permissionNames: [] },
        ]),
      );
      chalk.level = 3;
      await searchCommand.parseAsync([
        "node",
        "cli",
        " Acme ",
        "--agent",
        AGENT_UUID,
        "--json",
      ]);
      const output = mockConsoleLog.mock.calls.flat().join("\n");
      const json: unknown = JSON.parse(output);
      expect(json).toMatchObject({
        context: "current",
        query: { keyword: "Acme", limit: null },
        agent: { agentId: AGENT_UUID },
        total: 3,
        exactMatch: true,
        connectors: expect.arrayContaining([
          expect.objectContaining({
            connectorType: "builtin",
            kind: "builtin",
            target: { kind: "builtin", connectorSlug: "acme" },
            connected: false,
            authorized: true,
          }),
          expect.objectContaining({
            connectorType: "custom-http",
            kind: "custom",
            id: custom.id,
            connectionId: RUN_CONNECTION_ID,
            authorized: true,
          }),
          expect.objectContaining({
            connectorType: "custom-mcp",
            target: { kind: "custom", customConnectorId: mcp.id },
            authorized: false,
          }),
        ]),
      });
      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      expect(output).not.toContain("\u001b[");
    });

    it("retains the total match count when results are limited", async () => {
      server.use(
        stubAvailableConnectors([
          "google-ads",
          "google-calendar",
          "google-docs",
        ]),
      );
      await searchCommand.parseAsync([
        "node",
        "cli",
        "google",
        "--limit",
        "1",
        "--json",
      ]);
      const json: unknown = JSON.parse(
        mockConsoleLog.mock.calls.flat().join("\n"),
      );
      expect(json).toMatchObject({
        total: 3,
        query: { limit: 1 },
        connectors: [expect.objectContaining({ slug: expect.any(String) })],
      });
    });

    it("returns a parseable empty result without guidance prose", async () => {
      server.use(stubConnectors([]));
      await searchCommand.parseAsync([
        "node",
        "cli",
        "not-a-real-service-xyz",
        "--json",
      ]);
      const json: unknown = JSON.parse(
        mockConsoleLog.mock.calls.flat().join("\n"),
      );
      expect(json).toMatchObject({
        context: "current",
        total: 0,
        exactMatch: false,
        connectors: [],
        actions: [],
      });
    });

    it("reports the exact reconnect-required run account independently of current grants", async () => {
      const target = { kind: "builtin", connectorSlug: "github" } as const;
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);
      writeRunConnectorAccountContext(contextPath, [
        { ...target, connectionId: RUN_CONNECTION_ID },
      ]);
      server.use(
        stubConnectorCatalog([catalogItem({ connectorSlug: "github" })]),
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "Agent"),
        stubUserConnectors(AGENT_UUID, []),
        stubRunConnectorAccountInspection([
          {
            kind: "available",
            target,
            connectionId: RUN_CONNECTION_ID,
            authMethod: "oauth",
            displayName: "Selected account",
            externalId: "selected",
            externalUsername: null,
            externalEmail: null,
            connectionStatus: "reconnect-required",
            reconnectReason: "authorization_expired_or_revoked",
          },
        ]),
      );
      await searchCommand.parseAsync(["node", "cli", "github", "--json"]);
      const output = mockConsoleLog.mock.calls.flat().join("\n");
      const json: unknown = JSON.parse(output);
      expect(json).toMatchObject({
        context: "run",
        connectors: [
          {
            connectorType: "builtin",
            target,
            account: {
              state: "available",
              connectionId: RUN_CONNECTION_ID,
              metadata: { connectionStatus: "reconnect-required" },
            },
            availableForRun: false,
            authorized: false,
          },
        ],
        actions: [
          {
            url: expect.stringContaining(
              `/connectors/github/reconnect/${RUN_CONNECTION_ID}`,
            ),
          },
        ],
      });
      expect(output).not.toContain("octocat");
    });

    it.each([
      "not-admitted",
      "context-unavailable",
      "metadata-unavailable",
    ] as const)("preserves the %s run state in JSON", async (state) => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);
      if (state === "not-admitted") {
        writeRunConnectorAccountContext(contextPath, []);
      } else if (state === "context-unavailable") {
        vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
      } else {
        writeRunConnectorAccountContext(contextPath, [
          {
            kind: "builtin",
            connectorSlug: "github",
            connectionId: RUN_CONNECTION_ID,
          },
        ]);
      }
      server.use(
        stubConnectorCatalog([catalogItem({ connectorSlug: "github" })]),
        stubAgent(AGENT_UUID, "Agent"),
        stubUserConnectors(AGENT_UUID, ["github"]),
        stubRunConnectorAccountInspection([]),
      );
      await searchCommand.parseAsync(["node", "cli", "github", "--json"]);
      const json: unknown = JSON.parse(
        mockConsoleLog.mock.calls.flat().join("\n"),
      );
      expect(json).toMatchObject({
        context: "run",
        connectors: [
          {
            account: { state },
            availableForRun: state === "context-unavailable" ? null : false,
            authorized: true,
          },
        ],
      });
      if (state === "metadata-unavailable") {
        expect(json).toMatchObject({
          connectors: [{ account: { connectionId: RUN_CONNECTION_ID } }],
        });
      }
    });

    it("preserves the callback URL and task inside the JSON action", async () => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);
      vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_UUID);
      writeRunConnectorAccountContext(contextPath, []);
      server.use(
        stubConnectorCatalog([catalogItem({ connectorSlug: "github" })]),
        stubAgent(AGENT_UUID, "Agent"),
        stubUserConnectors(AGENT_UUID, []),
      );
      await searchCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--limit",
        "1",
        "--callback-prompt",
        "Continue issue review",
        "--json",
      ]);
      const json: unknown = JSON.parse(
        mockConsoleLog.mock.calls.flat().join("\n"),
      );
      expect(json).toMatchObject({
        actions: [
          { supportsCallback: true, url: expect.stringContaining(THREAD_UUID) },
        ],
      });
      expect(json).toMatchObject({
        actions: [{ url: expect.stringContaining("Continue") }],
      });
      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    });
  });

  describe("keyword validation", () => {
    it("rejects whitespace-only keyword", async () => {
      await expect(async () => {
        await searchCommand.parseAsync(["node", "cli", "   "]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Keyword cannot be empty"),
      );
    });
  });

  describe("without agent context", () => {
    it("returns github first for an exact slug match", async () => {
      await searchCommand.parseAsync(["node", "cli", "github"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).not.toContain("No exact match");
      expect(output).toContain("Supported connector matches:");
      expect(output).not.toContain("Showing top");
      expect(output).not.toContain("AUTHORIZED FOR");
      expect(output).not.toContain("LABEL");
      expect(output).toContain("AVAILABLE");
      expect(output).toContain("CONNECTED AS");

      const dataRows = findDataRows(lines);
      expect(dataRows[0]).toMatch(/^github\s/);
    });

    it("does not match private environment names (GH_TOKEN)", async () => {
      await searchCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("No matches found.");
      const dataRows = findDataRows(lines);
      expect(dataRows).toHaveLength(0);
    });

    it("does not match private secret names (GH_API_KEY)", async () => {
      await searchCommand.parseAsync(["node", "cli", "GH_API_KEY"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("No matches found.");
      const dataRows = findDataRows(lines);
      expect(dataRows).toHaveLength(0);
    });

    it("matches multiple connectors by shared tag vcs", async () => {
      await searchCommand.parseAsync(["node", "cli", "vcs"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("No exact match. Showing closest:");
      const dataRows = findDataRows(lines);
      const slugs = dataRows.map((row) => {
        return row.split(/\s+/)[0];
      });
      expect(slugs).toContain("github");
      expect(slugs).toContain("gitlab");
    });

    it("ranks tag-exact above slug-substring above tag-substring", async () => {
      // Keyword "chat" exercises three scoring tiers against the real catalog
      // and pins the priority ordering contract so future refactors of
      // scoreConnector cannot silently reorder them:
      //   - microsoft-365, slack: tag-exact "chat" => 70, sorted by slug
      //   - chatwoot: slug-substring "chatwoot"    => 50
      //   - openai:   tag-substring "chatgpt"      => 25
      await searchCommand.parseAsync(["node", "cli", "chat", "--limit", "10"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const dataRows = findDataRows(lines);
      const slugs = dataRows.map((row) => {
        return row.split(/\s+/)[0];
      });
      const microsoft365Idx = slugs.indexOf("microsoft-365");
      const slackIdx = slugs.indexOf("slack");
      const chatwootIdx = slugs.indexOf("chatwoot");
      const openaiIdx = slugs.indexOf("openai");
      expect(microsoft365Idx).toBe(0);
      expect(slackIdx).toBe(1);
      expect(chatwootIdx).toBeGreaterThan(slackIdx);
      expect(openaiIdx).toBeGreaterThan(chatwootIdx);
    });

    it("prints No matches found for an unknown keyword", async () => {
      await searchCommand.parseAsync(["node", "cli", "xyz123abc"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("No matches found.");
      const dataRows = findDataRows(lines);
      expect(dataRows).toHaveLength(0);
    });

    it("finds a custom connector by display name", async () => {
      const connector = customConnector({
        connected: true,
        missingRequiredFields: [],
        configuredFieldKeys: ["secret:apiKey"],
      });
      server.use(stubCustomConnectors([connector]));

      await searchCommand.parseAsync(["node", "cli", "Acme Search"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const customRow = findDataRows(lines).find((line) => {
        return line.startsWith(connector.slug);
      });
      expect(customRow).toContain("connected");
    });

    it("finds org connectors with the custom keyword", async () => {
      const connector = customConnector();
      server.use(stubCustomConnectors([connector]));

      await searchCommand.parseAsync(["node", "cli", "custom"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      expect(findDataRows(lines)).toContainEqual(
        expect.stringMatching(new RegExp(`^${connector.slug}\\s`, "u")),
      );
    });

    it("returns every supported match by default", async () => {
      server.use(
        stubAvailableConnectors(["sheet-alpha", "sheet-beta", "sheet-gamma"]),
      );

      await searchCommand.parseAsync(["node", "cli", "sheet"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("Supported connector matches: 3.");
      expect(output).not.toContain("Showing top");
      expect(findDataRows(lines)).toHaveLength(3);
    });

    it("caps at --limit and reports the supported match count", async () => {
      await searchCommand.parseAsync(["node", "cli", "api", "--limit", "3"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toMatch(
        /Supported connector matches: \d+\. Showing top 3:/,
      );
      const dataRows = findDataRows(lines);
      expect(dataRows).toHaveLength(3);
    });

    it("rejects a non-positive --limit", async () => {
      await expect(async () => {
        await searchCommand.parseAsync([
          "node",
          "cli",
          "github",
          "--limit",
          "0",
        ]);
      }).rejects.toThrow();
    });

    it.each(["1abc", "1.5"])(
      "rejects malformed --limit value %s",
      async (limit) => {
        await expect(async () => {
          await searchCommand.parseAsync([
            "node",
            "cli",
            "github",
            "--limit",
            limit,
          ]);
        }).rejects.toThrow(
          `--limit must be a positive integer, got "${limit}"`,
        );
      },
    );
  });

  describe("with agent context", () => {
    it("adds AUTHORIZED FOR column when --agent is provided", async () => {
      server.use(
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await searchCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("AUTHORIZED FOR maya");
      const githubRow = findDataRows(lines).find((line) => {
        return line.startsWith("github");
      });
      expect(githubRow).toMatch(/✓/);
    });

    it.each([
      { selector: "omitted", args: [] },
      { selector: "matching", args: ["--agent", AGENT_UUID] },
    ])(
      "uses the run Agent and account with $selector --agent",
      async ({ args }) => {
        vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);
        writeRunConnectorAccountContext(contextPath, [
          {
            kind: "builtin",
            connectorSlug: "github",
            connectionId: RUN_CONNECTION_ID,
          },
        ]);
        server.use(
          stubConnectorCatalog([
            catalogItem({
              connectorSlug: "github",
              label: "GitHub",
              tags: ["vcs"],
              authMethods: [authCodeMethod("oauth")],
            }),
          ]),
          stubRunConnectorAccountInspection([
            {
              kind: "available",
              connectionId: RUN_CONNECTION_ID,
              target: { kind: "builtin", connectorSlug: "github" },
              authMethod: "oauth",
              displayName: "Run account B",
              externalId: "run-b",
              externalUsername: "run-b",
              externalEmail: "run-b@example.com",
              connectionStatus: "connected",
              reconnectReason: null,
            },
          ]),
          stubAgent(AGENT_UUID, "maya"),
          stubUserConnectors(AGENT_UUID, []),
        );

        await searchCommand.parseAsync(["node", "cli", "github", ...args]);

        const lines = mockConsoleLog.mock.calls.flat() as string[];
        const output = lines.join("\n");
        expect(output).toContain("AUTHORIZED FOR maya");
        expect(output).toContain("ACCOUNT USED BY THIS RUN");
        expect(output).toContain("Run account B");
        const githubRow = findDataRows(lines).find((line) => {
          return line.startsWith("github");
        });
        expect(githubRow).toMatch(/-/);
      },
    );

    it("uses the full UUID as the header when displayName is null", async () => {
      server.use(
        stubAgent(AGENT_UUID, null),
        stubUserConnectors(AGENT_UUID, []),
      );

      await searchCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const output = (mockConsoleLog.mock.calls.flat() as string[]).join("\n");
      expect(output).toContain(`AUTHORIZED FOR ${AGENT_UUID}`);
    });

    it("renders custom connector authorization for the agent", async () => {
      const connector = customConnector();
      server.use(
        stubCustomConnectors([connector]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
        stubAgentCustomConnectors([
          { customConnectorId: connector.id, permissionNames: [] },
        ]),
      );

      await searchCommand.parseAsync([
        "node",
        "cli",
        connector.slug,
        "--agent",
        AGENT_UUID,
      ]);

      const customRow = findDataRows(
        mockConsoleLog.mock.calls.flat() as string[],
      ).find((line) => {
        return line.startsWith(connector.slug);
      });
      expect(customRow).toMatch(/✓$/u);
    });
  });

  describe("CONNECTED AS column", () => {
    it("renders @username for a connected slug", async () => {
      server.use(stubConnectors([connectedGithub]));

      await searchCommand.parseAsync(["node", "cli", "github"]);

      const output = (mockConsoleLog.mock.calls.flat() as string[]).join("\n");
      expect(output).toContain("CONNECTED AS");
      expect(output).not.toContain("LABEL");
      expect(output).toContain("@octocat");
    });

    it("renders (not connected) for a slug with no connector", async () => {
      server.use(stubConnectors([]));

      await searchCommand.parseAsync(["node", "cli", "github"]);

      const output = (mockConsoleLog.mock.calls.flat() as string[]).join("\n");
      expect(output).toContain("(not connected)");
      expect(output).toContain(
        "http://localhost:3000/connectors/github/connect",
      );
    });

    it("renders reconnect-needed state", async () => {
      server.use(
        stubConnectors([
          { ...connectedGithub, connectionStatus: "reconnect-required" },
        ]),
      );

      await searchCommand.parseAsync(["node", "cli", "github"]);

      const output = (mockConsoleLog.mock.calls.flat() as string[]).join("\n");
      expect(output).toContain("@octocat (reconnect needed)");
    });

    it("renders permissions-update-available when oauth scopes are insufficient", async () => {
      server.use(
        stubConnectors([{ ...connectedGithub, oauthScopes: ["repo"] }]),
      );

      await searchCommand.parseAsync(["node", "cli", "github"]);

      const output = (mockConsoleLog.mock.calls.flat() as string[]).join("\n");
      expect(output).toContain("(permissions update available)");
    });
  });

  describe("run account column", () => {
    it("renders the exact reconnect-required run account instead of a healthy default sibling", async () => {
      let defaultStatusRequests = 0;
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);
      writeRunConnectorAccountContext(contextPath, [
        {
          kind: "builtin",
          connectorSlug: "github",
          connectionId: RUN_CONNECTION_ID,
        },
      ]);
      server.use(
        stubConnectorCatalog([
          catalogItem({
            connectorSlug: "github",
            label: "GitHub",
            tags: ["vcs"],
            authMethods: [authCodeMethod("oauth")],
          }),
        ]),
        stubRunConnectorAccountInspection([
          {
            kind: "available",
            connectionId: RUN_CONNECTION_ID,
            target: { kind: "builtin", connectorSlug: "github" },
            authMethod: "oauth",
            displayName: "Run account B",
            externalId: "run-b",
            externalUsername: "run-b",
            externalEmail: "run-b@example.com",
            connectionStatus: "reconnect-required",
            reconnectReason: "authorization_expired_or_revoked",
          },
        ]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
        http.get("http://localhost:3000/api/connector-catalog/status", () => {
          defaultStatusRequests += 1;
          return HttpResponse.json({
            connectors: [
              catalogStatusItem({
                connectorSlug: "github",
                connection: {
                  authMethod: "oauth",
                  externalUsername: "default-account-a",
                  externalEmail: null,
                  reconnectReason: null,
                },
                connected: true,
                connectionStatus: "connected",
              }),
            ],
          });
        }),
      );

      await searchCommand.parseAsync(["node", "cli", "github"]);

      const text = (mockConsoleLog.mock.calls.flat() as string[]).join("\n");
      expect(text).toContain("AVAILABLE THIS RUN");
      expect(text).toContain("ACCOUNT USED BY THIS RUN");
      expect(text).toContain("Run account B");
      expect(text).toContain("no (reconnect needed)");
      expect(text).toContain(
        `http://localhost:3000/connectors/github/reconnect/${RUN_CONNECTION_ID}?agentId=${AGENT_UUID}`,
      );
      expect(text).not.toContain("default-account-a");
      expect(defaultStatusRequests).toBe(0);
    });

    it("matches a custom run account by custom connector ID", async () => {
      const definition = customConnector({
        connected: true,
        missingRequiredFields: [],
        configuredFieldKeys: ["secret:apiKey"],
      });
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);
      writeRunConnectorAccountContext(contextPath, [
        {
          kind: "custom",
          customConnectorId: definition.id,
          connectionId: RUN_CONNECTION_ID,
        },
      ]);
      server.use(
        stubConnectorCatalog([]),
        stubCustomConnectors([definition]),
        stubRunConnectorAccountInspection([
          {
            kind: "available",
            connectionId: RUN_CONNECTION_ID,
            target: { kind: "custom", customConnectorId: definition.id },
            authMethod: "api-token",
            displayName: "Custom run account B",
            externalId: null,
            externalUsername: null,
            externalEmail: null,
            connectionStatus: "connected",
            reconnectReason: null,
          },
        ]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await searchCommand.parseAsync(["node", "cli", definition.slug]);

      expect(
        (mockConsoleLog.mock.calls.flat() as string[]).join("\n"),
      ).toContain("Custom run account B");
    });

    it("returns every supported run match and distinguishes availability", async () => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);
      writeRunConnectorAccountContext(contextPath, [
        {
          kind: "builtin",
          connectorSlug: "google-sheets",
          connectionId: RUN_CONNECTION_ID,
        },
      ]);
      server.use(
        stubConnectorCatalog([
          catalogItem({
            connectorSlug: "google-sheets",
            label: "Google Sheets",
          }),
          catalogItem({ connectorSlug: "sheetdb", label: "SheetDB" }),
        ]),
        stubRunConnectorAccountInspection([
          {
            kind: "available",
            connectionId: RUN_CONNECTION_ID,
            target: { kind: "builtin", connectorSlug: "google-sheets" },
            authMethod: "oauth",
            displayName: "Sheets account",
            externalId: "sheets-account",
            externalUsername: null,
            externalEmail: "sheets@example.com",
            connectionStatus: "connected",
            reconnectReason: null,
          },
        ]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["google-sheets"]),
      );

      await searchCommand.parseAsync(["node", "cli", "sheet"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("Supported connector matches: 2.");
      expect(output).toContain("AVAILABLE THIS RUN");
      expect(findDataRows(lines)).toHaveLength(2);
      expect(output).toMatch(/google-sheets\s+yes\s+Sheets account/u);
      expect(output).toMatch(/sheetdb\s+no \(not admitted\)\s+-/u);
    });

    it("retains a deleted exact ID and fails closed for missing legacy context", async () => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);
      writeRunConnectorAccountContext(contextPath, [
        {
          kind: "builtin",
          connectorSlug: "github",
          connectionId: RUN_CONNECTION_ID,
        },
      ]);
      server.use(
        stubConnectorCatalog([
          catalogItem({ connectorSlug: "github", label: "GitHub" }),
        ]),
        stubRunConnectorAccountInspection([]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await searchCommand.parseAsync(["node", "cli", "github"]);
      const metadataUnavailableOutput = (
        mockConsoleLog.mock.calls.flat() as string[]
      ).join("\n");
      expect(metadataUnavailableOutput).toContain(RUN_CONNECTION_ID);
      expect(metadataUnavailableOutput).toContain(
        "no (metadata unavailable or deleted)",
      );
      expect(metadataUnavailableOutput).toContain(
        `[Review GitHub accounts and agent access](http://localhost:3000/connectors?agentId=${AGENT_UUID})`,
      );
      expect(metadataUnavailableOutput).not.toContain(
        "/connectors/github/connect",
      );

      mockConsoleLog.mockClear();
      vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
      await searchCommand.parseAsync(["node", "cli", "github"]);
      expect(
        (mockConsoleLog.mock.calls.flat() as string[]).join("\n"),
      ).toContain("unknown (run context unavailable)");
    });
  });

  describe("connection guidance", () => {
    beforeEach(() => {
      vi.stubEnv("OKOU_AGENT_ID", AGENT_UUID);
      vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_UUID);
      writeRunConnectorAccountContext(contextPath, []);
      server.use(
        stubConnectorCatalog([
          catalogItem({
            connectorSlug: "google-sheets",
            label: "Google Sheets",
          }),
          catalogItem({ connectorSlug: "sheetdb", label: "SheetDB" }),
        ]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );
    });

    it("offers connection links for supported services that are not admitted to the run", async () => {
      await searchCommand.parseAsync(["node", "cli", "sheet"]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain(
        `[Connect or authorize Google Sheets](http://localhost:3000/connectors/google-sheets/connect?agentId=${AGENT_UUID})`,
      );
      expect(output).toContain(
        `[Connect or authorize SheetDB](http://localhost:3000/connectors/sheetdb/connect?agentId=${AGENT_UUID})`,
      );
      expect(output).toContain("--callback-prompt");
      expect(output).not.toContain("callbackPrompt=");
    });

    it("preserves the task in a callback link scoped to the current chat and configured app origin", async () => {
      vi.stubEnv("OKOU_APP_URL", "https://app.example.com");
      const callbackPrompt =
        "Check Google Sheets access, then review the user's Q3 budget & summarize it.";

      await searchCommand.parseAsync([
        "node",
        "cli",
        "google-sheets",
        "--limit",
        "1",
        "--callback-prompt",
        callbackPrompt,
      ]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      const link = output.match(
        /\[Connect or authorize Google Sheets\]\(([^)]+)\)/u,
      );
      expect(link).not.toBeNull();
      const url = new URL(link![1]!);
      expect(url.origin).toBe("https://app.example.com");
      expect(url.pathname).toBe("/connectors/google-sheets/connect");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        agentId: AGENT_UUID,
        threadId: THREAD_UUID,
        callbackPrompt,
      });
      expect(output).not.toContain("/connectors/sheetdb/");
    });

    it("rejects a callback when the search matches multiple connectors", async () => {
      await expect(
        searchCommand.parseAsync([
          "node",
          "cli",
          "sheet",
          "--callback-prompt",
          "Continue reviewing the spreadsheet",
        ]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        "--callback-prompt requires a single connector match",
      );
      expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
        "callbackPrompt=",
      );
    });

    it("rejects callback links for another agent", async () => {
      await expect(
        searchCommand.parseAsync([
          "node",
          "cli",
          "google-sheets",
          "--limit",
          "1",
          "--agent",
          ALT_AGENT_UUID,
          "--callback-prompt",
          "Continue reviewing the spreadsheet",
        ]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        `--agent ${ALT_AGENT_UUID} conflicts with the current run's Agent ${AGENT_UUID}`,
      );
      expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
        "callbackPrompt=",
      );
    });

    it("uses connector settings for custom connector setup", async () => {
      const connector = customConnector();
      server.use(stubConnectorCatalog([]), stubCustomConnectors([connector]));

      await searchCommand.parseAsync(["node", "cli", connector.slug]);

      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain(
        `[Review ${connector.displayName} accounts and agent access](http://localhost:3000/connectors?agentId=${AGENT_UUID})`,
      );
      expect(output).not.toContain(`/connectors/${connector.slug}/authorize`);
    });

    it("offers authorization for a connected service when inspecting an agent outside a run", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "");
      server.use(stubConnectors([connectedGithub]));

      await searchCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
        "--limit",
        "1",
      ]);

      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `http://localhost:3000/connectors/github/authorize?agentId=${AGENT_UUID}`,
      );
    });
  });

  describe("auth method feature flag filtering", () => {
    it("excludes zapier from search results when ZapierConnector feature switch is disabled (default)", async () => {
      server.use(
        stubConnectors([]),
        stubAgent(AGENT_UUID, "test"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await searchCommand.parseAsync([
        "node",
        "cli",
        "zapier",
        "--agent",
        AGENT_UUID,
      ]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      const dataRows = findDataRows(lines);
      const slugs = dataRows.map((row) => {
        return row.split(/\s+/)[0];
      });
      expect(slugs).not.toContain("zapier");
      expect(output).not.toContain("zapier");
    });

    it("includes connectors with ungated api-token auth even when oauth is feature-gated", async () => {
      server.use(
        stubConnectors([]),
        stubAgent(AGENT_UUID, "test"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await searchCommand.parseAsync([
        "node",
        "cli",
        "mercury",
        "--agent",
        AGENT_UUID,
      ]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const dataRows = findDataRows(lines);
      const slugs = dataRows.map((row) => {
        return row.split(/\s+/)[0];
      });
      // mercury has an ungated api-token auth method, so it is always visible.
      expect(slugs).toContain("mercury");
    });

    it("uses the server-visible catalog for feature-gated oauth connectors", async () => {
      server.use(stubAvailableConnectors(["google-ads"]));

      await searchCommand.parseAsync(["node", "cli", "google ads"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const dataRows = findDataRows(lines);
      expect(dataRows[0]).toMatch(/^google-ads\s/);
    });
  });

  describe("error handling", () => {
    it("surfaces auth errors from public connector catalog status", async () => {
      server.use(
        http.get("http://localhost:3000/api/connector-catalog/status", () => {
          return HttpResponse.json(
            {
              error: { message: "Not authenticated", code: "UNAUTHORIZED" },
            },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await searchCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Authentication failed"),
      );
    });
  });
});
