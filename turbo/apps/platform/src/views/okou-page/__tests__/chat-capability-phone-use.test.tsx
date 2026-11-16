import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  phoneUseContract,
  type PhoneDevice,
  type PhoneUseSelection,
} from "@okouai/api-contracts/contracts/phone-use";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  findButton,
  NEW_CHAT_PATH,
  queryButton,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  sendText,
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

async function setup(
  enabled: boolean,
  accountAccess = true,
  options: { path?: string; onSend?: () => void } = {},
) {
  installRunChat({ onSendRequest: options.onSend });
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
    path: options.path ?? NEW_CHAT_PATH,
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

test("Connect my phone explains chat-menu consent and native preparation separately", async () => {
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
    within(dialog).getByText("Enable your phone in this chat"),
  ).toBeVisible();
  expect(within(dialog).getByText("Send your next task")).toBeVisible();
  expect(queryButton("Refresh phones")).toBeNull();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(queryButton("Connectors")).toHaveFocus();
  });
});

test.each([true, false])(
  "Authorize, switch and revoke a phone from this chat (account menu: %s)",
  async (accountAccess) => {
    const secondary = {
      ...phone(false),
      id: "e0000000-0000-4000-a000-000000001002",
      displayName: "Second iPhone",
    };
    let selection: PhoneUseSelection | null = null;
    context.mocks.api(phoneUseContract.devices, ({ respond }) => {
      return respond(200, { devices: [phone(), secondary] });
    });
    context.mocks.api(phoneUseContract.chatGrant, ({ respond, params }) => {
      expect(params.threadId).toBe(RUN_THREAD_ID);
      return respond(200, { selection });
    });
    context.mocks.api(phoneUseContract.grant, async ({ respond, request }) => {
      const body = phoneUseContract.grant.body.parse(await request.json());
      expect(body.threadId).toBe(RUN_THREAD_ID);
      selection = body.allow
        ? { deviceId: body.deviceId, generation: body.generation }
        : null;
      return respond(200, { ok: true });
    });
    await setup(true, accountAccess, { path: RUN_PATH });
    const primary = await screen.findByRole("switch", {
      name: /^Owner iPhone/u,
    });
    const second = await screen.findByRole("switch", {
      name: /^Second iPhone/u,
    });
    await waitFor(() => {
      expect(primary).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(primary).not.toBeChecked();
    click(primary);
    await waitFor(() => {
      expect(primary).toBeChecked();
      expect(primary).not.toHaveAttribute("aria-disabled", "true");
    });
    click(second);
    await waitFor(() => {
      expect(second).toBeChecked();
      expect(second).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(primary).not.toBeChecked();
    click(second);
    await waitFor(() => {
      expect(second).not.toBeChecked();
      expect(second).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(selection).toBeNull();
  },
);

test("A new chat saves its selected phone before the first message starts a Run", async () => {
  const order: string[] = [];
  let selection: PhoneUseSelection | null = null;
  context.mocks.api(phoneUseContract.devices, ({ respond }) => {
    return respond(200, { devices: [phone()] });
  });
  context.mocks.api(phoneUseContract.chatGrant, ({ respond }) => {
    return respond(200, { selection });
  });
  context.mocks.api(phoneUseContract.grant, async ({ respond, request }) => {
    const body = phoneUseContract.grant.body.parse(await request.json());
    expect(body).toMatchObject({
      deviceId: phone().id,
      generation: 1,
      allow: true,
    });
    selection = { deviceId: body.deviceId, generation: body.generation };
    order.push("grant");
    return respond(200, { ok: true });
  });
  await setup(true, true, {
    onSend: () => {
      order.push("send");
    },
  });
  const control = await screen.findByRole("switch", { name: /^Owner iPhone/u });
  await waitFor(() => {
    expect(control).not.toHaveAttribute("aria-disabled", "true");
  });
  click(control);
  await waitFor(() => {
    expect(control).toBeChecked();
  });
  expect(order).toStrictEqual([]);
  await userEvent.keyboard("{Escape}");
  await sendText("Use my phone");
  await waitFor(() => {
    expect(order).toStrictEqual(["grant", "send"]);
  });
});

test("A failed chat-authorization read disables phone switches until refresh succeeds", async () => {
  let failed = true;
  context.mocks.api(phoneUseContract.devices, ({ respond }) => {
    return respond(200, { devices: [phone()] });
  });
  context.mocks.api(phoneUseContract.chatGrant, ({ respond }) => {
    return failed
      ? respond(503, { error: { message: "Unavailable", code: "UNAVAILABLE" } })
      : respond(200, { selection: null });
  });
  await setup(true, true, { path: RUN_PATH });
  const control = await screen.findByRole("switch", { name: /^Owner iPhone/u });
  await screen.findByRole("alert");
  expect(control).toHaveAttribute("aria-disabled", "true");
  failed = false;
  click(await findButton("Refresh phones"));
  await waitFor(() => {
    expect(control).not.toHaveAttribute("aria-disabled", "true");
  });
});

test("Rejected phone consent preserves the new-chat draft and never starts its Run", async () => {
  let sends = 0;
  context.mocks.api(phoneUseContract.devices, ({ respond }) => {
    return respond(200, { devices: [phone()] });
  });
  context.mocks.api(phoneUseContract.grant, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Phone access could not be saved" },
    });
  });
  await setup(true, true, {
    onSend: () => {
      sends += 1;
    },
  });
  const control = await screen.findByRole("switch", { name: /^Owner iPhone/u });
  await waitFor(() => {
    expect(control).not.toHaveAttribute("aria-disabled", "true");
  });
  click(control);
  await waitFor(() => {
    expect(control).toBeChecked();
  });
  await userEvent.keyboard("{Escape}");
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "Use my phone");
  click(await findButton("Send"));
  await screen.findByText("Phone access could not be saved");
  expect(composer).toHaveTextContent("Use my phone");
  expect(window.location.pathname).toBe(NEW_CHAT_PATH);
  expect(sends).toBe(0);
  click(await findButton("Connectors"));
  await expect(
    screen.findByRole("switch", { name: /^Owner iPhone/u }),
  ).resolves.toBeChecked();
});
