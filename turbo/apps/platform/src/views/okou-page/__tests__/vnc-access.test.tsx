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
      [FeatureSwitchKey.ConnectorDirectory]: false,
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
  "VNC is available in its layout's connection list (%s)",
  async (directory) => {
    mockCatalog();
    context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 0 });
    });
    context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    await setupPage({
      context,
      path: directory
        ? "/connectors?scope=remote-control"
        : "/connectors?keywords=vnc",
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    if (directory) {
      await findFastControl("button", "Manage VNC access");
      await screen.findByRole("heading", { name: "VNC" });
    } else {
      await findFastControl("link", "Manage VNC");
      await screen.findByRole("heading", { name: "Remote access" });
    }
    expect(
      queryFastControl("link", "Manage VNC")?.getAttribute("href") ?? null,
    ).toBe(directory ? null : "/connectors/vnc?add=1");
    expect(queryFastControl("link", "Manage SSH hosts")).toBeNull();
  },
);

test.each([false, true])(
  "VNC connection list does not report an empty result while a failed request retries (%s)",
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
    context.mocks.api(vncConnectionsContract.list, async ({ respond }) => {
      if (failed) {
        return respond(500, {
          error: { code: "INTERNAL_ERROR", message: "private VNC error" },
        });
      }
      await recovery.promise;
      return respond(200, { connections: [] });
    });
    await setupPage({
      context,
      path: directory
        ? "/connectors?scope=remote-control"
        : "/connectors?keywords=vnc",
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
    if (!directory) {
      await retryStarted.promise;
    }
    await expect(
      screen.findByText("Loading VNC configuration…"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText(/No connectors matching/u)).toBeNull();
    recovery.resolve();
    const recovered = directory
      ? await screen.findByText("Add a VNC host to get started.")
      : await findFastControl("link", "Manage VNC");
    expect(recovered).toBeInTheDocument();
    expect(recovered.getAttribute("href")).toBe(
      directory ? null : "/connectors/vnc?add=1",
    );
  },
);

test.each([false, true])(
  "Feature-off VNC makes no requests in directory layout %s",
  async (directory) => {
    mockCatalog();
    context.mocks.api(vncConnectionsContract.summary, () => {
      throw new Error("Feature-off VNC must not dispatch owner requests");
    });
    await setupPage({
      context,
      path: directory ? "/connectors?scope=remote-control" : "/connectors",
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: false,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    if (directory) {
      await screen.findByRole("heading", { name: "SSH" });
    } else {
      await findFastControl("link", "Manage SSH hosts");
    }
    expect(screen.queryByRole("heading", { name: "VNC" })).toBeNull();
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
