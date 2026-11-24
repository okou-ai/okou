import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import type { InitialRemoteAccessOverride } from "@okouai/api-contracts/contracts/chat-remote-access";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { remoteId } from "./connectors-remote-control-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { sendComposerMessage } from "./chat-composer-template-gallery-test-helpers.ts";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import {
  createComposerConnectorHelpers,
  builtinConnector,
} from "./chat-composer-connectors-test-helpers.ts";

const context = testContext();

const host1 = {
  connectionId: remoteId("b", 11),
  displayName: "Build host",
  defaultEnabled: true,
} as const;

const host2 = {
  connectionId: remoteId("b", 12),
  displayName: "Deploy host",
  defaultEnabled: false,
} as const;

async function newConversation(hosts: (typeof host1 | typeof host2)[]) {
  const created = context.mocks.deferred<
    readonly InitialRemoteAccessOverride[] | undefined
  >();
  mockChatLifecycle(context, {
    onThreadCreate(body) {
      created.resolve(body.initialRemoteAccessOverrides);
    },
  });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      cloudBrowserEnabledByDefault: false,
      cloudBrowserAvailable: false,
      computerUseHosts: [],
      sshHosts: hosts,
      vncHosts: [],
    });
  });
  context.mocks.browser.matchMedia(true);
  await setupPage({ context, path: "/?compose=1" });
  return { creation: created.promise };
}

async function settings() {
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", /Remote access/));
  return screen.findByRole("dialog", { name: "Remote access" });
}

async function choose(host: string, value: string | RegExp) {
  const field = await screen.findByRole("combobox", { name: "SSH " + host });
  click(field);
  click(await screen.findByRole("option", { name: value }));
  return field;
}

async function close(dialog: HTMLElement) {
  click(await findFastControl("button", "Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Remote access" })).toBeNull();
  });
}

test("chat-composer-ssh-012 Draft SSH access survives closing Remote access, and restoring the default clears the override", async () => {
  await newConversation([host1, host2]);
  const initial = await settings();
  expect(
    within(initial).getByText("Applied when you send the first message"),
  ).toBeVisible();
  const first = await choose("Build host", "Off");
  await waitFor(() => {
    expect(first).toHaveTextContent(/^Off$/);
  });
  await close(initial);
  const reopened = await settings();
  expect(
    within(reopened).getByRole("combobox", { name: "SSH Build host" }),
  ).toHaveTextContent(/^Off$/);
  const restored = await choose("Build host", /^Default/);
  await waitFor(() => {
    expect(restored).toHaveTextContent(/Default.*On/);
  });
  expect(
    within(reopened).getByRole("combobox", { name: "SSH Deploy host" }),
  ).toHaveTextContent(/Default.*Off/);
});

test("chat-composer-ssh-009 Starting a conversation leaves the default SSH access untouched", async () => {
  const created = await newConversation([host1]);
  const dialog = await settings();
  expect(
    within(dialog).getByRole("combobox", { name: "SSH Build host" }),
  ).toHaveTextContent(/Default.*On/);
  await close(dialog);
  await sendComposerMessage(
    userEvent.setup({ delay: null }),
    "Review my build",
  );
  await screen.findByText("Review my build", { exact: true });
  await expect(created.creation).resolves.toBeUndefined();
  expect(location.pathname).toMatch(/^\/chats\//);
});

test("chat-composer-ssh-014 The first message carries both explicit SSH choices in host order", async () => {
  const created = await newConversation([host1, host2]);
  const dialog = await settings();
  await choose("Build host", "Off");
  await choose("Deploy host", "On");
  expect(
    within(dialog).getByRole("combobox", { name: "SSH Deploy host" }),
  ).toHaveTextContent(/^On$/);
  await close(dialog);
  await sendComposerMessage(
    userEvent.setup({ delay: null }),
    "Inspect remote release",
  );
  await screen.findByText("Inspect remote release", { exact: true });
  await expect(created.creation).resolves.toStrictEqual([
    { protocol: "ssh", connectionId: host1.connectionId, enabled: false },
    { protocol: "ssh", connectionId: host2.connectionId, enabled: true },
  ]);
});

const github = builtinConnector({ slug: "github", label: "GitHub" });

async function directory(configuredCount: number) {
  const catalog = [
    github,
    builtinConnector({ slug: "notion", label: "Notion" }),
    builtinConnector({ slug: "slack", label: "Slack" }),
    builtinConnector({ slug: "linear", label: "Linear" }),
    builtinConnector({ slug: "figma", label: "Figma" }),
  ];
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    catalog,
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount });
  });
  await setupPage({ context, path: "/" });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "Add connectors"));
  const search = await screen.findByPlaceholderText("Find connectors...");
  const dlg = search.closest<HTMLElement>('[role="dialog"]')!;
  await within(dlg).findByText("Discover", { exact: true });
  return dlg;
}

async function openSetup(dialog: HTMLElement) {
  click(await findFastControl("link", "Manage SSH hosts", dialog));
  const add = await findFastControl("button", "Add connection");
  click(add);
  expect(location.pathname).toBe("/connectors");
  expect(
    Object.fromEntries(new URLSearchParams(location.search)),
  ).toMatchObject({ scope: "remote-control", type: "ssh" });
  await expect(
    screen.findByText("Add remote connection", { exact: true }),
  ).resolves.toBeVisible();
}

test("chat-composer-ssh-016 A first SSH host can be configured from the new chat's connector directory", async () => {
  const dialog = await directory(0);
  await expect(
    findFastControl("link", "Manage SSH hosts", dialog),
  ).resolves.toBeVisible();
  await openSetup(dialog);
});

test("chat-composer-ssh-017 A new chat with an existing SSH connection stays in the directory without offering first-host setup", async () => {
  const dialog = await directory(1);
  await within(dialog).findByText("Productivity", { exact: true });
  expect(queryFastControl("link", "Manage SSH hosts", dialog)).toBeNull();
  expect(location.pathname).toBe("/");
  expect(location.search).toBe("");
});

test("chat-composer-ssh-018 Remote-access discovery and All offer first-host setup while the Custom shelf stays empty", async () => {
  const dialog = await directory(0);
  const cat = await within(dialog).findAllByText("Remote access", {
    exact: true,
  });
  click(
    cat.find((el) => {
      return el.closest("button");
    })!,
  );
  await expect(
    findFastControl("link", "Manage SSH hosts", dialog),
  ).resolves.toBeVisible();
  click(await within(dialog).findByText("Custom", { exact: true }));
  await expect(
    within(dialog).findByText(/No custom connectors yet/i),
  ).resolves.toBeVisible();
  expect(queryFastControl("link", "Manage SSH hosts", dialog)).toBeNull();
  click(await within(dialog).findByText("Discover", { exact: true }));
  await expect(
    findFastControl("link", "Manage SSH hosts", dialog),
  ).resolves.toBeVisible();
  click(await findFastControl("button", "All", dialog));
  await waitFor(() => {
    return expect(
      queryFastControl("link", "Manage SSH hosts", dialog),
    ).toBeVisible();
  });
  await openSetup(dialog);
});
