import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import {
  connectorAccount,
  connectorAccountSummary,
  stubConnectorAccountSummaries,
} from "../../__tests__/helpers/connector-accounts";
import {
  catalogStatusItem,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import { customConnectorCommand } from "../custom/index";
import { listCommand } from "../list";
import { searchCommand } from "../search";
import { statusCommand } from "../status";

const BUILTIN_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOM_ID = "22222222-2222-4222-8222-222222222222";
const STALE_ID = "44444444-4444-4444-8444-444444444444";
const builtinTarget = { kind: "builtin", connectorSlug: "github" } as const;
const custom = customConnector({
  connected: true,
  connectedAccountId: CUSTOM_ID,
  configuredFieldKeys: ["apiKey"],
  missingRequiredFields: [],
});
const customTarget = {
  kind: "custom",
  customConnectorId: custom.id,
} as const;

function installMemberFixture(expired = true) {
  const summaries = [builtinTarget, customTarget].map((target, index) => {
    return connectorAccountSummary(target, [
      connectorAccount(target, {
        id: index === 0 ? BUILTIN_ID : CUSTOM_ID,
        authMethod: index === 0 ? "oauth" : "manual",
        displayName: "Default work account",
        connectionStatus: expired ? "reconnect-required" : "connected",
        reconnectReason: expired ? "authorization_expired_or_revoked" : null,
      }),
      connectorAccount(target, { isDefault: false, displayName: "Personal" }),
    ]);
  });
  const definition = {
    ...custom,
    connected: !expired,
    connectedAccountId: expired ? undefined : CUSTOM_ID,
  };
  server.use(
    stubConnectorCatalogStatus([
      catalogStatusItem({
        connectorSlug: "github",
        label: "GitHub",
        connected: true,
        connectionStatus: expired ? "reconnect-required" : "connected",
        connection: {
          id: BUILTIN_ID,
          authMethod: "oauth",
          externalUsername: "member",
          externalEmail: null,
          reconnectReason: expired ? "authorization_expired_or_revoked" : null,
        },
      }),
    ]),
    stubCustomConnectors([definition]),
    http.get(`http://localhost:3000/api/custom-connectors/${custom.id}`, () => {
      return HttpResponse.json(definition);
    }),
    stubConnectorAccountSummaries(summaries),
  );
  return summaries;
}

const readers = [
  { name: "list", command: listCommand, args: [], inventory: true },
  { name: "search", command: searchCommand, args: ["acme"], inventory: true },
  {
    name: "status",
    command: statusCommand,
    args: ["github"],
    inventory: false,
  },
  {
    name: "custom list",
    command: customConnectorCommand,
    args: ["list"],
    inventory: true,
  },
  {
    name: "custom status",
    command: customConnectorCommand,
    args: ["status", custom.id],
    inventory: false,
  },
  {
    name: "custom show",
    command: customConnectorCommand,
    args: ["show", custom.id],
    inventory: false,
  },
] as const;

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
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", undefined);
    for (const command of [
      listCommand,
      searchCommand,
      statusCommand,
      ...customConnectorCommand.commands,
    ]) {
      command.setOptionValue("json", false);
      command.setOptionValue("agent", undefined);
    }
    searchCommand.setOptionValue("callbackPrompt", undefined);
    searchCommand.setOptionValue("limit", undefined);
  });

  afterEach(() => {
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it.each(readers)(
    "$name JSON preserves an expired saved default and healthy sibling",
    async ({ command, args, inventory, name }) => {
      installMemberFixture();
      await command.parseAsync(["node", "okou", ...args, "--json"]);
      const output: {
        connectors?: readonly object[];
        connector?: object;
      } = JSON.parse(log.mock.calls.flat().join("\n"));
      const values = inventory
        ? output.connectors
        : name === "custom show"
          ? [output]
          : [output.connector];
      expect(values).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            memberStatus: "reconnect-required",
            connectionId: name === "status" ? BUILTIN_ID : CUSTOM_ID,
            accountSummary: expect.objectContaining({
              accountCount: 2,
              attentionCount: 1,
              defaultConnection: expect.objectContaining({
                id: name === "status" ? BUILTIN_ID : CUSTOM_ID,
                connectionStatus: "reconnect-required",
              }),
            }),
          }),
        ]),
      );
    },
  );

  it.each(
    readers.filter((reader) => {
      return reader.name !== "custom show";
    }),
  )(
    "$name text describes saved defaults needing reconnect",
    async ({ command, args }) => {
      installMemberFixture();
      await command.parseAsync(["node", "okou", ...args]);
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("reconnect needed");
      expect(output).toContain("Default work account");
      expect(output).toContain("2");
    },
  );

  it("keeps zero, healthy, incomplete setup and default conflicts distinct", async () => {
    const summaries = installMemberFixture(false);
    server.use(stubConnectorAccountSummaries([]));
    await listCommand.parseAsync(["node", "okou", "--json"]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      connectors: [
        {
          memberStatus: "not-connected",
          accountSummary: null,
          connectionId: null,
        },
        {
          memberStatus: "not-connected",
          accountSummary: null,
          connectionId: null,
        },
      ],
    });
    log.mockClear();
    server.use(stubConnectorAccountSummaries(summaries));
    await listCommand.parseAsync(["node", "okou", "--json"]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      connectors: [
        { memberStatus: "connected" },
        { memberStatus: "connected" },
      ],
    });
    log.mockClear();
    server.use(
      stubCustomConnectors([
        { ...custom, connected: false, missingRequiredFields: ["apiKey"] },
      ]),
    );
    await listCommand.parseAsync(["node", "okou", "--json"]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      connectors: [
        { memberStatus: "connected" },
        { memberStatus: "setup-required", connectionId: CUSTOM_ID },
      ],
    });
    log.mockClear();
    server.use(
      stubCustomConnectors([{ ...custom, connectedAccountId: STALE_ID }]),
    );
    await listCommand.parseAsync(["node", "okou", "--json"]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      connectors: [
        { memberStatus: "connected" },
        { memberStatus: "account-review-required", connectionId: CUSTOM_ID },
      ],
    });
  });

  it("directs saved accounts with no default to management", async () => {
    const summaries = installMemberFixture(false).map(
      (summary): ConnectorAccountSummary => {
        return { ...summary, defaultConnection: null };
      },
    );
    server.use(stubConnectorAccountSummaries(summaries));
    await searchCommand.parseAsync(["node", "okou", "github", "--json"]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      connectors: [
        {
          memberStatus: "default-required",
          connectionId: null,
          accountSummary: { accountCount: 2 },
        },
      ],
      actions: [
        { url: "http://localhost:3000/connectors", supportsCallback: false },
      ],
    });
  });

  it.each(readers)(
    "$name fails visibly when account metadata cannot be read",
    async ({ command, args }) => {
      installMemberFixture();
      server.use(
        http.get("http://localhost:3000/api/connector-accounts", () => {
          return HttpResponse.json(
            {
              error: {
                code: "UNAVAILABLE",
                message: "Account metadata unavailable",
              },
            },
            { status: 503 },
          );
        }),
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

  it("separates healthy-default availability, sibling attention and Agent grants", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    const summaries = installMemberFixture(false).map((summary) => {
      return { ...summary, attentionCount: 1 };
    });
    server.use(
      stubConnectorAccountSummaries(summaries),
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
        `http://localhost:3000/api/agents/${agentId}/user-connectors`,
        () => {
          return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
        },
      ),
      http.get(
        `http://localhost:3000/api/agents/${agentId}/custom-connectors`,
        () => {
          return HttpResponse.json({ grants: [] });
        },
      ),
    );
    await listCommand.parseAsync([
      "node",
      "okou",
      "--json",
      "--agent",
      agentId,
    ]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      connectors: [
        {
          memberStatus: "connected",
          authorized: true,
          accountSummary: { attentionCount: 1 },
        },
        {
          memberStatus: "connected",
          authorized: false,
          accountSummary: { attentionCount: 1 },
        },
      ],
    });
    log.mockClear();
    await searchCommand.parseAsync([
      "node",
      "okou",
      "acme",
      "--agent",
      agentId,
    ]);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("no (not authorized)");
    expect(output).toContain("1/2 need attention");
    expect(output).toContain("/connectors?agentId=");
  });

  it.each(["Feishu", "Lark"])(
    "keeps managed %s on its integration lifecycle",
    async (name) => {
      installMemberFixture(false);
      const managed = customConnector({
        displayName: name,
        authMode: "oauth",
        connected: true,
        fields: [],
        connectedAccountId: undefined,
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
        stubCustomConnectors([managed]),
        stubConnectorAccountSummaries([]),
      );
      await customConnectorCommand.parseAsync([
        "node",
        "okou",
        "list",
        "--json",
      ]);
      expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
        connectors: [
          {
            integrationManaged: true,
            accountSummary: null,
            memberStatus: "connected",
          },
        ],
      });
    },
  );

  it("rejects malformed summaries instead of fabricating zero accounts", async () => {
    installMemberFixture();
    server.use(
      http.get("http://localhost:3000/api/connector-accounts", () => {
        return HttpResponse.json({
          summaries: [{ target: customTarget, accountCount: "unknown" }],
        });
      }),
    );
    await expect(
      listCommand.parseAsync(["node", "okou", "--json"]),
    ).rejects.toThrow("command exited");
    expect(error).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
