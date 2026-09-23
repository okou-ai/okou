import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  installComposerConnectorFixture,
  builtinConnector,
  SCOUT_AGENT_ID,
  SCOUT_THREAD_ID,
  OTHER_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";

const github = connectorSlugSchema.parse("github");
const slack = connectorSlugSchema.parse("slack");
const gmail = connectorSlugSchema.parse("gmail");

test("A chat can override multiple SSH hosts and return to each host default", async () => {
  const hostIds = [
    "b0000000-0000-4000-8000-000000000001",
    "b0000000-0000-4000-8000-000000000002",
  ];
  installComposerConnectorFixture({ threadId: SCOUT_THREAD_ID });
  const overrides = new Map<string, boolean>();
  const host = (connectionId: string, index: number) => {
    const overrideEnabled = overrides.get(connectionId) ?? null;
    const defaultEnabled = index === 0;
    return {
      connectionId,
      displayName: `SSH host ${index + 1}`,
      defaultEnabled,
      overrideEnabled,
      enabled: overrideEnabled ?? defaultEnabled,
      source:
        overrideEnabled === null ? ("default" as const) : ("override" as const),
    };
  };
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ respond }) => {
      return respond(200, {
        ssh: hostIds.map(host),
        vnc: [],
      });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.setThreadOverride,
    ({ params, body, respond }) => {
      overrides.set(params.connectionId, body.enabled);
      return respond(
        200,
        host(params.connectionId, hostIds.indexOf(params.connectionId)),
      );
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.clearThreadOverride,
    ({ params, respond }) => {
      overrides.delete(params.connectionId);
      return respond(
        200,
        host(params.connectionId, hostIds.indexOf(params.connectionId)),
      );
    },
  );
  await setupPage({
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ThreadRemoteAccess]: true },
  });
  click(await findFastControl("button", "Connectors"));
  const remoteAccess = await screen.findByText("Remote access");
  const cloudBrowser = screen.getByText("Cloud browser");
  const yourComputer = screen.getByText("Your computer");
  expect(
    cloudBrowser.compareDocumentPosition(remoteAccess) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    remoteAccess.compareDocumentPosition(yourComputer) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  click(remoteAccess);
  const first = await screen.findByRole("combobox", { name: "SSH SSH host 1" });
  const second = screen.getByRole("combobox", { name: "SSH SSH host 2" });
  expect(first).toHaveValue("default");
  expect(second).toHaveValue("default");
  const user = userEvent.setup({ delay: null });
  await user.selectOptions(first, "off");
  await waitFor(() => {
    expect(overrides.get(hostIds[0]!)).toBeFalsy();
    expect(second).not.toBeDisabled();
  });
  await user.selectOptions(
    screen.getByRole("combobox", { name: "SSH SSH host 2" }),
    "on",
  );
  await waitFor(() => {
    expect(overrides.get(hostIds[0]!)).toBeFalsy();
    expect(overrides.get(hostIds[1]!)).toBeTruthy();
  });
  await user.selectOptions(
    screen.getByRole("combobox", { name: "SSH SSH host 1" }),
    "default",
  );
  await waitFor(() => {
    expect(overrides.has(hostIds[0]!)).toBeFalsy();
  });
});

async function loadSshAccess(trigger: HTMLElement): Promise<void> {
  click(trigger);
  const toggle = await screen.findByLabelText("Remove SSH");
  click(trigger);
  await waitFor(() => {
    expect(toggle).not.toBeInTheDocument();
  });
}

test("SSH follows all builtin services in the Connectors menu", async () => {
  const catalog = [
    builtinConnector({ slug: github, label: "GitHub" }),
    builtinConnector({ slug: slack, label: "Slack" }),
    builtinConnector({ slug: gmail, label: "Gmail" }),
  ];
  installComposerConnectorFixture({
    catalog,
    builtinAuthorizations: {
      [SCOUT_AGENT_ID]: catalog.map((connector) => {
        return connector.slug;
      }),
    },
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: true });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });
  click(await findFastControl("button", "Connectors"));
  await screen.findByLabelText("Remove SSH");
  const list = screen.getByRole("list", { name: "Connectors" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((row) => {
        return row.textContent;
      }),
  ).toStrictEqual(["GitHub", "Slack", "Gmail", "SSH"]);
});

test("Switching Agents does not retain the previous Agent's enabled SSH access", async () => {
  installComposerConnectorFixture();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [SCOUT_AGENT_ID, OTHER_AGENT_ID],
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ params, respond }) => {
    return respond(200, { enabled: params.agentId === SCOUT_AGENT_ID });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });
  const trigger = await findFastControl("button", "Connectors");
  await loadSshAccess(trigger);
  click(await findFastControl("link", "Other Agent"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${OTHER_AGENT_ID}/chat`);
  });
  click(await findFastControl("button", "Connectors"));
  await screen.findByLabelText("Add SSH");
  expect(screen.queryByLabelText("Remove SSH")).toBeNull();
});

test("Changing user clears retained SSH presentation while the new owner loads", async () => {
  installComposerConnectorFixture();
  const clerk = context.mocks.clerk();
  const nextOwner = context.mocks.deferred<void>();
  let changing = false;
  context.mocks.api(sshConnectionsContract.summary, async ({ respond }) => {
    if (changing) {
      await nextOwner.promise;
    }
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: !changing });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });
  click(await findFastControl("button", "Connectors"));
  await screen.findByLabelText("Remove SSH");
  changing = true;
  act(() => {
    clerk.user(
      { id: "other-ssh-user", fullName: "Other user" },
      { token: "other-user-token" },
    );
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(screen.queryByLabelText("Remove SSH")).toBeNull();
  });
  expect(screen.queryByLabelText("Add SSH")).toBeNull();
  nextOwner.resolve();
  await expect(screen.findByLabelText("Add SSH")).resolves.toBeInTheDocument();
  expect(screen.queryByLabelText("Remove SSH")).toBeNull();
});

test("Changing workspace reloads the chat page before using the new SSH owner", async () => {
  installComposerConnectorFixture();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: true });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });
  const trigger = await findFastControl("button", "Connectors");
  await loadSshAccess(trigger);

  const clerk = context.mocks.clerk();
  act(() => {
    clerk.organization({
      activeOrg: { id: "org_ssh_other", name: "Other workspace" },
      memberships: [{ id: "org_ssh_other" }],
    });
    clerk.stateChanged();
  });

  await waitFor(() => {
    expect(window.location.pathname).toBe("/");
  });
});

test.each([SCOUT_AGENT_ID, OTHER_AGENT_ID])(
  "Chat SSH uses the composer Agent %s, not another Agent's grant",
  async (agentId) => {
    const fixture = installComposerConnectorFixture();
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 2 });
    });
    const grants = new Set([SCOUT_AGENT_ID]);
    const writes: unknown[] = [];
    context.mocks.api(agentSshAccessContract.get, ({ params, respond }) => {
      return respond(200, { enabled: grants.has(params.agentId) });
    });
    context.mocks.api(
      agentSshAccessContract.update,
      ({ params, body, respond }) => {
        writes.push({ agentId: params.agentId, enabled: body.enabled });
        if (body.enabled) {
          grants.add(params.agentId);
        } else {
          grants.delete(params.agentId);
        }
        return respond(200, body);
      },
    );
    await setupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });
    click(await findFastControl("button", "Connectors"));
    const enabled = agentId === SCOUT_AGENT_ID;
    const toggle = await screen.findByLabelText(
      enabled ? "Remove SSH" : "Add SSH",
    );
    expect(toggle).toHaveAttribute("aria-checked", String(enabled));
    const row = toggle.closest('[role="listitem"]');
    expect(row).toHaveTextContent("SSH");
    click(toggle);
    await screen.findByLabelText(enabled ? "Add SSH" : "Remove SSH");
    expect(writes).toStrictEqual([{ agentId, enabled: !enabled }]);
    expect(fixture.builtinAuthorizationUpdates).toStrictEqual([]);
    expect(fixture.customAuthorizationUpdates).toStrictEqual([]);
  },
);

test.each([
  { directory: false, configuredCount: 0 },
  { directory: true, configuredCount: 1 },
])(
  "Chat SSH setup respects directory=$directory and hosts=$configuredCount",
  async ({ directory, configuredCount }) => {
    installComposerConnectorFixture();
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount });
    });
    context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
      return respond(200, { enabled: false });
    });
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    click(await findFastControl("button", "Connectors"));
    click(await findFastControl("button", "Add connectors"));
    const search = await screen.findByPlaceholderText("Find connectors...");
    const dialog = search.closest('[role="dialog"]');
    expect(screen.queryByRole("switch", { name: /SSH/u })).toBeNull();
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Missing connector dialog");
    }
    const showEntry = configuredCount === 0;
    const initialEntry = showEntry
      ? await findFastControl("link", "Manage SSH hosts", dialog)
      : queryFastControl("link", "Manage SSH hosts", dialog);
    expect(initialEntry !== null).toBe(showEntry);
    if (showEntry) {
      await fill(search, "ssh");
      const entry = await findFastControl("link", "Manage SSH hosts", dialog);
      click(entry);
      click(await findFastControl("button", "Add host"));
      await screen.findByRole("dialog", { name: "Add host" });
    }
    await waitFor(() => {
      return expect(window.location.pathname).toBe(
        showEntry ? "/connectors" : `/agents/${SCOUT_AGENT_ID}/chat`,
      );
    });
    expect(window.location.search).toBe(
      showEntry ? "?scope=remote-control&type=ssh" : "",
    );
  },
);

test("Chat SSH discovery shows a failed summary without leaking its error", async () => {
  installComposerConnectorFixture();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "private SSH error" },
    });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ConnectorDirectory]: true,
    },
  });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "Add connectors"));
  const search = await screen.findByPlaceholderText("Find connectors...");
  const dialog = search.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Missing connector dialog");
  }
  await fill(search, "ssh");
  await expect(
    within(dialog).findByText("Could not load SSH settings. Try again."),
  ).resolves.toBeInTheDocument();
  expect(dialog.textContent).not.toContain("private SSH error");
});

test("Directory SSH setup follows shelves and categories", async () => {
  installComposerConnectorFixture({
    catalog: ["GitHub", "Slack", "Gmail", "Notion", "Jira"].map(
      (label, popularityRank) => {
        return builtinConnector({
          slug: connectorSlugSchema.parse(label.toLowerCase()),
          label,
          connected: false,
          popularityRank,
        });
      },
    ),
    categoryConnectorCounts: { productivity: 5 },
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ConnectorDirectory]: true,
    },
  });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "Add connectors"));
  const dialog = await screen.findByRole("dialog", { name: "Connectors" });
  await within(dialog).findByTestId("connector-shelf-head");
  await findFastControl("link", "Manage SSH hosts", dialog);
  click(await findFastControl("button", "Remote access1", dialog));
  await within(dialog).findByRole("heading", { name: "Remote access" });
  expect(within(dialog).queryByText("GitHub")).toBeNull();
  click(within(dialog).getByText("Custom", { exact: true }));
  await within(dialog).findByText("No custom connectors yet");
  expect(queryFastControl("link", "Manage SSH hosts", dialog)).toBeNull();
  click(within(dialog).getByText("Discover", { exact: true }));
  await findFastControl("link", "Manage SSH hosts", dialog);
  click(await findFastControl("button", "All", dialog));
  await within(dialog).findByTestId("connector-shelf-head");
  const entry = await findFastControl("link", "Manage SSH hosts", dialog);
  click(entry);
  click(await findFastControl("button", "Add host"));
  await screen.findByRole("dialog", { name: "Add host" });
  expect(window.location.pathname).toBe("/connectors");
  expect(window.location.search).toBe("?scope=remote-control&type=ssh");
});
