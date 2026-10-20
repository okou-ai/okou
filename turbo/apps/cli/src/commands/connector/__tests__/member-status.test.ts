import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import {
  connectorAccount,
  stubConnectorAccounts,
} from "../../__tests__/helpers/connector-accounts";
import {
  catalogStatusItem,
  stubConnectorCatalog,
  stubConnectorCatalogDetail,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import { customConnectorCommand } from "../custom/index";
import { statusCommand } from "../status";

const BUILTIN_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOM_ID = "22222222-2222-4222-8222-222222222222";
const STALE_ID = "44444444-4444-4444-8444-444444444444";
const builtinTarget = { kind: "builtin", connectorSlug: "github" } as const;
const custom = customConnector({
  connected: true,
  connectedAccountId: STALE_ID,
  configuredFieldKeys: ["apiKey"],
  missingRequiredFields: [],
});
const customTarget = { kind: "custom", customConnectorId: custom.id } as const;
const readers = [
  {
    name: "status",
    command: statusCommand,
    args: ["github"],
    target: builtinTarget,
    id: BUILTIN_ID,
  },
  {
    name: "custom status",
    command: customConnectorCommand,
    args: ["status", custom.id],
    target: customTarget,
    id: CUSTOM_ID,
  },
  {
    name: "custom show",
    command: customConnectorCommand,
    args: ["show", custom.id],
    target: customTarget,
    id: CUSTOM_ID,
  },
] as const;

function installDefinitions() {
  const catalog = catalogStatusItem({
    connectorSlug: "github",
    label: "GitHub",
    connected: true,
    scopeMismatch: true,
    connection: {
      id: STALE_ID,
      authMethod: "oauth",
      externalUsername: "stale",
      externalEmail: null,
      reconnectReason: null,
    },
  });
  server.use(
    stubConnectorCatalog([catalog]),
    stubConnectorCatalogDetail([catalog]),
    stubCustomConnectors([custom]),
    http.get(`http://localhost:3000/api/custom-connectors/${custom.id}`, () => {
      return HttpResponse.json(custom);
    }),
  );
}

describe("current-member connector status", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("command exited");
  });

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_AGENT_ID", undefined);
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", undefined);
    for (const command of [statusCommand, ...customConnectorCommand.commands]) {
      command.setOptionValue("json", false);
      command.setOptionValue("agent", undefined);
    }
    installDefinitions();
  });

  afterEach(() => {
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  function output(name: string) {
    const value = JSON.parse(log.mock.calls.flat().join("\n"));
    return name === "custom show" ? value : value.connector;
  }

  it.each(readers)(
    "$name preserves an expired saved default and healthy sibling",
    async ({ command, args, name, target, id }) => {
      const account = connectorAccount(target, {
        id,
        displayName: "Default work account",
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      });
      server.use(
        stubConnectorAccounts([
          account,
          connectorAccount(target, {
            isDefault: false,
            displayName: "Personal",
          }),
        ]),
      );
      await command.parseAsync(["node", "okou", ...args, "--json"]);
      expect(output(name)).toMatchObject({
        memberStatus: "reconnect-required",
        connectionId: id,
        accountSummary: {
          accountCount: 2,
          attentionCount: 1,
          defaultConnection: { id, connectionStatus: "reconnect-required" },
        },
      });
    },
  );

  it.each(
    readers.flatMap((reader) => {
      return [
        {
          ...reader,
          state: "incomplete",
          changes: {
            setupStatus: "incomplete",
            missingRequiredFields: ["apiKey"],
          },
          expected: "setup-required",
        },
        {
          ...reader,
          state: "invalid",
          changes: { setupStatus: "invalid" },
          expected: "setup-required",
        },
        {
          ...reader,
          state: "unknown",
          changes: { setupStatus: undefined },
          expected: "account-review-required",
        },
      ] satisfies readonly (typeof reader & {
        state: string;
        changes: Partial<ConnectorAccountConnection>;
        expected: string;
      })[];
    }),
  )(
    "$name reports $state setup independently of definition projections",
    async ({ command, args, name, target, id, changes, expected }) => {
      server.use(
        stubConnectorAccounts([connectorAccount(target, { id, ...changes })]),
      );
      await command.parseAsync(["node", "okou", ...args, "--json"]);
      expect(output(name)).toMatchObject({
        memberStatus: expected,
        connectionId: id,
      });
    },
  );

  it.each(readers)(
    "$name distinguishes empty accounts from saved accounts without a default",
    async ({ command, args, name, target }) => {
      server.use(stubConnectorAccounts([]));
      await command.parseAsync(["node", "okou", ...args, "--json"]);
      expect(output(name)).toMatchObject({
        memberStatus: "not-connected",
        connectionId: null,
        accountSummary: null,
      });
      log.mockClear();
      server.use(
        stubConnectorAccounts([connectorAccount(target, { isDefault: false })]),
      );
      await command.parseAsync(["node", "okou", ...args, "--json"]);
      expect(output(name)).toMatchObject({
        memberStatus: "default-required",
        connectionId: null,
        accountSummary: { accountCount: 1, defaultConnection: null },
      });
    },
  );

  it.each(readers)(
    "$name uses the independent default while collecting every target page",
    async ({ command, args, name, target, id }) => {
      const selected = connectorAccount(target, {
        id,
        displayName: "Chosen default",
      });
      const sibling = connectorAccount(target, {
        isDefault: false,
        setupStatus: "incomplete",
        missingRequiredFields: ["apiKey"],
      });
      server.use(
        http.get(
          "http://localhost:3000/api/connector-accounts/connections",
          ({ request }) => {
            const query = new URL(request.url).searchParams;
            expect(query.get("kind")).toBe(target.kind);
            expect(
              query.get(
                target.kind === "builtin"
                  ? "connectorSlug"
                  : "customConnectorId",
              ),
            ).toBe(
              target.kind === "builtin"
                ? target.connectorSlug
                : target.customConnectorId,
            );
            expect(query.get("includeScopeMismatch")).toBe(
              target.kind === "builtin" ? "true" : null,
            );
            return HttpResponse.json({
              connections: query.has("cursor") ? [selected] : [sibling],
              defaultConnection: selected,
              nextCursor: query.has("cursor") ? null : "page-2",
            });
          },
        ),
      );
      await command.parseAsync(["node", "okou", ...args, "--json"]);
      expect(output(name)).toMatchObject({
        memberStatus: "connected",
        connectionId: id,
        accountSummary: {
          accountCount: 2,
          attentionCount: 1,
          defaultConnection: { id },
        },
      });
    },
  );

  it.each([true, false, undefined])(
    "preserves canonical builtin scope mismatch %s without using a sibling's projection",
    async (scopeMismatch) => {
      server.use(
        stubConnectorAccounts([
          connectorAccount(builtinTarget, { id: BUILTIN_ID, scopeMismatch }),
        ]),
      );
      await statusCommand.parseAsync(["node", "okou", "github", "--json"]);
      expect(output("status")).toMatchObject({
        memberStatus:
          scopeMismatch === undefined ? "account-review-required" : "connected",
        connectionId: BUILTIN_ID,
      });
      expect(output("status").scopeMismatch).toBe(scopeMismatch);
    },
  );

  it("prints target account identity, sibling attention and permission update guidance", async () => {
    server.use(
      stubConnectorAccounts([
        connectorAccount(builtinTarget, {
          id: BUILTIN_ID,
          displayName: "Work",
          scopeMismatch: true,
        }),
        connectorAccount(builtinTarget, {
          isDefault: false,
          connectionStatus: "reconnect-required",
        }),
      ]),
    );
    await statusCommand.parseAsync(["node", "okou", "github"]);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "Work (@member) (2 accounts) (1/2 need attention) (permissions update available)",
    );
  });

  it("keeps a refreshable builtin connected when its saved token timestamp has expired", async () => {
    server.use(
      stubConnectorAccounts([
        connectorAccount(builtinTarget, {
          id: BUILTIN_ID,
          tokenExpiresAt: "2025-01-01T00:00:00.000Z",
        }),
      ]),
    );
    await statusCommand.parseAsync(["node", "okou", "github", "--json"]);
    expect(output("status")).toMatchObject({
      memberStatus: "connected",
      accountSummary: {
        defaultConnection: { tokenExpiresAt: "2025-01-01T00:00:00.000Z" },
      },
    });
  });

  it.each(readers)(
    "$name reports removed or unowned target accounts as unavailable",
    async ({ command, args, name }) => {
      server.use(
        http.get(
          "http://localhost:3000/api/connector-accounts/connections",
          () => {
            return HttpResponse.json(
              {
                error: {
                  code: "NOT_FOUND",
                  message: "Account target unavailable",
                },
              },
              { status: 404 },
            );
          },
        ),
      );
      await command.parseAsync(["node", "okou", ...args, "--json"]);
      expect(output(name)).toMatchObject({
        memberStatus: "unavailable",
        connectionId: null,
        accountSummary: null,
      });
    },
  );

  it.each(readers)(
    "$name surfaces account read failures without reporting empty data",
    async ({ command, args }) => {
      server.use(
        http.get(
          "http://localhost:3000/api/connector-accounts/connections",
          () => {
            return HttpResponse.json(
              {
                error: {
                  code: "UNAVAILABLE",
                  message: "Account metadata unavailable",
                },
              },
              { status: 503 },
            );
          },
        ),
      );
      await expect(
        command.parseAsync(["node", "okou", ...args, "--json"]),
      ).rejects.toThrow("command exited");
      expect(error.mock.calls.flat().join("\n")).toContain(
        "Account metadata unavailable",
      );
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing default selection instead of inferring one from a row", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/connector-accounts/connections",
        () => {
          return HttpResponse.json({
            connections: [connectorAccount(builtinTarget)],
            nextCursor: null,
          });
        },
      ),
    );
    await expect(
      statusCommand.parseAsync(["node", "okou", "github", "--json"]),
    ).rejects.toThrow("command exited");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "missing the default account selection",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it.each(
    readers.filter((reader) => {
      return reader.name.startsWith("custom");
    }),
  )(
    "$name keeps the member account view inside a Run",
    async ({ command, args, name, target, id }) => {
      const agentId = "550e8400-e29b-41d4-a716-446655440000";
      vi.stubEnv("OKOU_AGENT_ID", agentId);
      server.use(
        stubConnectorAccounts([connectorAccount(target, { id })]),
        http.get(`http://localhost:3000/api/agents/${agentId}`, () => {
          return HttpResponse.json({
            agentId,
            ownerId: "owner",
            displayName: "Research",
            description: null,
            sound: null,
            avatarUrl: null,
          });
        }),
        http.get(
          `http://localhost:3000/api/agents/${agentId}/custom-connectors`,
          () => {
            return HttpResponse.json({ grants: [] });
          },
        ),
      );
      await command.parseAsync(["node", "okou", ...args, "--json"]);
      expect(output(name)).toMatchObject({
        memberStatus: "connected",
        connectionId: id,
      });
    },
  );

  it.each(
    readers.filter((reader) => {
      return reader.name.startsWith("custom");
    }),
  )(
    "$name keeps integration-managed accounts on their existing lifecycle",
    async ({ command, args, name }) => {
      const managed = customConnector({
        authMode: "oauth",
        connected: true,
        connectedAccountId: undefined,
        fields: [],
        headerInjections: [],
        configuredFieldKeys: [],
        missingRequiredFields: [],
        oauthConfig: {
          providerAdapter: "feishu",
          clientId: "managed-client",
          authorizationUrl: "https://auth.example.test/authorize",
          tokenUrl: "https://auth.example.test/token",
          tokenEndpointAuthMethod: "client_secret_post",
          pkceMethod: "S256",
          scopes: [],
          authorizationParams: {},
        },
      });
      server.use(
        http.get(
          `http://localhost:3000/api/custom-connectors/${managed.id}`,
          () => {
            return HttpResponse.json(managed);
          },
        ),
      );
      await command.parseAsync(["node", "okou", ...args, "--json"]);
      expect(output(name)).toMatchObject({
        integrationManaged: true,
        accountSummary: null,
        memberStatus: "connected",
      });
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("preserves a missing custom definition's unavailable JSON", async () => {
    server.use(
      http.get(
        `http://localhost:3000/api/custom-connectors/${custom.id}`,
        () => {
          return HttpResponse.json(
            { error: { code: "NOT_FOUND", message: "Definition unavailable" } },
            { status: 404 },
          );
        },
      ),
    );
    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "status",
      custom.id,
      "--json",
    ]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      state: "unavailable",
      connector: null,
      target: customTarget,
    });
    expect(process.exitCode).toBe(1);
  });
});
