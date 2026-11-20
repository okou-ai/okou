import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConnectorAccountInspectionResult } from "@okouai/api-contracts/contracts/connector-accounts";
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
import { stubCustomConnectors } from "./helpers/custom-connectors";
import {
  stubRunConnectorAccountInspection,
  stubRunConnectorAccountInventory,
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
          missingRequiredFields: [],
          configuredFieldKeys: [],
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
    it("shows shared builtin and custom permissions with the original expiry", async () => {
      vi.stubEnv("OKOU_AGENT_ID", "agent-123");
      vi.stubEnv(
        "OKOU_TOKEN",
        buildOkouToken({
          userId: "user-1",
          orgId: "org-1",
          runId: "run-1",
          scope: "okou",
          capabilities: ["connector-account:switch"],
        }),
      );
      const github = { kind: "builtin", connectorSlug: "github" } as const;
      const custom = {
        kind: "custom",
        customConnectorId: "33333333-3333-4333-8333-333333333333",
      } as const;
      server.use(
        stubRunConnectorAccountInventory({
          accounts: [
            {
              target: github,
              connectionId: "11111111-1111-4111-8111-111111111111",
              displayName: "Account B",
              enabled: true,
              isCurrent: true,
              isDefault: false,
            },
            {
              target: custom,
              connectionId: "55555555-5555-4555-8555-555555555555",
              displayName: "Custom account",
              enabled: false,
              isCurrent: false,
              isDefault: true,
            },
          ],
          permissionGrants: [
            {
              target: github,
              permission: "contents:write",
              action: "allow",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            {
              target: custom,
              permission: "items:write",
              action: "deny",
              expiresAt: null,
            },
          ],
        }),
      );

      await runWhoami(["--permissions"]);

      const output = getAllOutput().join("\n");
      expect(output).toContain("Account B");
      expect(output).toContain("no allowed account");
      expect(output).toContain(
        "contents:write: allow until 2099-01-01T00:00:00.000Z",
      );
      expect(output).toContain("items:write: deny");
      expect(output).toContain("shared across Chats and accounts");
    });

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
      server.use(
        http.get("*/api/auth/me", () =>
          HttpResponse.json(
            { error: { code: "UNAUTHORIZED", message: "Invalid token" } },
            { status: 401 },
          ),
        ),
      );

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
