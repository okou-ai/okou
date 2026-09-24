import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorAction,
  listAgent,
  mockConnectors,
  mockPublicConnectorStatus,
  publicStatusItem,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const agentId = "c0000000-0000-4000-8000-000000000001";

test.each([false])(
  "A single SSH host shows its name unless it needs attention (failed: %s)",
  async (failed) => {
    mockCatalog();
    const connectionId = "b0000000-0000-4000-8000-000000000001";
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 1 });
    });
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, {
        connections: [
          {
            id: connectionId,
            displayName: "Deployment",
            host: "ssh.example.com",
            port: 22,
            username: "deploy",
            credentialId: "d0000000-0000-4000-8000-000000000001",
            credentialName: "Deployment login",
            generation: 1,
            learnedHostKey: null,
            createdAt: "2026-09-10T08:00:00.000Z",
            updatedAt: "2026-09-10T08:00:00.000Z",
          },
        ],
      });
    });
    context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
      return respond(200, {
        observations: [
          {
            connectionId,
            generation: 1,
            observedAt: "2026-09-10T08:00:00.000Z",
            failureReason: failed ? "authentication_failed" : null,
          },
        ],
      });
    });
    await page("/connectors?keywords=ssh");
    const label = failed ? "1/1 need attention" : "Deployment";
    await screen.findByText(label);
    expect(screen.queryByText("1 host configured")).toBeNull();
    expect(screen.getByText("Add access")).toBeInTheDocument();
    expect(getConnectorAction("link", "Manage SSH hosts")).toHaveAttribute(
      "href",
      "/connectors?scope=remote-control&type=ssh",
    );
  },
);

test("The SSH directory summarizes attention like Connectors and recovers without changing Agent access", async () => {
  mockCatalog();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 3 });
  });
  let failed = true;
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, {
      observations: [
        {
          connectionId: "b0000000-0000-4000-8000-000000000001",
          generation: 1,
          observedAt: "2026-09-10T08:00:00.000Z",
          failureReason: failed ? "authentication_failed" : null,
        },
        {
          connectionId: "b0000000-0000-4000-8000-000000000002",
          generation: 1,
          observedAt: "2026-09-10T08:00:00.000Z",
          failureReason: failed ? "network_failure" : null,
        },
        {
          connectionId: "b0000000-0000-4000-8000-000000000003",
          generation: 1,
          observedAt: "2026-09-10T08:00:00.000Z",
          failureReason: null,
        },
      ],
    });
  });
  const orgId = "org_ssh_card";
  await setupPage({
    context,
    path: "/connectors?keywords=ssh",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: orgId, name: "SSH test organization" },
        memberships: [{ id: orgId }],
      },
    },
  });
  await screen.findByText("2/3 need attention");
  expect(screen.queryByText("3 hosts configured")).toBeNull();
  expect(screen.getByText("Add access")).toBeInTheDocument();
  expect(getConnectorAction("link", "Manage SSH hosts")).toHaveAttribute(
    "href",
    "/connectors?scope=remote-control&type=ssh",
  );
  failed = false;
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText("3 hosts configured");
  expect(screen.queryByText("2/3 need attention")).toBeNull();
  expect(screen.getByText("Add access")).toBeInTheDocument();
});

test("The SSH directory distinguishes unavailable diagnostics from failed hosts", async () => {
  mockCatalog();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2 });
  });
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "private error" },
    });
  });
  await page("/connectors?keywords=ssh");
  await screen.findByText("SSH connection status is unavailable");
  expect(screen.queryByText(/need attention/u)).toBeNull();
  expect(screen.queryByText("private error")).toBeNull();
  expect(getConnectorAction("link", "Manage SSH hosts")).toHaveAttribute(
    "href",
    "/connectors?scope=remote-control&type=ssh",
  );
  expect(screen.getByText("Add access")).toBeInTheDocument();
});

test.each([2])(
  "SSH with %i hosts is in Remote control instead of the catalog",
  async (configuredCount) => {
    mockCatalog();
    mockPublicConnectorStatus(
      context,
      Array.from({ length: 8 }, (_, index) => {
        return publicStatusItem({
          connectorSlug: connectorSlugSchema.parse(`mail-${index}`),
          label: `Mail ${index}`,
          category: "communication-collaboration",
          popularityRank: index,
          connected: false,
        });
      }),
      // Discovery always names the catalog's categories, and the filter is
      // built from that list rather than from the connectors that came back.
      {
        categories: [
          {
            id: "communication-collaboration",
            label: "Communication and Collaboration",
            menuLabel: "Communication",
            groupId: null,
          },
        ],
        groups: [],
      },
    );
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount });
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [customConnector()] });
    });
    await setupPage({
      context,
      path: "/connectors",
      featureSwitches: {
        [FeatureSwitchKey.ConnectorDirectory]: true,
      },
    });
    await screen.findByTestId("connector-shelf-communication-collaboration");
    expect(screen.queryByRole("heading", { name: "Remote access" })).toBeNull();
    expect(screen.queryByText("Acme Search")).toBeNull();
    expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
    click(getConnectorAction("button", "Filter connectors"));
    const menu = await screen.findByRole("menu");
    const communication = queryAllByRoleFast("menuitem", menu).find((item) => {
      return item.textContent?.startsWith("Communication");
    });
    if (!communication) {
      throw new Error("Expected the Communication category option");
    }
    click(communication);
    // Inside a category the page renders that category's connectors alone --
    // the breadcrumb and the filter already name it, so the grouped headings
    // are gone.
    await screen.findByTestId("connector-category-grid");
    expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
    click(screen.getByTestId("connectors-scope-remote-control"));
    await waitFor(() => {
      return getConnectorAction("button", "Add host");
    });
    expect(
      screen.getByTestId("connectors-scope-remote-control"),
    ).toHaveTextContent(
      configuredCount === 0 ? "Remote control" : "Remote control2",
    );
    click(screen.getByTestId("connectors-scope-discover"));
    await screen.findByTestId("connector-shelf-communication-collaboration");
    expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
  },
);

test("The global card manages visible Agent grants with Connector presentation and search", async () => {
  mockCatalog();
  const otherId = "c0000000-0000-4000-8000-000000000002";
  context.mocks.data.agents([
    listAgent(agentId, "Research"),
    { ...listAgent(otherId, "Shared"), ownerId: "another-owner" },
  ]);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2 });
  });
  const grants = new Set<string>();
  context.mocks.api(agentSshAccessContract.get, ({ params, respond }) => {
    return respond(200, { enabled: grants.has(params.agentId) });
  });
  context.mocks.api(
    agentSshAccessContract.update,
    ({ params, body, respond }) => {
      if (body.enabled) {
        grants.add(params.agentId);
      } else {
        grants.delete(params.agentId);
      }
      return respond(200, { enabled: body.enabled });
    },
  );
  await page("/connectors?keywords=ssh");
  await screen.findByText("Add access");
  click(screen.getByTestId("connector-card-agent-access"));
  const dialog = await screen.findByRole("dialog");
  click(
    await within(dialog).findByRole("switch", {
      name: "Authorize SSH access for Research",
    }),
  );
  await within(dialog).findByRole("switch", {
    name: "Revoke SSH access for Research",
  });
  expect(screen.getByTestId("connector-card-access-names")).toHaveTextContent(
    "Research",
  );
  click(
    within(dialog).getByRole("switch", {
      name: "Authorize SSH access for Shared",
    }),
  );
  await within(dialog).findByRole("switch", {
    name: "Revoke SSH access for Shared",
  });
  expect(screen.getByTestId("connector-card-access-names")).toHaveTextContent(
    "2 agents",
  );
  await fill(within(dialog).getByRole("textbox"), "shared");
  expect(within(dialog).queryByText("Research")).toBeNull();
  click(
    within(dialog).getByRole("switch", {
      name: "Revoke SSH access for Shared",
    }),
  );
  await within(dialog).findByRole("switch", {
    name: "Authorize SSH access for Shared",
  });
  expect(screen.getByTestId("connector-card-access-names")).toHaveTextContent(
    "Research",
  );
});

function mockCatalog() {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: false });
  });
}

async function page(path = "/connectors") {
  await setupPage({
    context,
    path,
  });
}

test("Legacy tabs remain usable after opening SSH management", async () => {
  mockCatalog();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  await page();
  click(
    await waitFor(() => {
      return getConnectorAction("link", "Manage SSH hosts");
    }),
  );
  await screen.findByText("0 hosts configured");
  click(getConnectorAction("tab", "Custom"));
  await waitFor(() => {
    expect(window.location.search).toBe("?tab=custom");
    expect(screen.queryByText("0 hosts configured")).toBeNull();
  });
});

test.each([0])(
  "Global SSH entry shows %i configured hosts and opens management without an Agent",
  async (count) => {
    mockCatalog();
    context.mocks.data.agents([]);
    context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
      return respond(200, { credentials: [] });
    });
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: count });
    });
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    await page();
    const label =
      count === 0
        ? "Let your agents run commands on remote machines."
        : `${count} ${count === 1 ? "host" : "hosts"} configured`;
    await screen.findByText(label);
    const entry = getConnectorAction("link", "Manage SSH hosts");
    expect(entry).toHaveAttribute(
      "href",
      "/connectors?scope=remote-control&type=ssh",
    );
    expect(
      screen.getByRole("heading", { name: "Remote access" }),
    ).toBeInTheDocument();
    const card = screen.getByTestId("connector-category-remote-access");
    expect(
      within(card).queryByText(
        "Let your agents run commands on remote machines.",
      ) !== null,
    ).toBe(count === 0);
    expect(
      within(card).queryByText("0 hosts configured"),
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByText(/connected|tested/iu),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("connector-category-remote-access"),
    ).toContainElement(entry);
    expect(
      screen.getByText("Connect 2 services for your agents to use."),
    ).toBeInTheDocument();
    click(entry);
    await screen.findByRole("heading", { name: "SSH" });
    expect(window.location.search).toBe("?scope=remote-control&type=ssh");
    click(getConnectorAction("button", "Add host"));
    const dialog = await screen.findByRole("dialog");
    const key = await within(dialog).findByLabelText("Private key");
    expect(key).toHaveValue("");
    expect(within(dialog).queryByText("OAuth")).not.toBeInTheDocument();
  },
);

test("SSH participates in search and configured filters without changing generic connector actions", async () => {
  mockCatalog();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2 });
  });
  await page();
  await screen.findByText("2 hosts configured");
  const search = screen.getByPlaceholderText("Find connectors");
  await fill(search, "SSH");
  await expect(
    screen.findByText("2 hosts configured"),
  ).resolves.toBeInTheDocument();
  click(getConnectorAction("button", "Filter connectors"));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Not connected");
    }),
  );
  await screen.findByText(/No connectors left to connect/);
  expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
  click(getConnectorAction("button", "Filter connectors"));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Connected");
    }),
  );
  await screen.findByText("2 hosts configured");
  await fill(search, "unrelated-provider");
  await screen.findByText(/No connected connectors/);
  expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
});

test.each([
  [false, false],
  [true, true],
] as const)(
  "The unshared filter uses visible SSH grants (directory: %s, enabled: %s)",
  async (directory, enabled) => {
    mockCatalog();
    context.mocks.data.agents([listAgent(agentId, "Research")]);
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 1 });
    });
    context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
      return respond(200, { enabled });
    });
    await setupPage({
      context,
      path: "/connectors?scope=connected&connection=unshared&keywords=ssh",
      featureSwitches: {
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    if (directory) {
      await screen.findByText(/Every connector is shared with an agent/u);
    } else if (enabled) {
      await screen.findByText('No connectors matching "ssh"');
    } else {
      await screen.findByText("1 host configured");
    }
    expect(queryConnectorAction("link", "Manage SSH hosts") !== null).toBe(
      !directory && !enabled,
    );
  },
);

test("SSH access remains manageable in Remote control", async () => {
  mockCatalog();
  context.mocks.data.agents([listAgent(agentId, "Research")]);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  let enabled = false;
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled });
  });
  context.mocks.api(agentSshAccessContract.update, ({ body, respond }) => {
    enabled = body.enabled;
    return respond(200, { enabled });
  });
  await setupPage({
    context,
    path: "/connectors?scope=remote-control",
    featureSwitches: {
      [FeatureSwitchKey.ConnectorDirectory]: true,
    },
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage SSH access");
    }),
  );
  const dialog = await screen.findByRole("dialog");
  click(
    await within(dialog).findByRole("switch", {
      name: "Authorize SSH access for Research",
    }),
  );
  await within(dialog).findByRole("switch", {
    name: "Revoke SSH access for Research",
  });
  click(getConnectorAction("button", "Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(screen.getByTestId("connectors-scope-connected"));
  expect(queryConnectorAction("link", "Manage SSH hosts")).toBeNull();
  click(screen.getByTestId("connectors-scope-remote-control"));
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage SSH access");
    }),
  );
  await within(await screen.findByRole("dialog")).findByRole("switch", {
    name: "Revoke SSH access for Research",
  });
});

test.each([true])(
  "Agent filter uses its standalone SSH grant (%s), including no hosts",
  async (enabled) => {
    mockCatalog();
    context.mocks.data.agents([listAgent(agentId, "Research")]);
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 0 });
    });
    context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
      return respond(200, { enabled });
    });
    await page(`/connectors?keywords=ssh&connection=agent:${agentId}`);
    await screen.findByText(
      enabled
        ? "Let your agents run commands on remote machines."
        : /No connectors for this agent/,
    );
    expect(queryConnectorAction("link", "Manage SSH hosts") !== null).toBe(
      enabled,
    );
  },
);

test("A shared Agent filter uses the current user's SSH grant", async () => {
  mockCatalog();
  context.mocks.data.agents([
    { ...listAgent(agentId, "Shared"), ownerId: "another-owner" },
  ]);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: true });
  });
  await page(`/connectors?keywords=ssh&connection=agent:${agentId}`);
  await screen.findByText("2 hosts configured");
  expect(queryConnectorAction("link", "Manage SSH hosts")).not.toBeNull();
});

test("Deleting an SSH host referenced by VNC explains how to resolve the dependency", async () => {
  mockCatalog();
  const host = {
    id: "b0000000-0000-4000-8000-000000000001",
    displayName: "VNC gateway",
    host: "gateway.example.com",
    port: 22,
    username: "deploy",
    credentialId: "d0000000-0000-4000-8000-000000000001",
    credentialName: "Gateway login",
    generation: 1,
    learnedHostKey: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [host] });
  });
  context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
    return respond(409, {
      error: {
        code: "SSH_CONNECTION_IN_USE",
        message: "private dependency detail",
      },
    });
  });
  await page("/connectors?scope=remote-control&type=ssh");
  await screen.findByText(host.displayName);
  click(getConnectorAction("button", "Delete host"));
  const dialog = await screen.findByRole("dialog", { name: "Delete host" });
  click(getConnectorAction("button", "Delete host", dialog));
  await within(dialog).findByText(/This SSH host is used by a VNC route/u);
  expect(
    within(dialog).getByText(/switch them explicitly to Direct/u),
  ).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("private dependency detail");
  expect(dialog).toBeInTheDocument();
});
