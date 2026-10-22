/**
 * Tests for okou agent view command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import {
  catalogPermissionDetail,
  stubConnectorCatalogPermissions,
} from "../../__tests__/helpers/connector-catalog";
import { viewCommand } from "../view";
import chalk from "chalk";

const mockAgent = {
  agentId: "comp_abc123",
  displayName: "My Agent",
  description: "A test agent",
  sound: "professional",
  visibility: "private",
};

const defaultPermissionDetails = [
  catalogPermissionDetail({
    connectorSlug: "github",
    label: "GitHub",
  }),
  catalogPermissionDetail({
    connectorSlug: "slack",
    label: "Slack",
    permissions: [
      { name: "conversations:read", description: "Read conversations" },
      { name: "chat:write", description: "Send messages" },
      { name: "reactions:read", description: "Read reactions" },
    ],
    defaultPolicy: {
      permissionDefault: "allow",
      unknownPolicy: "allow",
    },
  }),
];

function mockConnectorListHandler(connectors: Record<string, unknown>[] = []) {
  return http.get("http://localhost:3000/api/connectors", () => {
    return HttpResponse.json({
      connectors,
    });
  });
}

function mockUserPermissionGrantsHandler(
  grants: Record<string, unknown>[] = [],
) {
  return http.get("http://localhost:3000/api/user-permission-grants", () => {
    return HttpResponse.json(grants);
  });
}

function makePermissionGrant(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "comp_abc123",
    connectorSlug: "slack",
    permission: "conversations:read",
    action: "allow",
    expiresAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeConnector(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    slug: "github",
    authMethod: "oauth",
    externalId: "12345",
    externalUsername: "octocat",
    externalEmail: "octocat@github.com",
    oauthScopes: ["repo"],
    connectionStatus: "connected",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("okou agent view command", () => {
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
    server.use(mockUserPermissionGrantsHandler());
    server.use(stubConnectorCatalogPermissions(defaultPermissionDetails));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("successful view", () => {
    it("should display agent info", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("comp_abc123");
      expect(logCalls).toContain("A test agent");
      expect(logCalls).toContain("professional");
      expect(logCalls).toContain("Visibility:   private");
      expect(logCalls).toContain("github (full access)");
    });

    it("should display preset avatar", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            avatarUrl: "preset:2",
          });
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: [] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Avatar:");
      expect(logCalls).toContain(
        "preset:2 (medium skin, pink hair, neutral, chill)",
      );
    });

    it("should display custom svg avatar", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            avatarUrl: "svg:r3s4h1c2f5h",
          });
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: [] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Avatar:");
      expect(logCalls).toContain(
        "custom (dark skin, teal hair, excited, hyped)",
      );
    });

    it("should not display avatar when null", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            avatarUrl: null,
          });
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: [] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("Avatar:");
    });

    it("should resolve connector summary from connector defaults", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["slack"] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("slack");
      expect(logCalls).not.toContain("slack (0/");
    });

    it("should load a server-authored connector once per unique slug", async () => {
      let permissionRequests = 0;
      const serverOnlyDetail = catalogPermissionDetail({
        connectorSlug: "server-only",
        label: "Server Only",
        permissions: [
          { name: "records.read", description: "Read server records" },
        ],
        defaultPolicy: {
          permissionDefault: "deny",
          unknownPolicy: "deny",
        },
      });
      server.use(
        http.get(
          "http://localhost:3000/api/connector-catalog/server-only/permissions",
          () => {
            permissionRequests += 1;
            return HttpResponse.json({ permissions: serverOnlyDetail });
          },
        ),
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({
              enabledConnectorSlugs: ["server-only"],
            });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("server-only (0/1 allowed)");
      expect(permissionRequests).toBe(1);
    });

    it("should show instructions content with --instructions flag", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: [] });
          },
        ),
        mockConnectorListHandler(),
        http.get(
          "http://localhost:3000/api/agents/my-agent/instructions",
          () => {
            return HttpResponse.json({
              content: "Do the thing",
              filename: "CLAUDE.md",
            });
          },
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--instructions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Do the thing");
    });

    it("should show empty instructions message when no instructions set", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: [] });
          },
        ),
        mockConnectorListHandler(),
        http.get(
          "http://localhost:3000/api/agents/my-agent/instructions",
          () => {
            return HttpResponse.json({ content: null, filename: null });
          },
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--instructions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No instructions set");
    });
  });

  describe("--permissions flag", () => {
    it("should show detailed permissions with allow/deny icons", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
          });
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["slack"] });
          },
        ),
        mockUserPermissionGrantsHandler([
          makePermissionGrant({
            permission: "conversations:read",
            action: "allow",
          }),
          makePermissionGrant({
            permission: "chat:write",
            action: "deny",
          }),
          makePermissionGrant({
            permission: "reactions:read",
            action: "allow",
          }),
        ]),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toMatch(/slack \(\d+\/\d+ allowed\)/);
      expect(logCalls).toContain("✓");
      expect(logCalls).toContain("✗");
    });

    it("should show full access for connectors without policies", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("unknown endpoints");
    });

    it("should handle connectors without permissions gracefully", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({
              enabledConnectorSlugs: ["custom-connector"],
            });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("custom-connector");
    });
  });

  describe("connector identity", () => {
    it("should show identity in connector summary line", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        mockConnectorListHandler([makeConnector()]),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github @octocat (full access)");
    });

    it("should show full identity in permissions detail", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        mockConnectorListHandler([makeConnector()]),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("@octocat (octocat@github.com)");
    });

    it("should work without identity when connector API fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.json(
            { error: { message: "Forbidden", code: "FORBIDDEN" } },
            { status: 403 },
          );
        }),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github (full access)");
      expect(logCalls).not.toContain("@octocat");
    });

    it("should skip identity for connectors without identity data", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        mockConnectorListHandler([
          makeConnector({
            authMethod: "api-token",
            externalUsername: null,
            externalEmail: null,
          }),
        ]),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("@");
    });

    it("should show needs reconnect warning in identity line", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        mockConnectorListHandler([
          makeConnector({ connectionStatus: "reconnect-required" }),
        ]),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("@octocat (octocat@github.com)");
      expect(logCalls).toContain("(needs reconnect)");
    });

    it("should show email-only identity when no username", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        mockConnectorListHandler([
          makeConnector({
            externalUsername: null,
            externalEmail: "user@example.com",
          }),
        ]),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github user@example.com (full access)");
    });
  });

  describe("error handling", () => {
    it("should handle not found error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/missing", () => {
          return HttpResponse.json(
            { error: { message: "Agent not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await viewCommand.parseAsync(["node", "cli", "missing"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail instead of treating permission API errors as no metadata", async () => {
      server.use(
        http.get("http://localhost:3000/api/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        mockConnectorListHandler(),
        http.get(
          "http://localhost:3000/api/connector-catalog/github/permissions",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Permission service unavailable",
                  code: "INTERNAL",
                },
              },
              { status: 500 },
            );
          },
        ),
      );

      await expect(async () => {
        await viewCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("500: Permission service unavailable"),
      );
    });
  });
});
