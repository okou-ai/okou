import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
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
  OTHER_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";

const github = connectorSlugSchema.parse("github");
const slack = connectorSlugSchema.parse("slack");
const gmail = connectorSlugSchema.parse("gmail");

test("SSH connection failures do not add Chat-only indicators or change order or authorization", async () => {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: github, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [github] },
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 2 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: true });
  });
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, {
      observations: [
        {
          connectionId: "b0000000-0000-4000-8000-000000000001",
          generation: 1,
          observedAt: "2026-09-10T08:00:00.000Z",
          failureReason: "authentication_failed",
        },
      ],
    });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });
  const trigger = await findFastControl("button", "Connectors");
  await within(trigger).findByRole("img", { name: "SSH" });
  expect(within(trigger).queryByRole("status")).toBeNull();
  expect(triggerIcons(trigger)).toStrictEqual([
    "https://icons.example.test/github.svg",
    "SSH",
  ]);
  click(trigger);
  await screen.findByLabelText("Remove SSH");
  const row = within(screen.getByRole("list", { name: "Connectors" }))
    .getAllByRole("listitem")
    .at(-1);
  expect(row).toBeDefined();
  if (!row) {
    throw new Error("Missing SSH service row");
  }
  expect(within(row).queryByRole("status")).toBeNull();
  expect(within(row).getByLabelText("Remove SSH")).toBeInTheDocument();
});

function triggerIcons(trigger: HTMLElement) {
  return [...trigger.querySelectorAll('img, svg[role="img"]')].map((icon) => {
    return icon.getAttribute("src") ?? icon.getAttribute("aria-label");
  });
}

test("Opening services retains SSH while refreshing and applies the confirmed grant", async () => {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: github, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [github] },
  });
  const refresh = context.mocks.deferred<void>();
  let refreshing = false;
  let enabled = true;
  context.mocks.api(sshConnectionsContract.summary, async ({ respond }) => {
    if (refreshing) {
      await refresh.promise;
    }
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });
  const trigger = await findFastControl("button", "Connectors");
  await within(trigger).findByRole("img", { name: "SSH" });
  const expected = ["https://icons.example.test/github.svg", "SSH"];
  expect(triggerIcons(trigger)).toStrictEqual(expected);
  refreshing = true;
  click(trigger);
  await waitFor(() => {
    expect(screen.getByLabelText("Remove SSH")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(triggerIcons(trigger)).toStrictEqual(expected);
  enabled = false;
  refresh.resolve();
  await screen.findByLabelText("Add SSH");
  expect(triggerIcons(trigger)).toStrictEqual([
    "https://icons.example.test/github.svg",
  ]);
});

test.each([2, 3])(
  "SSH follows all builtin services and does not displace %s builtin trigger icons",
  async (count) => {
    const catalog = [
      builtinConnector({ slug: github, label: "GitHub" }),
      builtinConnector({ slug: slack, label: "Slack" }),
      builtinConnector({ slug: gmail, label: "Gmail" }),
    ].slice(0, count);
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
    const trigger = await findFastControl("button", "Connectors");
    click(trigger);
    await screen.findByLabelText("Remove SSH");
    const list = screen.getByRole("list", { name: "Connectors" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.at(-1)).toHaveTextContent("SSH");
    expect(
      rows.slice(0, count).every((row) => {
        return !row.textContent?.includes("SSH");
      }),
    ).toBeTruthy();
    const icons = catalog.map((connector) => {
      return `https://icons.example.test/${connector.slug}.svg`;
    });
    await waitFor(() => {
      expect(triggerIcons(trigger)).toStrictEqual(icons.slice(0, 2));
    });
    click(await screen.findByRole("switch", { name: "Disable Cloud browser" }));
    await waitFor(() => {
      expect(triggerIcons(trigger)).toStrictEqual(
        [...icons, "SSH"].slice(0, 3),
      );
    });
  },
);

test("Switching Agents does not retain the previous Agent's enabled SSH icon", async () => {
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
  await within(trigger).findByRole("img", { name: "SSH" });
  click(await findFastControl("link", "Other Agent"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${OTHER_AGENT_ID}/chat`);
  });
  const otherTrigger = await findFastControl("button", "Connectors");
  click(otherTrigger);
  await screen.findByLabelText("Add SSH");
  expect(within(otherTrigger).queryByRole("img", { name: "SSH" })).toBeNull();
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
  const trigger = await findFastControl("button", "Connectors");
  await within(trigger).findByRole("img", { name: "SSH" });
  changing = true;
  act(() => {
    clerk.user(
      { id: "other-ssh-user", fullName: "Other user" },
      { token: "other-user-token" },
    );
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(screen.queryByRole("img", { name: "SSH" })).toBeNull();
  });
  nextOwner.resolve();
  const nextTrigger = await findFastControl("button", "Connectors");
  click(nextTrigger);
  await screen.findByLabelText("Add SSH");
  expect(within(nextTrigger).queryByRole("img", { name: "SSH" })).toBeNull();
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
  await within(trigger).findByRole("img", { name: "SSH" });

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
  { directory: false, configuredCount: 1 },
  { directory: true, configuredCount: 0 },
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
      await screen.findByRole("dialog", { name: "Add host" });
    }
    await waitFor(() => {
      return expect(window.location.pathname).toBe(
        showEntry ? "/connectors/ssh" : `/agents/${SCOUT_AGENT_ID}/chat`,
      );
    });
    expect(window.location.search).toBe("");
  },
);

test.each([false, true])(
  "Chat SSH discovery can retry a failed summary inside directory layout %s",
  async (directory) => {
    installComposerConnectorFixture();
    let failed = true;
    const recovery = context.mocks.deferred<void>();
    context.mocks.api(sshConnectionsContract.summary, async ({ respond }) => {
      if (failed) {
        return respond(500, {
          error: { code: "INTERNAL_ERROR", message: "private SSH error" },
        });
      }
      await recovery.promise;
      return respond(200, { configuredCount: 0 });
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
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Missing connector dialog");
    }
    await fill(search, "ssh");
    await expect(
      within(dialog).findByText("Could not load SSH settings. Try again."),
    ).resolves.toBeInTheDocument();
    expect(within(dialog).queryByText("No connector matches “ssh”")).toBeNull();
    expect(dialog.textContent).not.toContain("private SSH error");
    expect(search).toHaveValue("ssh");
    failed = false;
    click(await findFastControl("button", "Retry", dialog));
    await expect(
      within(dialog).findByText("Loading SSH hosts…"),
    ).resolves.toBeInTheDocument();
    expect(within(dialog).queryByText("No connector matches “ssh”")).toBeNull();
    expect(search).toHaveValue("ssh");
    recovery.resolve();
    await expect(
      findFastControl("link", "Manage SSH hosts", dialog),
    ).resolves.toHaveAttribute("href", "/connectors/ssh?add=1");
    expect(
      within(dialog).queryByText("Could not load SSH settings. Try again."),
    ).toBeNull();
    expect(search).toHaveValue("ssh");
  },
);

test("Directory SSH setup follows shelves and categories and supports keyboard navigation", async () => {
  const user = userEvent.setup({ delay: null });
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
  await within(dialog).findByText("1 match");
  expect(within(dialog).queryByText("GitHub")).toBeNull();
  click(within(dialog).getByText("Custom", { exact: true }));
  await within(dialog).findByText("No custom connectors yet");
  expect(queryFastControl("link", "Manage SSH hosts", dialog)).toBeNull();
  click(within(dialog).getByText("Discover", { exact: true }));
  await findFastControl("link", "Manage SSH hosts", dialog);
  click(await findFastControl("button", "All", dialog));
  await within(dialog).findByTestId("connector-shelf-head");
  const entry = await findFastControl("link", "Manage SSH hosts", dialog);
  entry.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Add host" });
  expect(window.location.pathname).toBe("/connectors/ssh");
});
