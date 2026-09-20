import { agentVncAccessContract } from "@okouai/api-contracts/contracts/vnc-access";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  installComposerConnectorFixture,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  listAgent,
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";

const agentId = "c0000000-0000-4000-8000-000000000001";

function mockCatalog() {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
}

test.each([true, false])(
  "The unshared filter excludes VNC when an Agent has access (%s)",
  async (enabled) => {
    mockCatalog();
    context.mocks.data.agents([listAgent(agentId, "Research")]);
    context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 1 });
    });
    context.mocks.api(agentVncAccessContract.get, ({ respond }) => {
      return respond(200, { enabled });
    });
    await setupPage({
      context,
      path: "/connectors?scope=connected&connection=unshared&keywords=vnc",
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: true,
      },
    });
    if (enabled) {
      await screen.findByText(/Every connector is shared with an agent/u);
    } else {
      await findFastControl("link", "Manage VNC");
    }
    expect(
      queryFastControl("link", "Manage VNC")?.getAttribute("href") ?? null,
    ).toBe(enabled ? null : "/connectors/vnc");
  },
);

test("An unavailable grant cannot classify VNC as unshared and can be retried", async () => {
  mockCatalog();
  context.mocks.data.agents([listAgent(agentId, "Research")]);
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  let failed = true;
  const recovery = context.mocks.deferred<void>();
  context.mocks.api(agentVncAccessContract.get, async ({ respond }) => {
    if (failed) {
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "private grant error" },
      });
    }
    await recovery.promise;
    return respond(200, { enabled: false });
  });
  await setupPage({
    context,
    path: "/connectors?scope=connected&connection=unshared&keywords=vnc",
    featureSwitches: {
      [FeatureSwitchKey.VncAccess]: true,
      [FeatureSwitchKey.ConnectorDirectory]: true,
    },
  });
  await screen.findByText("Could not load VNC configuration.");
  expect(queryFastControl("link", "Manage VNC")).toBeNull();
  expect(
    screen.queryByText(/Every connector is shared with an agent/u),
  ).toBeNull();
  expect(document.body.textContent).not.toContain("private grant error");
  failed = false;
  click(await findFastControl("button", "Retry"));
  await expect(
    screen.findByText("Loading VNC configuration…"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText(/Every connector is shared with an agent/u),
  ).toBeNull();
  recovery.resolve();
  await expect(
    findFastControl("link", "Manage VNC"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Could not load VNC configuration.")).toBeNull();
});

test("VNC access can retry a failed Agent inventory", async () => {
  mockCatalog();
  let failed = true;
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return failed
      ? respond(500, {
          error: {
            code: "INTERNAL_ERROR",
            message: "Agent inventory unavailable",
          },
        })
      : respond(200, [listAgent(agentId, "Research")]);
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentVncAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: false });
  });
  await setupPage({
    context,
    path: "/connectors?keywords=vnc",
    featureSwitches: {
      [FeatureSwitchKey.VncAccess]: true,
      [FeatureSwitchKey.ConnectorDirectory]: true,
    },
  });
  const error = await screen.findByText("Could not load VNC configuration.");
  const alert = error.closest('[role="alert"]');
  if (!(alert instanceof HTMLElement)) {
    throw new Error("Missing VNC error alert");
  }
  failed = false;
  click(await findFastControl("button", "Retry", alert));
  await waitFor(() => {
    expect(queryFastControl("button", "Manage VNC access")).toBeEnabled();
  });
  expect(screen.queryByText("Could not load VNC configuration.")).toBeNull();
});

test.each([true, false])(
  "Agent discovery filter uses its independent VNC grant (%s)",
  async (enabled) => {
    mockCatalog();
    context.mocks.data.agents([listAgent(agentId, "Research")]);
    context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 0 });
    });
    context.mocks.api(agentVncAccessContract.get, ({ respond }) => {
      return respond(200, { enabled });
    });
    await setupPage({
      context,
      path: `/connectors?keywords=vnc&connection=agent:${agentId}`,
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: false,
      },
    });
    if (enabled) {
      await findFastControl("link", "Manage VNC");
    } else {
      await screen.findByText(/No connectors for this agent/u);
    }
    expect(
      queryFastControl("link", "Manage VNC")?.getAttribute("href") ?? null,
    ).toBe(enabled ? "/connectors/vnc?add=1" : null);
  },
);

test.each([false, true])(
  "VNC discovery is independent of the directory layout (%s)",
  async (directory) => {
    mockCatalog();
    context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 0 });
    });
    await setupPage({
      context,
      path: "/connectors?keywords=vnc",
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    const link = await findFastControl("link", "Manage VNC");
    expect(link).toHaveAttribute("href", "/connectors/vnc?add=1");
    expect(queryFastControl("link", "Manage SSH hosts")).toBeNull();
    await screen.findByRole("heading", { name: "Remote access" });
  },
);

test.each([
  { count: 1, label: "1 host configured" },
  { count: 2, label: "2 hosts configured" },
])(
  "VNC uses the SSH host-count wording for $count hosts",
  async ({ count, label }) => {
    mockCatalog();
    context.mocks.data.agents([]);
    context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: count });
    });
    await setupPage({
      context,
      path: "/connectors?keywords=vnc",
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: false,
      },
    });
    await expect(screen.findByText(label)).resolves.toBeInTheDocument();
  },
);

test.each([false, true])(
  "VNC discovery does not report an empty result while a failed summary retries (%s)",
  async (directory) => {
    mockCatalog();
    let failed = true;
    const retryStarted = context.mocks.deferred<void>();
    const recovery = context.mocks.deferred<void>();
    context.mocks.api(vncConnectionsContract.summary, async ({ respond }) => {
      if (failed) {
        return respond(500, {
          error: { code: "INTERNAL_ERROR", message: "private VNC error" },
        });
      }
      retryStarted.resolve();
      await recovery.promise;
      return respond(200, { configuredCount: 0 });
    });
    await setupPage({
      context,
      path: "/connectors?keywords=vnc",
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    const error = await screen.findByText("Could not load VNC configuration.");
    const alert = error.closest('[role="alert"]');
    if (!(alert instanceof HTMLElement)) {
      throw new Error("Missing VNC error alert");
    }
    expect(screen.queryByText(/No connectors matching/u)).toBeNull();
    failed = false;
    click(await findFastControl("button", "Retry", alert));
    await retryStarted.promise;
    await expect(
      screen.findByText("Loading VNC configuration…"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText(/No connectors matching/u)).toBeNull();
    recovery.resolve();
    await expect(
      findFastControl("link", "Manage VNC"),
    ).resolves.toHaveAttribute("href", "/connectors/vnc?add=1");
  },
);

test.each([false, true])(
  "Feature-off VNC makes no discovery calls in directory layout %s",
  async (directory) => {
    mockCatalog();
    context.mocks.api(vncConnectionsContract.summary, () => {
      throw new Error("Feature-off VNC must not dispatch owner requests");
    });
    await setupPage({
      context,
      path: "/connectors",
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: false,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    await findFastControl("link", "Manage SSH hosts");
    expect(queryFastControl("link", "Manage VNC")).toBeNull();
  },
);

test("VNC settings grants authorize a visible Agent independently of SSH", async () => {
  mockCatalog();
  context.mocks.data.agents([listAgent(agentId, "Research")]);
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  let enabled = false;
  context.mocks.api(agentVncAccessContract.get, ({ respond }) => {
    return respond(200, { enabled });
  });
  context.mocks.api(
    agentVncAccessContract.update,
    ({ body, params, respond }) => {
      expect(params.agentId).toBe(agentId);
      enabled = body.enabled;
      return respond(200, { enabled });
    },
  );
  context.mocks.api(agentSshAccessContract.update, () => {
    throw new Error("VNC authorization must not alter SSH access");
  });
  await setupPage({
    context,
    path: "/connectors?keywords=vnc",
    featureSwitches: { [FeatureSwitchKey.VncAccess]: true },
  });
  click(await findFastControl("button", "Manage VNC access"));
  const dialog = await screen.findByRole("dialog");
  click(
    await within(dialog).findByRole("switch", {
      name: "Authorize VNC access for Research",
    }),
  );
  await expect(
    within(dialog).findByRole("switch", {
      name: "Revoke VNC access for Research",
    }),
  ).resolves.toBeChecked();
  click(
    within(dialog).getByRole("switch", {
      name: "Revoke VNC access for Research",
    }),
  );
  await expect(
    within(dialog).findByRole("switch", {
      name: "Authorize VNC access for Research",
    }),
  ).resolves.not.toBeChecked();
});

test("Agent authorization does not report no services while VNC recovery is pending", async () => {
  mockCatalog();
  const agent = listAgent(agentId, "Research");
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  let failed = true;
  const retryStarted = context.mocks.deferred<void>();
  const recovery = context.mocks.deferred<void>();
  context.mocks.api(vncConnectionsContract.summary, async ({ respond }) => {
    if (failed) {
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "private VNC error" },
      });
    }
    retryStarted.resolve();
    await recovery.promise;
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentVncAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: false });
  });
  await setupPage({
    context,
    path: `/agents/${agentId}?tab=authorization`,
    featureSwitches: { [FeatureSwitchKey.VncAccess]: true },
  });
  const error = await screen.findByText("Could not load VNC configuration.");
  const alert = error.closest('[role="alert"]');
  if (!(alert instanceof HTMLElement)) {
    throw new Error("Missing VNC error alert");
  }
  failed = false;
  click(await findFastControl("button", "Retry", alert));
  await retryStarted.promise;
  expect(screen.queryByText(/No connected services yet/u)).toBeNull();
  recovery.resolve();
  await expect(
    screen.findByRole("switch", { name: "Grant VNC access" }),
  ).resolves.not.toBeChecked();
});

test("Agent authorization hides retained VNC grants when the owner changes", async () => {
  const agent = listAgent(agentId, "Research");
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  const nextOwner = context.mocks.deferred<void>();
  let changing = false;
  context.mocks.api(vncConnectionsContract.summary, async ({ respond }) => {
    if (changing) {
      await nextOwner.promise;
    }
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentVncAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: !changing });
  });
  await setupPage({
    context,
    path: `/agents/${agentId}?tab=authorization`,
    featureSwitches: { [FeatureSwitchKey.VncAccess]: true },
  });
  await expect(
    screen.findByRole("switch", { name: "Revoke VNC access" }),
  ).resolves.toBeChecked();
  const clerk = context.mocks.clerk();
  changing = true;
  act(() => {
    clerk.user(
      { id: "other-owner", fullName: "Other Owner" },
      { token: "other-token" },
    );
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(screen.queryByRole("switch", { name: /VNC access/u })).toBeNull();
  });
  nextOwner.resolve();
  await expect(
    screen.findByRole("switch", { name: "Grant VNC access" }),
  ).resolves.not.toBeChecked();
});

test.each([false, true])(
  "Chat VNC setup appears and filters in directory layout %s",
  async (directory) => {
    installComposerConnectorFixture();
    context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 0 });
    });
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    click(await findFastControl("button", "Connectors"));
    click(await findFastControl("button", "Add connectors"));
    const search = await screen.findByPlaceholderText("Find connectors...");
    const dialog = search.closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Missing connector dialog");
    }
    await findFastControl("link", "Manage VNC", dialog);
    await fill(search, "vnc");
    await expect(
      findFastControl("link", "Manage VNC", dialog),
    ).resolves.toHaveAttribute("href", "/connectors/vnc?add=1");
    expect(queryFastControl("link", "Manage SSH hosts", dialog)).toBeNull();
  },
);

test.each([false, true])(
  "Chat VNC discovery can retry a failed summary inside directory layout %s",
  async (directory) => {
    installComposerConnectorFixture();
    let failed = true;
    const recovery = context.mocks.deferred<void>();
    context.mocks.api(vncConnectionsContract.summary, async ({ respond }) => {
      if (failed) {
        return respond(500, {
          error: { code: "INTERNAL_ERROR", message: "private VNC error" },
        });
      }
      await recovery.promise;
      return respond(200, { configuredCount: 0 });
    });
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    click(await findFastControl("button", "Connectors"));
    click(await findFastControl("button", "Add connectors"));
    const search = await screen.findByPlaceholderText("Find connectors...");
    const dialog = search.closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Missing connector dialog");
    }
    await fill(search, "vnc");
    await expect(
      within(dialog).findByText("Could not load VNC configuration."),
    ).resolves.toBeInTheDocument();
    expect(within(dialog).queryByText("No connector matches “vnc”")).toBeNull();
    expect(dialog.textContent).not.toContain("private VNC error");
    failed = false;
    click(await findFastControl("button", "Retry", dialog));
    await expect(
      within(dialog).findByText("Loading VNC configuration…"),
    ).resolves.toBeInTheDocument();
    expect(within(dialog).queryByText("No connector matches “vnc”")).toBeNull();
    recovery.resolve();
    await expect(
      findFastControl("link", "Manage VNC", dialog),
    ).resolves.toHaveAttribute("href", "/connectors/vnc?add=1");
    expect(
      within(dialog).queryByText("Could not load VNC configuration."),
    ).toBeNull();
  },
);

test("Chat VNC grant changes leave SSH authorization intact", async () => {
  installComposerConnectorFixture();
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: true });
  });
  context.mocks.api(agentSshAccessContract.update, () => {
    throw new Error("VNC must not change SSH grants");
  });
  let enabled = false;
  context.mocks.api(agentVncAccessContract.get, ({ respond }) => {
    return respond(200, { enabled });
  });
  context.mocks.api(
    agentVncAccessContract.update,
    ({ body, params, respond }) => {
      expect(params.agentId).toBe(SCOUT_AGENT_ID);
      enabled = body.enabled;
      return respond(200, { enabled });
    },
  );
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.VncAccess]: true },
  });
  click(await findFastControl("button", "Connectors"));
  click(await screen.findByLabelText("Add VNC"));
  await expect(screen.findByLabelText("Remove VNC")).resolves.toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.getByLabelText("Remove SSH")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
