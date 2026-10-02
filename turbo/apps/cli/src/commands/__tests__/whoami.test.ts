import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConnectorAccountInspectionResult } from "@okouai/api-contracts/contracts/connector-accounts";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type {
  CustomConnectorMcpResponse,
  CustomConnectorPermissionBundleResponse,
  CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { server } from "../../mocks/server";
import {
  catalogItem,
  catalogPermissionDetail,
  stubConnectorCatalog,
  stubConnectorCatalogPermissions,
} from "./helpers/connector-catalog";
import {
  customConnector,
  stubAgentCustomConnectors,
  stubCustomConnectors,
} from "./helpers/custom-connectors";
import {
  stubRunConnectorAccountInspection,
  writeRunConnectorAccountContext,
} from "./helpers/run-connector-accounts";
import { whoamiCommand } from "../whoami";

type AvailableConnectorAccount = Extract<
  ConnectorAccountInspectionResult,
  { readonly kind: "available" }
>;

interface RunConnectorFixture {
  readonly connectorSlug: string;
  readonly connectionId?: string | null;
  readonly metadataAvailable?: boolean;
  readonly authMethod?: AvailableConnectorAccount["authMethod"];
  readonly displayName?: string | null;
  readonly externalId?: string | null;
  readonly externalUsername?: string | null;
  readonly externalEmail?: string | null;
  readonly connectionStatus?: AvailableConnectorAccount["connectionStatus"];
  readonly reconnectReason?: AvailableConnectorAccount["reconnectReason"];
}

function buildJwt(payload: Record<string, unknown>, prefix: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = "test-signature";
  return `${prefix}${header}.${body}.${signature}`;
}

/**
 * Build a valid OKOU_TOKEN for testing.
 * Format: vm0_sandbox_<header>.<payload>.<signature>
 */
function buildOkouToken(payload: Record<string, unknown>): string {
  return buildJwt(payload, "vm0_sandbox_");
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
    agentId: "agent-123",
    connectorSlug: "slack",
    permission: "conversations:read",
    action: "allow",
    expiresAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

const defaultPermissionDetails = [
  catalogPermissionDetail({
    connectorSlug: "github",
    label: "GitHub",
  }),
  catalogPermissionDetail({
    connectorSlug: "slack",
    label: "Slack",
    permissions: [
      {
        name: "admin.conversations:read",
        description: "Read conversations",
      },
      { name: "chat:write", description: "Send messages" },
      { name: "reactions:read", description: "Read reactions" },
    ],
    defaultPolicy: {
      permissionDefault: "allow",
      unknownPolicy: "allow",
    },
  }),
];

describe("okou whoami command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  let directory = "";
  let contextPath = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "okou-whoami-run-account-"));
    contextPath = join(directory, "context.json");
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", contextPath);
    writeRunConnectorAccountContext(contextPath, []);
    server.use(
      stubConnectorCatalog([]),
      stubCustomConnectors([]),
      stubConnectorCatalogPermissions(defaultPermissionDetails),
    );
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function fixtureConnectionId(
    fixture: RunConnectorFixture,
    index: number,
  ): string | null {
    return fixture.connectionId === undefined
      ? `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`
      : fixture.connectionId;
  }

  function setRunConnectors(fixtures: readonly RunConnectorFixture[]): void {
    const targets = fixtures.map((fixture, index) => {
      return {
        kind: "builtin" as const,
        connectorSlug: fixture.connectorSlug,
        connectionId: fixtureConnectionId(fixture, index),
      };
    });
    const availableAccounts = fixtures.flatMap((fixture, index) => {
      const connectionId = fixtureConnectionId(fixture, index);
      if (connectionId === null || fixture.metadataAvailable === false) {
        return [];
      }
      const target = {
        kind: "builtin" as const,
        connectorSlug: fixture.connectorSlug,
      };
      const connectionStatus = fixture.connectionStatus ?? "connected";
      return [
        {
          kind: "available" as const,
          target,
          connectionId,
          authMethod: fixture.authMethod ?? "oauth",
          displayName: fixture.displayName ?? null,
          externalId: fixture.externalId ?? null,
          externalUsername: fixture.externalUsername ?? null,
          externalEmail: fixture.externalEmail ?? null,
          connectionStatus,
          reconnectReason:
            fixture.reconnectReason ??
            (connectionStatus === "reconnect-required"
              ? "authorization_expired_or_revoked"
              : null),
        } satisfies AvailableConnectorAccount,
      ];
    });
    writeRunConnectorAccountContext(contextPath, targets);
    server.use(
      stubConnectorCatalog(
        fixtures.map((fixture) => {
          return catalogItem({ connectorSlug: fixture.connectorSlug });
        }),
      ),
      stubCustomConnectors([]),
      stubRunConnectorAccountInspection(availableAccounts),
    );
  }

  function getAllOutput(): string[] {
    return mockConsoleLog.mock.calls
      .map((call) => {
        return call[0] as string | undefined;
      })
      .filter((call): call is string => {
        return call !== undefined;
      });
  }

  async function runWhoami(args: string[] = []): Promise<void> {
    await whoamiCommand.parseAsync(["node", "cli", ...args]);
  }

  describe("sandbox mode (OKOU_AGENT_ID set)", () => {
    it("should show agent ID, run context, and capabilities with full JWT", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "agent:write"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("agent-123");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Run ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("run-abc");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Org ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("org-xyz");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Capabilities:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("agent:read");
        }),
      ).toBe(true);
    });

    it("should show the workspace name and tier", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          userId: "user-1",
          runId: "run-abc",
          orgId: "org-xyz",
          scope: "okou",
          capabilities: ["agent:read"],
          iat: 1000,
          exp: 2000,
        }),
      );
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Workspace:  Default Workspace");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Tier:       limited-free-1");
        }),
      ).toBe(true);
    });

    it("should still print identity when the org lookup fails", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          userId: "user-1",
          runId: "run-abc",
          orgId: "org-xyz",
          scope: "okou",
          capabilities: ["agent:read"],
          iat: 1000,
          exp: 2000,
        }),
      );
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
      server.use(
        http.get("http://localhost:3000/api/org", () => {
          return HttpResponse.json(
            { error: { message: "Organization not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Workspace:");
        }),
      ).toBe(false);
      expect(
        output.some((line) => {
          return line.includes("agent-123");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Capabilities:");
        }),
      ).toBe(true);
    });

    it("should show unavailable when OKOU_TOKEN is missing", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-no-token");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("agent-no-token");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Run ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("unavailable");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Capabilities:");
        }),
      ).toBe(false);
    });

    it("should show unavailable when OKOU_TOKEN is malformed", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-bad-token");
      vi.stubEnv("OKOU_TOKEN", "not-a-valid-token");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("agent-bad-token");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("unavailable");
        }),
      ).toBe(true);
    });

    it("should show connected service identities", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      setRunConnectors([
        {
          connectorSlug: "github",
          externalId: "12345",
          externalUsername: "octocat",
          externalEmail: "octocat@github.com",
        },
        {
          connectorSlug: "google",
          externalId: "67890",
          externalEmail: "user@gmail.com",
        },
      ]);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return (
            line.includes("github") &&
            line.includes("@octocat") &&
            line.includes("(octocat@github.com)") &&
            !line.includes("legacy-github")
          );
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("google") && line.includes("user@gmail.com");
        }),
      ).toBe(true);
    });

    it("should show needs reconnect warning", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      let ownerDefaultRequests = 0;
      setRunConnectors([
        {
          connectorSlug: "slack",
          displayName: "Run account B",
          externalId: "S123",
          externalUsername: "john.doe",
          connectionStatus: "reconnect-required",
        },
      ]);
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          ownerDefaultRequests += 1;
          return HttpResponse.json({
            connectors: [
              {
                id: "00000000-0000-4000-8000-000000000099",
                slug: "slack",
                authMethod: "oauth",
                externalId: "default-a",
                externalUsername: "default-a",
                externalEmail: null,
                oauthScopes: ["chat:write"],
                connectionStatus: "connected",
                reconnectReason: null,
                tokenExpiresAt: null,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            connectorProvidedBindings: [],
          });
        }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return (
            line.includes("@john.doe") && line.includes("(needs reconnect)")
          );
        }),
      ).toBe(true);
      expect(output.join("\n")).not.toContain("default-a");
      expect(ownerDefaultRequests).toBe(0);
    });

    it("should ignore a reconnect-required default when the run account is healthy", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          userId: "user-1",
          runId: "run-abc",
          orgId: "org-xyz",
          scope: "okou",
          capabilities: ["agent:read", "connector:read"],
          iat: 1000,
          exp: 2000,
        }),
      );
      let ownerDefaultRequests = 0;
      setRunConnectors([
        {
          connectorSlug: "slack",
          displayName: "Run account B",
          externalUsername: "run-b",
          connectionStatus: "connected",
        },
      ]);
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          ownerDefaultRequests += 1;
          return HttpResponse.json({
            connectors: [
              {
                id: "00000000-0000-4000-8000-000000000099",
                slug: "slack",
                authMethod: "oauth",
                externalId: "default-a",
                externalUsername: "default-a",
                externalEmail: null,
                oauthScopes: ["chat:write"],
                connectionStatus: "reconnect-required",
                reconnectReason: "authorization_expired_or_revoked",
                tokenExpiresAt: null,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            connectorProvidedBindings: [],
          });
        }),
      );

      await runWhoami();

      const output = getAllOutput().join("\n");
      expect(output).toContain("@run-b");
      expect(output).not.toContain("needs reconnect");
      expect(output).not.toContain("default-a");
      expect(ownerDefaultRequests).toBe(0);
    });

    it("should gracefully handle exact account inspection errors", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      setRunConnectors([
        {
          connectorSlug: "github",
          externalUsername: "run-account",
        },
      ]);
      server.use(
        http.post(
          "http://localhost:3000/api/connector-accounts/inspect",
          () => {
            return HttpResponse.json(
              { error: { message: "Forbidden", code: "FORBIDDEN" } },
              { status: 403 },
            );
          },
        ),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("run-abc");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(false);
    });

    it("should skip the connector section for a valid empty run projection", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(false);
    });

    it("should retain a deleted exact account without falling back", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          userId: "user-1",
          runId: "run-abc",
          orgId: "org-xyz",
          scope: "okou",
          capabilities: ["agent:read", "connector:read"],
          iat: 1000,
          exp: 2000,
        }),
      );
      const deletedConnectionId = "33333333-3333-4333-8333-333333333333";
      let ownerDefaultRequests = 0;
      setRunConnectors([
        {
          connectorSlug: "github",
          connectionId: deletedConnectionId,
          metadataAvailable: false,
        },
      ]);
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          ownerDefaultRequests += 1;
          return HttpResponse.json({
            connectors: [],
            connectorProvidedBindings: [],
          });
        }),
      );

      await runWhoami();

      const output = getAllOutput().join("\n");
      expect(output).toContain(deletedConnectionId);
      expect(output).toContain("metadata unavailable or deleted");
      expect(ownerDefaultRequests).toBe(0);
    });

    it("should show a null run account as unavailable without falling back", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          userId: "user-1",
          runId: "run-abc",
          orgId: "org-xyz",
          scope: "okou",
          capabilities: ["agent:read", "connector:read"],
          iat: 1000,
          exp: 2000,
        }),
      );
      let ownerDefaultRequests = 0;
      setRunConnectors([{ connectorSlug: "github", connectionId: null }]);
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          ownerDefaultRequests += 1;
          return HttpResponse.json({
            connectors: [],
            connectorProvidedBindings: [],
          });
        }),
      );

      await runWhoami();

      const output = getAllOutput().join("\n");
      expect(output).toContain("github");
      expect(output).toContain("unavailable for this run");
      expect(ownerDefaultRequests).toBe(0);
    });

    it("should show unavailable when a legacy run has no projection", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          userId: "user-1",
          runId: "run-abc",
          orgId: "org-xyz",
          scope: "okou",
          capabilities: ["agent:read", "connector:read"],
          iat: 1000,
          exp: 2000,
        }),
      );
      vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");

      await runWhoami();

      const output = getAllOutput().join("\n");
      expect(output).toContain("Connectors:");
      expect(output).toContain("started without connector account context");
    });

    it("should show unavailable when the run projection is malformed", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          userId: "user-1",
          runId: "run-abc",
          orgId: "org-xyz",
          scope: "okou",
          capabilities: ["agent:read", "connector:read"],
          iat: 1000,
          exp: 2000,
        }),
      );
      writeFileSync(contextPath, "{", "utf8");

      await runWhoami();

      const output = getAllOutput().join("\n");
      expect(output).toContain("Connectors:");
      expect(output).toContain("connector account context is malformed");
    });

    it("should show identity without permission details by default", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      setRunConnectors([
        {
          connectorSlug: "github",
          externalId: "12345",
          externalUsername: "octocat",
          externalEmail: "octocat@github.com",
        },
      ]);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return (
            line.includes("@octocat") && line.includes("(octocat@github.com)")
          );
        }),
      ).toBe(true);
      // No permission icons in default mode
      expect(
        output.some((line) => {
          return line.includes("✓") || line.includes("✗") || line.includes("?");
        }),
      ).toBe(false);
      expect(
        output.some((line) => {
          return line.includes("full access");
        }),
      ).toBe(false);
    });

    it("should show connector permissions with --permissions flag", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      let ownerDefaultRequests = 0;
      setRunConnectors([
        {
          connectorSlug: "slack",
          displayName: "Run account B",
          externalId: "S12345",
          externalUsername: "john.doe",
          externalEmail: "john@example.com",
        },
      ]);
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          ownerDefaultRequests += 1;
          return HttpResponse.json({
            connectors: [],
            connectorProvidedBindings: [],
          });
        }),
        mockUserPermissionGrantsHandler([
          makePermissionGrant({
            permission: "admin.conversations:read",
            action: "allow",
          }),
          makePermissionGrant({
            connectorSlug: "slack",
            permission: "chat:write",
            action: "deny",
          }),
          makePermissionGrant({
            permission: "reactions:read",
            action: "allow",
          }),
        ]),
        http.get(
          "http://localhost:3000/api/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["slack"] });
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return (
            line.includes("@john.doe") && line.includes("(john@example.com)")
          );
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("✓") && line.includes("conversations:read");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("✗") && line.includes("chat:write");
        }),
      ).toBe(true);
      expect(ownerDefaultRequests).toBe(0);
    });

    it("should show permissions for a server-authored connector slug", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

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
      setRunConnectors([
        {
          connectorSlug: "server-only",
          authMethod: "api-token",
          externalId: "server-user",
          externalUsername: "server-user",
        },
      ]);
      server.use(
        stubConnectorCatalogPermissions([
          ...defaultPermissionDetails,
          serverOnlyDetail,
        ]),
        mockUserPermissionGrantsHandler([
          makePermissionGrant({
            connectorSlug: "server-only",
            permission: "records.read",
            action: "allow",
          }),
        ]),
        http.get(
          "http://localhost:3000/api/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json({
              enabledConnectorSlugs: ["server-only"],
            });
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("server-only") && line.includes("@server-user");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("✓") && line.includes("records.read");
        }),
      ).toBe(true);
    });

    it("should show full access with --permissions for connector with null policies", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      setRunConnectors([
        {
          connectorSlug: "github",
          externalId: "12345",
          externalUsername: "octocat",
          externalEmail: "octocat@github.com",
        },
      ]);
      server.use(
        mockUserPermissionGrantsHandler(),
        http.get(
          "http://localhost:3000/api/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("@octocat");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("unknown endpoints");
        }),
      ).toBe(true);
    });

    it("should show identity only when permission grant API fails with --permissions", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      setRunConnectors([
        {
          connectorSlug: "github",
          externalId: "12345",
          externalUsername: "octocat",
          externalEmail: "octocat@github.com",
        },
      ]);
      server.use(
        http.get("http://localhost:3000/api/user-permission-grants", () => {
          return HttpResponse.json(
            { error: { message: "Internal Server Error", code: "INTERNAL" } },
            { status: 500 },
          );
        }),
        http.get(
          "http://localhost:3000/api/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("@octocat");
        }),
      ).toBe(true);
      // No permission lines when grants are unavailable
      expect(
        output.some((line) => {
          return line.includes("✓") || line.includes("✗") || line.includes("?");
        }),
      ).toBe(false);
      expect(
        output.some((line) => {
          return line.includes("full access");
        }),
      ).toBe(false);
    });

    it("should retain exact account identity when permission metadata fails", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      setRunConnectors([
        {
          connectorSlug: "github",
          externalId: "12345",
          externalUsername: "octocat",
          externalEmail: "octocat@github.com",
        },
      ]);
      server.use(
        mockUserPermissionGrantsHandler(),
        http.get(
          "http://localhost:3000/api/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
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

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent ID:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(true);
      expect(output.join("\n")).toContain("@octocat");
    });

    it("should show identity only when connector access API fails with --permissions", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      setRunConnectors([
        {
          connectorSlug: "github",
          externalId: "12345",
          externalUsername: "octocat",
          externalEmail: "octocat@github.com",
        },
      ]);
      server.use(
        mockUserPermissionGrantsHandler([
          makePermissionGrant({
            connectorSlug: "github",
            permission: "repo",
            action: "allow",
          }),
        ]),
        // user-connectors API fails
        http.get(
          "http://localhost:3000/api/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json(
              { error: { message: "Forbidden", code: "FORBIDDEN" } },
              { status: 403 },
            );
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("@octocat");
        }),
      ).toBe(true);
      // No permission lines when connector access data is unavailable
      expect(
        output.some((line) => {
          return line.includes("✓") || line.includes("✗") || line.includes("?");
        }),
      ).toBe(false);
      expect(
        output.some((line) => {
          return line.includes("full access");
        }),
      ).toBe(false);
    });

    it("should show an exact account fallback when external identity is absent", async () => {
      const token = buildOkouToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "okou",
        capabilities: ["agent:read", "connector:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv("OKOU_TOKEN", token);
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");

      setRunConnectors([
        {
          connectorSlug: "github",
          externalId: "12345",
          externalUsername: "octocat",
          externalEmail: "octocat@github.com",
        },
        {
          connectorSlug: "axiom",
          connectionId: "22222222-2222-4222-8222-222222222222",
          authMethod: "api-token",
        },
      ]);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Connectors:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("@octocat");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("axiom") && line.includes("Account #22222222");
        }),
      ).toBe(true);
    });
  });

  describe("custom connector authorization", () => {
    const ordinaryHttp = customConnector({
      permissionBundleRef: null,
      connected: true,
      connectedAccountId: "11111111-1111-4111-8111-111111111111",
      missingRequiredFields: [],
      configuredFieldKeys: ["apiKey"],
    });
    const mcp: CustomConnectorMcpResponse = {
      kind: "mcp",
      id: "44444444-4444-4444-8444-444444444444",
      slug: "_acme-mcp",
      displayName: "Acme MCP",
      endpoint: "https://mcp.acme.test/server",
      transport: "streamable-http",
      prefixTemplates: [],
      fields: [],
      headerInjections: [],
      queryInjections: [],
      permissionBundleRef: null,
      authMode: "none",
      storageVersion: 1,
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const bundledHttp = customConnector({
      ...ordinaryHttp,
      permissionBundleRef: "builtin:airtable@1",
    });
    const bundle: CustomConnectorPermissionBundleResponse = {
      ref: "builtin:airtable@1",
      permissions: [
        { name: "records:read", description: "Read records" },
        { name: "records:write", description: "Write records" },
        { name: "records:delete", description: "Delete records" },
        { name: "schema:write", description: "Change the schema" },
        { name: "records:export", description: "Export records" },
      ],
      defaultPolicies: {
        "records:read": "allow",
        "records:write": "deny",
        "records:delete": "deny",
        "schema:write": "ask",
      },
    };

    beforeEach(() => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          userId: "user-1",
          runId: "run-abc",
          orgId: "org-xyz",
          scope: "okou",
          capabilities: ["agent:read", "connector:read"],
          iat: 1000,
          exp: 2000,
        }),
      );
    });

    function setCustomRunConnectors(
      definitions: readonly CustomConnectorResponse[],
      grants: readonly AgentCustomConnectorGrant[],
    ): void {
      const accounts: AvailableConnectorAccount[] = [
        {
          kind: "available",
          target: { kind: "builtin", connectorSlug: "github" },
          connectionId: "22222222-2222-4222-8222-222222222222",
          authMethod: "oauth",
          displayName: null,
          externalId: "github-run-account",
          externalUsername: "octocat",
          externalEmail: null,
          connectionStatus: "connected",
          reconnectReason: null,
        },
        ...definitions.map((definition, index): AvailableConnectorAccount => {
          return {
            kind: "available",
            target: { kind: "custom", customConnectorId: definition.id },
            connectionId: `00000000-0000-4000-8000-${(index + 100).toString().padStart(12, "0")}`,
            authMethod: "api-token",
            displayName: "Run account B",
            externalId: "run-account-b",
            externalUsername: "run-account-b",
            externalEmail: null,
            connectionStatus: "connected",
            reconnectReason: null,
          };
        }),
      ];
      writeRunConnectorAccountContext(
        contextPath,
        accounts.map((account) => {
          return { ...account.target, connectionId: account.connectionId };
        }),
      );
      server.use(
        stubConnectorCatalog([catalogItem({ connectorSlug: "github" })]),
        stubCustomConnectors(definitions),
        stubRunConnectorAccountInspection(accounts),
        stubAgentCustomConnectors(grants),
        mockUserPermissionGrantsHandler(),
        http.get(
          "http://localhost:3000/api/agents/agent-123/user-connectors",
          () => {
            return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
          },
        ),
        http.get(
          "http://localhost:3000/api/custom-connectors/:id",
          ({ params }) => {
            const definition = definitions.find((item) => {
              return item.id === params.id;
            });
            return definition
              ? HttpResponse.json(definition)
              : HttpResponse.json({}, { status: 404 });
          },
        ),
        http.get(
          "http://localhost:3000/api/custom-connectors/:id/permissions",
          () => {
            return HttpResponse.json(bundle);
          },
        ),
      );
    }

    function connectorOutput(slug: string): string {
      const lines = getAllOutput();
      const start = lines.findIndex((line) => {
        return line.startsWith(`  ${slug}`);
      });
      expect(start).toBeGreaterThanOrEqual(0);
      const following = lines.slice(start + 1);
      const next = following.findIndex((line) => {
        return /^ {2}\S/u.test(line);
      });
      return [
        lines[start],
        ...following.slice(0, next === -1 ? undefined : next),
      ].join("\n");
    }

    it.each([
      { name: "ordinary HTTP", definition: ordinaryHttp },
      { name: "MCP", definition: mcp },
    ])(
      "shows $name enablement with an empty permission selection",
      async ({ definition }) => {
        setCustomRunConnectors(
          [definition],
          [{ customConnectorId: definition.id, permissionNames: [] }],
        );

        await runWhoami(["--permissions"]);

        const output = connectorOutput(definition.slug);
        expect(output).toContain("@run-account-b");
        expect(output).toContain("Agent enablement: enabled");
        expect(output).toContain(
          "Connector-level authorization (no named permissions)",
        );
        expect(output).not.toContain("full access");
        expect(output).not.toContain("Named permissions:");
        expect(output).not.toContain(ordinaryHttp.connectedAccountId);
        expect(connectorOutput("github")).toContain("@octocat");
      },
    );

    it.each([ordinaryHttp, mcp])(
      "shows $slug as not enabled despite a connected account",
      async (definition) => {
        setCustomRunConnectors([definition], []);

        await runWhoami(["--permissions"]);

        const output = connectorOutput(definition.slug);
        expect(output).toContain("@run-account-b");
        expect(output).toContain("Agent enablement: not enabled");
        expect(output).toContain("Connector-level authorization");
      },
    );

    it("shows selected permissions and effective bundle defaults", async () => {
      setCustomRunConnectors(
        [bundledHttp],
        [
          {
            customConnectorId: bundledHttp.id,
            permissionNames: ["records:write"],
          },
        ],
      );

      await runWhoami(["--permissions"]);

      const output = connectorOutput(bundledHttp.slug);
      expect(output).toContain("Agent enablement: enabled");
      expect(output).toMatch(/✓ records:write\s+Write records \(selected\)/u);
      expect(output).toMatch(/✓ records:read\s+Read records \(default\)/u);
      expect(output).toMatch(/✗ records:delete\s+Delete records \(default\)/u);
      expect(output).toMatch(
        /\? schema:write\s+Change the schema \(default\)/u,
      );
      expect(output).toMatch(/✗ records:export\s+Export records \(default\)/u);
      expect(output).toContain("✗ unknown endpoints");
    });

    it("uses server-resolved Feishu defaults with an empty explicit selection", async () => {
      const feishu = customConnector({
        ...ordinaryHttp,
        slug: "_feishu-managed",
        permissionBundleRef: "builtin:feishu@1",
      });
      setCustomRunConnectors(
        [feishu],
        [{ customConnectorId: feishu.id, permissionNames: [] }],
      );
      server.use(
        http.get(
          `http://localhost:3000/api/custom-connectors/${feishu.id}/permissions`,
          () => {
            return HttpResponse.json({
              ref: "builtin:feishu@1",
              permissions: [
                { name: "messages:read", description: "Read messages" },
                { name: "messages:send-as-user", description: "Send as user" },
              ],
              defaultPolicies: {
                "messages:read": "allow",
                "messages:send-as-user": "deny",
              },
            } satisfies CustomConnectorPermissionBundleResponse);
          },
        ),
      );

      await runWhoami(["--permissions"]);

      const output = connectorOutput(feishu.slug);
      expect(output).toContain("Agent enablement: enabled");
      expect(output).toMatch(/✓ messages:read\s+Read messages \(default\)/u);
      expect(output).toMatch(
        /✗ messages:send-as-user\s+Send as user \(default\)/u,
      );
      expect(output).not.toContain("(selected)");
    });

    it("keeps bundled permission names visible without granting defaults to a disabled Agent", async () => {
      setCustomRunConnectors([bundledHttp], []);

      await runWhoami(["--permissions"]);

      const output = connectorOutput(bundledHttp.slug);
      expect(output).toContain("Agent enablement: not enabled");
      expect(output).toContain("records:read");
      expect(output).toContain("Read records");
      expect(output).not.toMatch(/[✓✗?]/u);
      expect(output).not.toContain("(default)");
    });

    it.each([
      { name: "forbidden", status: 403, body: {} },
      { name: "server error", status: 500, body: {} },
      {
        name: "malformed grants",
        status: 200,
        body: {
          grants: [
            { customConnectorId: bundledHttp.id, permissionNames: null },
          ],
        },
      },
    ])(
      "reports $name as unavailable enablement while retaining bundle metadata",
      async ({ status, body }) => {
        setCustomRunConnectors([bundledHttp], []);
        server.use(
          http.get(
            "http://localhost:3000/api/agents/agent-123/custom-connectors",
            () => {
              return HttpResponse.json(body, { status });
            },
          ),
        );

        await runWhoami(["--permissions"]);

        const output = connectorOutput(bundledHttp.slug);
        expect(output).toContain("@run-account-b");
        expect(output).toContain("Agent enablement: unavailable");
        expect(output).toContain("records:read");
        expect(output).not.toContain("not enabled");
        expect(output).not.toContain("(default)");
        expect(output).not.toMatch(/[✓✗?]/u);
        expect(connectorOutput("github")).toContain("unknown endpoints");
      },
    );

    it.each([
      { name: "missing definition", path: "", status: 404, body: {} },
      { name: "failed definition", path: "", status: 500, body: {} },
      {
        name: "mismatched definition",
        path: "",
        status: 200,
        body: { ...bundledHttp, id: mcp.id },
      },
      {
        name: "incomplete HTTP metadata",
        path: "",
        status: 200,
        body: { ...bundledHttp, permissionBundleRef: undefined },
      },
      { name: "missing bundle", path: "/permissions", status: 404, body: {} },
      { name: "failed bundle", path: "/permissions", status: 500, body: {} },
      {
        name: "malformed bundle",
        path: "/permissions",
        status: 200,
        body: { ...bundle, defaultPolicies: null },
      },
      {
        name: "changed bundle reference",
        path: "/permissions",
        status: 200,
        body: { ...bundle, ref: "builtin:feishu@1" },
      },
    ])(
      "reports $name as unavailable metadata while retaining Agent enablement",
      async ({ path, status, body }) => {
        setCustomRunConnectors(
          [bundledHttp],
          [{ customConnectorId: bundledHttp.id, permissionNames: [] }],
        );
        server.use(
          http.get(
            `http://localhost:3000/api/custom-connectors/${bundledHttp.id}${path}`,
            () => {
              return HttpResponse.json(body, { status });
            },
          ),
        );

        await runWhoami(["--permissions"]);

        const output = connectorOutput(bundledHttp.slug);
        expect(output).toContain("@run-account-b");
        expect(output).toContain("Agent enablement: enabled");
        expect(output).toContain("Permission information unavailable");
        expect(output).not.toContain("Connector-level authorization");
        expect(output).not.toContain("full access");
        expect(connectorOutput("github")).toContain("unknown endpoints");
      },
    );

    it("retains healthy custom siblings when one definition read fails", async () => {
      setCustomRunConnectors(
        [ordinaryHttp, mcp],
        [
          { customConnectorId: ordinaryHttp.id, permissionNames: [] },
          { customConnectorId: mcp.id, permissionNames: [] },
        ],
      );
      server.use(
        http.get(
          `http://localhost:3000/api/custom-connectors/${mcp.id}`,
          () => {
            return HttpResponse.json({}, { status: 500 });
          },
        ),
      );

      await runWhoami(["--permissions"]);

      expect(connectorOutput(ordinaryHttp.slug)).toContain(
        "Connector-level authorization",
      );
      expect(connectorOutput(mcp.slug)).toContain(
        "Permission information unavailable",
      );
      expect(connectorOutput(mcp.slug)).toContain("Agent enablement: enabled");
      expect(connectorOutput("github")).toContain("unknown endpoints");
    });

    it("retains custom authorization and account identity when builtin metadata fails", async () => {
      setCustomRunConnectors(
        [ordinaryHttp],
        [{ customConnectorId: ordinaryHttp.id, permissionNames: [] }],
      );
      server.use(
        http.get(
          "http://localhost:3000/api/connector-catalog/github/permissions",
          () => {
            return HttpResponse.json({}, { status: 500 });
          },
        ),
      );

      await runWhoami(["--permissions"]);

      expect(connectorOutput(ordinaryHttp.slug)).toContain(
        "Agent enablement: enabled",
      );
      expect(connectorOutput("github")).toContain("@octocat");
    });

    it("keeps enablement independent from unavailable exact accounts", async () => {
      setCustomRunConnectors(
        [ordinaryHttp],
        [{ customConnectorId: ordinaryHttp.id, permissionNames: [] }],
      );
      server.use(stubRunConnectorAccountInspection([]));

      await runWhoami(["--permissions"]);

      const output = connectorOutput(ordinaryHttp.slug);
      expect(output).toContain("metadata unavailable or deleted");
      expect(output).toContain("Agent enablement: enabled");
      expect(output).not.toContain(ordinaryHttp.connectedAccountId);
    });

    it("does not read custom authorization details for ordinary whoami", async () => {
      setCustomRunConnectors([bundledHttp], []);
      const requests: string[] = [];
      server.use(
        http.get(
          "http://localhost:3000/api/agents/agent-123/custom-connectors",
          ({ request }) => {
            requests.push(request.url);
            return HttpResponse.json({ grants: [] });
          },
        ),
        http.get(
          `http://localhost:3000/api/custom-connectors/${bundledHttp.id}`,
          ({ request }) => {
            requests.push(request.url);
            return HttpResponse.json(bundledHttp);
          },
        ),
        http.get(
          `http://localhost:3000/api/custom-connectors/${bundledHttp.id}/permissions`,
          ({ request }) => {
            requests.push(request.url);
            return HttpResponse.json(bundle);
          },
        ),
      );

      await runWhoami();

      const output = connectorOutput(bundledHttp.slug);
      expect(output).toContain("@run-account-b");
      expect(output).not.toContain("Agent enablement:");
      expect(requests).toEqual([]);
    });
  });

  describe("local mode (no OKOU_AGENT_ID)", () => {
    beforeEach(() => {
      vi.stubEnv("OKOU_AGENT_ID", "");
    });

    it("should show authenticated via OKOU_TOKEN env var", async () => {
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          scope: "okou",
          orgId: "test-org",
          userId: "user-1",
          runId: "run-1",
          capabilities: [],
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Authenticated");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("OKOU_TOKEN env var");
        }),
      ).toBe(true);
    });

    it("should show not authenticated when no token exists", async () => {
      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Not authenticated");
        }),
      ).toBe(true);
    });

    it("should identify an invalid OKOU_TOKEN", async () => {
      vi.stubEnv("OKOU_TOKEN", "not-an-okou-token");

      await runWhoami();

      expect(getAllOutput()).toContain("  Status:     Invalid OKOU_TOKEN");
    });

    it("should identify an expired OKOU_TOKEN", async () => {
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          scope: "okou",
          orgId: "test-org",
          userId: "user-1",
          runId: "run-1",
          capabilities: [],
          exp: Math.floor(Date.now() / 1000) - 1,
        }),
      );

      await runWhoami();

      expect(getAllOutput()).toContain("  Status:     Expired OKOU_TOKEN");
    });

    it("should display active org from OKOU_TOKEN", async () => {
      const okouToken = buildOkouToken({
        scope: "okou",
        orgId: "test-org-slug",
        userId: "user-1",
        runId: "run-1",
        capabilities: [],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      vi.stubEnv("OKOU_TOKEN", okouToken);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Org:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("test-org-slug");
        }),
      ).toBe(true);
    });
  });
});
