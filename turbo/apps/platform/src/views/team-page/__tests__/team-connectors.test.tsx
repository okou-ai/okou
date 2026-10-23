import { connectorFixtureAccount } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { screen, waitFor, within } from "@testing-library/react";
import type { PublicConnectorCatalogStatusItem } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  customConnectorsContract,
  customConnectorByIdContract,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { customConnectorAccount } from "../../okou-page/__tests__/connector-page-test-helpers.ts";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  RESEARCH_AGENT_ID,
  SUPPORT_AGENT_ID,
  acmeConnectorFixture,
  agentFixture,
  catalogConnectorFixture,
  deepWikiConnectorFixture,
  mockConnectorOverview,
  setupTeamPage,
} from "./team-page-test-helpers.ts";

const context = testContext();

interface ConnectorSurfaceOptions {
  readonly catalog?: readonly PublicConnectorCatalogStatusItem[];
  readonly customConnectors?: readonly CustomConnectorResponse[];
  readonly connectedCustomConnectorIds?: readonly string[];
  readonly initialBuiltInByAgent?: Readonly<Record<string, readonly string[]>>;
  readonly initialCustomByAgent?: Readonly<
    Record<string, readonly AgentCustomConnectorGrant[]>
  >;
  readonly onCustomSave?: (args: {
    readonly agentId: string;
    readonly grants: readonly AgentCustomConnectorGrant[];
    readonly operation: "add" | "remove" | "replace" | undefined;
  }) => void;
}

function applyStringOperation(
  current: readonly string[],
  requested: readonly string[],
  operation: "add" | "remove" | "replace" | undefined,
): string[] {
  if (operation === "add") {
    return Array.from(new Set([...current, ...requested]));
  }
  if (operation === "remove") {
    return current.filter((value) => {
      return !requested.includes(value);
    });
  }
  return [...requested];
}

function applyGrantOperation(
  current: readonly AgentCustomConnectorGrant[],
  requested: readonly AgentCustomConnectorGrant[],
  operation: "add" | "remove" | "replace" | undefined,
): AgentCustomConnectorGrant[] {
  if (operation === "add") {
    const next = new Map(
      current.map((grant) => {
        return [grant.customConnectorId, grant] as const;
      }),
    );
    for (const grant of requested) {
      next.set(grant.customConnectorId, grant);
    }
    return [...next.values()];
  }
  if (operation === "remove") {
    const removedIds = new Set(
      requested.map((grant) => {
        return grant.customConnectorId;
      }),
    );
    return current.filter((grant) => {
      return !removedIds.has(grant.customConnectorId);
    });
  }
  return [...requested];
}

function mockConnectorSurface(
  testContextValue: TestContext,
  options: ConnectorSurfaceOptions = {},
): void {
  const builtInByAgent = new Map(
    Object.entries(options.initialBuiltInByAgent ?? {}).map(
      ([agentId, slugs]) => {
        return [agentId, [...slugs]] as const;
      },
    ),
  );
  const customByAgent = new Map(
    Object.entries(options.initialCustomByAgent ?? {}).map(
      ([agentId, grants]) => {
        return [agentId, [...grants]] as const;
      },
    ),
  );

  mockConnectorOverview(testContextValue, options.catalog ?? [], {
    customConnectors: options.customConnectors,
    connectedCustomConnectorIds: options.connectedCustomConnectorIds,
  });
  testContextValue.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [...(options.customConnectors ?? [])],
    });
  });
  testContextValue.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const connector = (options.customConnectors ?? []).find((candidate) => {
        return (
          query.kind === "custom" && candidate.id === query.customConnectorId
        );
      });
      const account = connector
        ? (connectorFixtureAccount(connector) ?? null)
        : null;
      return respond(200, {
        connections: account ? [account] : [],
        defaultConnection: account,
        nextCursor: null,
      });
    },
  );
  testContextValue.mocks.api(
    userPermissionGrantsContract.list,
    ({ respond }) => {
      return respond(200, []);
    },
  );
  testContextValue.mocks.api(
    userBuiltinConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: [...(builtInByAgent.get(params.id) ?? [])],
      });
    },
  );
  testContextValue.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ body, params, respond }) => {
      const next = applyStringOperation(
        builtInByAgent.get(params.id) ?? [],
        body.enabledConnectorSlugs,
        body.operation,
      );
      builtInByAgent.set(params.id, next);
      return respond(200, { enabledConnectorSlugs: next });
    },
  );
  testContextValue.mocks.api(
    agentCustomConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        grants: [...(customByAgent.get(params.id) ?? [])],
      });
    },
  );
  testContextValue.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, params, respond }) => {
      options.onCustomSave?.({
        agentId: params.id,
        grants: body.grants,
        operation: body.operation,
      });
      const next = applyGrantOperation(
        customByAgent.get(params.id) ?? [],
        body.grants,
        body.operation,
      );
      customByAgent.set(params.id, next);
      return respond(200, { grants: next });
    },
  );
}

function exactButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function connectorAccessSwitch(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

function linkContaining(name: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.includes(name) ?? false;
  });
  if (!link) {
    throw new Error(`Link not found: ${name}`);
  }
  return link;
}

async function navigateToAgent(name: string): Promise<void> {
  click(linkContaining("Agents"));
  await screen.findByText(name);
  click(linkContaining(name));
  await screen.findByRole("heading", { name });
}

async function openAgentConnectorIsolationStory() {
  const customSaves: string[] = [];
  mockConnectorSurface(context, {
    catalog: [catalogConnectorFixture("github", "GitHub")],
    customConnectors: [
      acmeConnectorFixture({
        permissionBundleRef: "builtin:acme-search@1",
      }),
    ],
    onCustomSave: ({ agentId }) => {
      customSaves.push(agentId);
    },
  });
  context.mocks.api(customConnectorByIdContract.permissions, ({ respond }) => {
    return respond(200, {
      ref: "builtin:acme-search@1",
      permissions: [{ name: "search:run", description: "Run a search" }],
      defaultPolicies: { "search:run": "deny" },
    });
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
    agents: [
      agentFixture(RESEARCH_AGENT_ID, "Research Agent"),
      agentFixture(SUPPORT_AGENT_ID, "Support Agent"),
    ],
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  return { customSaves };
}

test("Cancelled custom connector permission edits do not appear on another agent", async () => {
  const { customSaves } = await openAgentConnectorIsolationStory();
  await screen.findByText("Acme Search");
  click(connectorAccessSwitch("Grant Acme Search access"));
  await screen.findByRole("heading", { name: /Acme Search permissions/i });
  const permissionName = await screen.findByText("search:run");
  const permissionRow = permissionName.closest("div.flex.items-center.gap-3");
  expect(permissionRow).not.toBeNull();
  click(within(permissionRow as HTMLElement).getByText("Allow"));
  click(exactButton("Cancel"));
  await waitFor(() => {
    expect(
      screen.queryByRole("heading", { name: /Acme Search permissions/i }),
    ).not.toBeInTheDocument();
  });

  await navigateToAgent("Support Agent");
  await screen.findByText("Acme Search");
  expect(
    screen.queryByRole("heading", { name: /Acme Search permissions/i }),
  ).not.toBeInTheDocument();
  expect(connectorAccessSwitch("Grant Acme Search access")).toBeVisible();
  expect(customSaves).toStrictEqual([]);
});

test("An agent with no connected services guides the user to Connectors", async () => {
  mockConnectorSurface(context);
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  const guidance = await screen.findByText(/No connected services yet/i);
  expect(guidance).toBeVisible();
  const connectorLink = linkContaining("Connectors");
  expect(connectorLink).toHaveAttribute("href", "/connectors");
});

test("A user can authorize a connected MCP custom connector for an agent", async () => {
  mockConnectorSurface(context, {
    customConnectors: [deepWikiConnectorFixture()],
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  await screen.findByText("DeepWiki");
  expect(screen.getByText("https://mcp.deepwiki.com/mcp")).toBeVisible();
  expect(connectorAccessSwitch("Grant DeepWiki access")).toBeVisible();
  expect(
    screen.queryByLabelText("Manage DeepWiki permissions"),
  ).not.toBeInTheDocument();

  click(connectorAccessSwitch("Grant DeepWiki access"));
  await screen.findByText("Custom connectors saved");
  expect(connectorAccessSwitch("Revoke DeepWiki access")).toBeInTheDocument();
});

test("Connector permission management appears only when permissions exist", async () => {
  mockConnectorSurface(context, {
    catalog: [
      catalogConnectorFixture("axiom", "Axiom", {
        externalUsername: "workspace",
        hasPermissions: false,
        permissionCount: 0,
      }),
    ],
    customConnectors: [acmeConnectorFixture()],
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  await screen.findByText("Axiom");
  expect(screen.getByText("Acme Search")).toBeVisible();
  expect(
    screen.queryByLabelText("Manage Axiom permissions"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Manage Acme Search permissions"),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.includes("Manage permissions") ?? false;
    }),
  ).toHaveLength(0);
});

test("An unconfigured custom connector is not offered to an agent", async () => {
  mockConnectorSurface(context, {
    catalog: [
      catalogConnectorFixture("axiom", "Axiom", {
        externalUsername: "workspace",
      }),
    ],
    customConnectors: [acmeConnectorFixture({ account: undefined })],
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  await expect(screen.findByText("Axiom")).resolves.toBeVisible();
  expect(screen.queryByText("Acme Search")).not.toBeInTheDocument();
});

test("An agent can grant access through a healthy configured default", async () => {
  const connector = acmeConnectorFixture();
  const saves: unknown[] = [];
  mockConnectorSurface(context, {
    customConnectors: [connector],
    onCustomSave: (args) => {
      saves.push(args);
    },
  });
  await setupTeamPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
  await screen.findByText("Acme Search");
  const grant = connectorAccessSwitch("Grant Acme Search access");
  expect(grant).not.toHaveAttribute("aria-disabled", "true");
  click(grant);
  await screen.findByText("Custom connectors saved");
  expect(saves).toStrictEqual([
    {
      agentId: RESEARCH_AGENT_ID,
      grants: [{ customConnectorId: connector.id, permissionNames: [] }],
      operation: "add",
    },
  ]);
});

test.each([
  "connected",
  "reconnect-required",
  "configuration_incomplete",
] as const)(
  "Check a canonical custom default only when granting access (%s)",
  async (status) => {
    const connector = acmeConnectorFixture();
    const saves: unknown[] = [];
    mockConnectorSurface(context, {
      customConnectors: [connector],
      onCustomSave: (args) => {
        saves.push(args);
      },
    });
    const definition = connector;
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [definition] });
    });
    let accountReads = 0;
    context.mocks.api(
      connectorAccountsContract.connections,
      ({ query, respond }) => {
        accountReads += 1;
        expect(query).toMatchObject({
          kind: "custom",
          customConnectorId: connector.id,
        });
        const account = customConnectorAccount(connector.id, {
          connectionStatus:
            status === "connected" ? status : "reconnect-required",
          reconnectReason:
            status === "configuration_incomplete" ? status : null,
          missingRequiredFields:
            status === "configuration_incomplete" ? ["secret"] : [],
        });
        return respond(200, {
          connections: [account],
          defaultConnection: account,
          nextCursor: null,
        });
      },
    );
    await setupTeamPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
    await screen.findByText("Acme Search");
    expect(screen.queryByText(/Reconnect required/)).toBeNull();
    expect(accountReads).toBe(0);
    const grant = connectorAccessSwitch("Grant Acme Search access");
    expect(grant).not.toHaveAttribute("aria-disabled", "true");
    click(grant);
    await screen.findByText(
      status === "connected"
        ? "Custom connectors saved"
        : /fully configured default account/,
    );
    expect(saves).toHaveLength(status === "connected" ? 1 : 0);
    expect(screen.queryAllByRole("alert")).toHaveLength(
      status === "connected" ? 0 : 1,
    );
    expect(accountReads).toBe(1);
  },
);

test.each(["reduce", "expand"] as const)(
  "An expired custom default permits reductions but checks access expansion (%s)",
  async (change) => {
    const connector = acmeConnectorFixture({
      permissionBundleRef: "builtin:acme-search@1",
      account: undefined,
    });
    const saves: unknown[] = [];
    mockConnectorSurface(context, {
      customConnectors: [connector],
      connectedCustomConnectorIds: [connector.id],
      initialCustomByAgent: {
        [RESEARCH_AGENT_ID]: [
          {
            customConnectorId: connector.id,
            permissionNames:
              change === "reduce"
                ? ["search:run", "report:read"]
                : ["report:read"],
          },
        ],
      },
      onCustomSave: (args) => {
        saves.push(args);
      },
    });
    let accountReads = 0;
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      accountReads += 1;
      const account = customConnectorAccount(connector.id, {
        connectionStatus: "reconnect-required",
      });
      return respond(200, {
        connections: [account],
        defaultConnection: account,
        nextCursor: null,
      });
    });
    context.mocks.api(
      customConnectorByIdContract.permissions,
      ({ respond }) => {
        return respond(200, {
          ref: "builtin:acme-search@1",
          permissions: [
            { name: "search:run", description: "Run a search" },
            { name: "report:read", description: "Read reports" },
          ],
          defaultPolicies: { "search:run": "deny", "report:read": "deny" },
        });
      },
    );
    await setupTeamPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
    await screen.findByText("Acme Search");
    click(await screen.findByLabelText("Manage Acme Search permissions"));
    await screen.findByRole("heading", { name: /Acme Search permissions/i });
    const permission = await screen.findByText("search:run");
    const row = permission.closest("div.flex.items-center.gap-3");
    expect(row).not.toBeNull();
    click(
      within(row as HTMLElement).getByText(
        change === "reduce" ? "Deny" : "Allow",
      ),
    );
    click(exactButton("Apply"));
    await screen.findByText(
      change === "reduce"
        ? "Permissions updated"
        : /fully configured default account/,
    );
    expect(saves).toStrictEqual(
      change === "reduce"
        ? [
            {
              agentId: RESEARCH_AGENT_ID,
              grants: [
                {
                  customConnectorId: connector.id,
                  permissionNames: ["report:read"],
                },
              ],
              operation: "add",
            },
          ]
        : [],
    );
    expect(accountReads).toBe(change === "reduce" ? 0 : 1);
    expect(
      screen.queryAllByRole("heading", { name: /Acme Search permissions/i }),
    ).toHaveLength(change === "reduce" ? 0 : 1);
  },
);

test("An unavailable custom default keeps its existing agent grant revocable", async () => {
  const connector = acmeConnectorFixture({ account: undefined });
  const saves: unknown[] = [];
  mockConnectorSurface(context, {
    customConnectors: [connector],
    connectedCustomConnectorIds: [connector.id],
    initialCustomByAgent: {
      [RESEARCH_AGENT_ID]: [
        { customConnectorId: connector.id, permissionNames: [] },
      ],
    },
    onCustomSave: (args) => {
      saves.push(args);
    },
  });
  await setupTeamPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
  await screen.findByText("Acme Search");
  const revoke = connectorAccessSwitch("Revoke Acme Search access");
  expect(revoke).not.toHaveAttribute("aria-disabled", "true");
  click(revoke);
  await screen.findByText("Custom connectors saved");
  expect(saves).toStrictEqual([
    {
      agentId: RESEARCH_AGENT_ID,
      grants: [{ customConnectorId: connector.id, permissionNames: [] }],
      operation: "remove",
    },
  ]);
  expect(connectorAccessSwitch("Grant Acme Search access")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("Saved builtin and unavailable custom connectors stay visible without account list reads", async () => {
  const connector = acmeConnectorFixture({ account: undefined });
  mockConnectorSurface(context, {
    catalog: [catalogConnectorFixture("github", "GitHub")],
    customConnectors: [connector],
    connectedCustomConnectorIds: [connector.id],
  });
  const accountReads: string[] = [];
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    accountReads.push("connections");
    return respond(200, {
      connections: [],
      nextCursor: null,
      defaultConnection: null,
    });
  });
  await setupTeamPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
  await screen.findByText("GitHub");
  await screen.findByText("Acme Search");
  expect(connectorAccessSwitch("Grant Acme Search access")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.queryByText(/No connected services yet/i)).toBeNull();
  expect(accountReads).toStrictEqual([]);
});

test.each(["Feishu", "Lark"])(
  "Managed %s keeps its integration-owned access lifecycle",
  async (name) => {
    const connector = acmeConnectorFixture({
      displayName: name,
      authMode: "oauth",
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: [],
      connectedAccountId: undefined,
      connectedAccountUpdatedAt: undefined,
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
    mockConnectorSurface(context, {
      customConnectors: [connector],
    });
    await setupTeamPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
    await screen.findByText(name);
    expect(connectorAccessSwitch(`Grant ${name} access`)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByText("No accounts")).toBeNull();
    expect(screen.queryByText(/No connected services yet/i)).toBeNull();
  },
);
