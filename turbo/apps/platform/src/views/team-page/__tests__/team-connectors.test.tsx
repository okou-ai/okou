import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  customConnectorsContract,
  customConnectorByIdContract,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
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
  setupTeamPage,
} from "./team-page-test-helpers.ts";

const context = testContext();

interface ConnectorSurfaceOptions {
  readonly catalog?: readonly PublicConnectorCatalogStatusItem[];
  readonly customConnectors?: readonly CustomConnectorResponse[];
  readonly initialBuiltInByAgent?: Readonly<Record<string, readonly string[]>>;
  readonly initialCustomByAgent?: Readonly<
    Record<string, readonly AgentCustomConnectorGrant[]>
  >;
  readonly failBuiltInSaveForAgentId?: string;
  readonly failPermissionGrants?: boolean;
  readonly onBuiltInSave?: (args: {
    readonly agentId: string;
    readonly connectorSlugs: readonly string[];
    readonly operation: "add" | "remove" | "replace" | undefined;
  }) => void | Promise<void>;
  readonly onCustomSave?: (args: {
    readonly agentId: string;
    readonly grants: readonly AgentCustomConnectorGrant[];
    readonly operation: "add" | "remove" | "replace" | undefined;
  }) => void;
  readonly onCustomRead?: () => void | Promise<void>;
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

  testContextValue.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...(options.catalog ?? [])] });
  });
  testContextValue.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [...(options.customConnectors ?? [])],
    });
  });
  testContextValue.mocks.api(
    userPermissionGrantsContract.list,
    ({ respond }) => {
      return options.failPermissionGrants
        ? respond(403, {
            error: {
              code: "FORBIDDEN",
              message: "Permission grants are unavailable",
            },
          })
        : respond(200, []);
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
    async ({ body, params, respond }) => {
      await options.onBuiltInSave?.({
        agentId: params.id,
        connectorSlugs: body.enabledConnectorSlugs,
        operation: body.operation,
      });
      if (params.id === options.failBuiltInSaveForAgentId) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Connector save failed" },
        });
      }
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
    async ({ params, respond }) => {
      await options.onCustomRead?.();
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
    failBuiltInSaveForAgentId: RESEARCH_AGENT_ID,
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

test("Browser navigation discards an unfinished custom connector permission draft", async () => {
  const { customSaves } = await openAgentConnectorIsolationStory();
  click(linkContaining("Agents"));
  await screen.findByRole("heading", { name: "Agents" });
  click(linkContaining("Research Agent"));
  await screen.findByRole("heading", { name: "Research Agent" });
  await screen.findByText("Acme Search");
  click(connectorAccessSwitch("Grant Acme Search access"));
  await screen.findByText("search:run");
  click(exactButton("Allow"));
  expect(exactButton("Allow")).toHaveAttribute("aria-pressed", "true");

  window.history.back();
  await screen.findByRole("heading", { name: "Agents" });
  click(linkContaining("Research Agent"));
  await screen.findByRole("heading", { name: "Research Agent" });
  await screen.findByText("Acme Search");
  expect(
    screen.queryByRole("heading", { name: /Acme Search permissions/i }),
  ).not.toBeInTheDocument();

  click(connectorAccessSwitch("Grant Acme Search access"));
  await screen.findByText("search:run");
  expect(exactButton("Deny")).toHaveAttribute("aria-pressed", "true");
  expect(customSaves).toStrictEqual([]);
});

test("A failed built-in connector grant does not appear on another agent", async () => {
  await openAgentConnectorIsolationStory();
  await screen.findByText("GitHub");
  click(connectorAccessSwitch("Grant GitHub access"));
  await waitFor(() => {
    expect(connectorAccessSwitch("Grant GitHub access")).toBeVisible();
  });

  await navigateToAgent("Support Agent");
  await screen.findByText("GitHub");
  expect(connectorAccessSwitch("Grant GitHub access")).toBeVisible();
  expect(
    screen.queryByLabelText("Revoke GitHub access"),
  ).not.toBeInTheDocument();
});

test("Connector search preserves keyboard focus while access is saved", async () => {
  const user = userEvent.setup({ delay: null });
  const save = context.mocks.deferred<void>();
  mockConnectorSurface(context, {
    catalog: [
      catalogConnectorFixture("github", "GitHub", { hasPermissions: false }),
      catalogConnectorFixture("axiom", "Axiom", { hasPermissions: false }),
    ],
    onBuiltInSave: () => {
      return save.promise;
    },
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByText("GitHub");
  click(screen.getByLabelText("Find connectors"));
  const search = screen.getByPlaceholderText("Find connectors...");
  expect(search).toHaveFocus();

  await user.keyboard("{Tab}{Tab}");
  expect(connectorAccessSwitch("Grant GitHub access")).toHaveFocus();
  await user.keyboard(" ");
  await waitFor(() => {
    expect(connectorAccessSwitch("Revoke GitHub access")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(search).not.toHaveFocus();

  const nextConnector = connectorAccessSwitch("Grant Axiom access");
  nextConnector.focus();
  expect(nextConnector).toHaveFocus();
  save.resolve();
  await screen.findByText("Connectors saved");
  await waitFor(() => {
    expect(connectorAccessSwitch("Revoke GitHub access")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(nextConnector).toHaveFocus();

  click(screen.getByLabelText("Close search"));
  expect(
    screen.queryByPlaceholderText("Find connectors..."),
  ).not.toBeInTheDocument();
  click(screen.getByLabelText("Find connectors"));
  expect(screen.getByPlaceholderText("Find connectors...")).toHaveFocus();
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
  const refreshed = context.mocks.deferred<void>();
  const refreshStarted = context.mocks.deferred<void>();
  let saved = false;
  mockConnectorSurface(context, {
    customConnectors: [deepWikiConnectorFixture(), acmeConnectorFixture()],
    onCustomSave: () => {
      saved = true;
    },
    onCustomRead: async () => {
      if (saved) {
        refreshStarted.resolve();
        await refreshed.promise;
      }
    },
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
  await refreshStarted.promise;
  await waitFor(() => {
    expect(connectorAccessSwitch("Grant DeepWiki access")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(connectorAccessSwitch("Grant Acme Search access")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  refreshed.resolve();
  await waitFor(() => {
    expect(connectorAccessSwitch("Revoke DeepWiki access")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Custom connectors saved")).toBeVisible();
  });
});

test("An agent remains identifiable when permission grants cannot load", async () => {
  mockConnectorSurface(context, {
    catalog: [catalogConnectorFixture("axiom", "Axiom")],
    failPermissionGrants: true,
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  const heading = await screen.findByRole("heading", {
    name: "Research Agent",
  });
  const error = await screen.findByText("Failed to load permission grants");
  expect(heading).toBeVisible();
  expect(error).toBeVisible();
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
    customConnectors: [
      acmeConnectorFixture({
        connected: false,
        connectedAccountId: undefined,
        missingRequiredFields: ["apiKey"],
        configuredFieldKeys: [],
      }),
    ],
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  const account = await screen.findByText("@workspace");
  expect(account).toBeVisible();
  expect(screen.queryByText("Acme Search")).not.toBeInTheDocument();
});
