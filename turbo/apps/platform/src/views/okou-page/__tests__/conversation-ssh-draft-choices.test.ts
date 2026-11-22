import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import type { InitialRemoteAccessOverride } from "@okouai/api-contracts/contracts/chat-remote-access";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { remoteId } from "./connectors-remote-control-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { sendComposerMessage } from "./chat-composer-template-gallery-test-helpers.ts";
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
