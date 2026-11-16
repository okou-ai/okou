import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  phoneUseContract,
  type PhoneDevice,
} from "@okouai/api-contracts/contracts/phone-use";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  findButton,
  NEW_CHAT_PATH,
  queryButton,
  readyChat,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

function phone(ready = true): PhoneDevice {
  return {
    id: "e0000000-0000-4000-a000-000000001001",
    displayName: "Owner iPhone",
    osVersion: "27.1",
    appVersion: "1",
    generation: 1,
    ready,
    lastSeenAt: "2026-11-16T04:00:00.000Z",
  };
}

async function setup(enabled: boolean, accountAccess = true) {
  installRunChat();
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: [],
      vncHosts: [],
      computerUseHosts: [],
    });
  });
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    locale: "en-US",
    featureSwitches: {
      [FeatureSwitchKey.PhoneUse]: enabled,
      [FeatureSwitchKey.ConnectorChatAccountAccess]: accountAccess,
    },
  });
  await readyChat();
  click(await findButton("Connectors"));
}

test("Phone Use stays hidden without fetching devices until manually enabled", async () => {
  let reads = 0;
  context.mocks.api(phoneUseContract.devices, ({ respond }) => {
    reads += 1;
    return respond(200, { devices: [phone()] });
  });
  await setup(false);
  await findButton("Connect my computer");
  expect(screen.queryByText("Your phone")).toBeNull();
  expect(reads).toBe(0);
});

test.each([true, false])(
  "Show phone readiness and refresh stale devices (account menu: %s)",
  async (accountAccess) => {
    let devices = [phone()];
    context.mocks.api(phoneUseContract.devices, ({ respond }) => {
      return respond(200, { devices });
    });
    await setup(true, accountAccess);
    const phones = await screen.findByRole("list", { name: "Your phone" });
    expect(within(phones).getByText("Owner iPhone")).toBeVisible();
    expect(within(phones).getByText("Ready")).toBeVisible();
    devices = [phone(false)];
    click(await findButton("Refresh phones"));
    await screen.findByText("Not ready");
    devices = [];
    click(await findButton("Refresh phones"));
    await screen.findByText("No phones connected");
  },
);

test("A phone-list failure can be retried without closing the menu", async () => {
  let failed = true;
  context.mocks.api(phoneUseContract.devices, ({ respond }) => {
    return failed
      ? respond(503, { error: { message: "Unavailable", code: "UNAVAILABLE" } })
      : respond(200, { devices: [phone()] });
  });
  await setup(true);
  await screen.findByText("Could not load phones. Try refreshing.");
  failed = false;
  click(await findButton("Refresh phones"));
  await expect(screen.findByText("Owner iPhone")).resolves.toBeVisible();
});

test("Connect my phone hands off to native authorization guidance and restores focus", async () => {
  context.mocks.api(phoneUseContract.devices, ({ respond }) => {
    return respond(200, { devices: [] });
  });
  await setup(true);
  click(await findButton("Connect my phone"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect my phone",
  });
  expect(within(dialog).getByText("Open Okou iOS Use")).toBeVisible();
  expect(
    within(dialog).getByText("Allow this chat on your phone"),
  ).toBeVisible();
  expect(within(dialog).getByText("Send your next task")).toBeVisible();
  expect(queryButton("Refresh phones")).toBeNull();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(queryButton("Connectors")).toHaveFocus();
  });
});
