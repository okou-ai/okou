import {
  computerUseHostsContract,
  type ComputerUseHost,
} from "@okouai/api-contracts/contracts/computer-use";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  computerUsePermissions,
  mockMacUserAgentData,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const PRIMARY_HOST_ID = "e0000000-0000-4000-a000-000000001001";
const SECONDARY_HOST_ID = "e0000000-0000-4000-a000-000000001002";

interface CapturedComputerSend {
  readonly prompt: string;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
}

interface CapturedComputerUpdate {
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled?: boolean;
}

function computerHost(args: {
  readonly id: string;
  readonly displayName: string;
  readonly status: "online" | "offline";
}): ComputerUseHost {
  return {
    id: args.id,
    hostName: `${args.displayName.toLowerCase().replaceAll(" ", "-")}.local`,
    displayName: args.displayName,
    appVersion: "1.4.0",
    osVersion: "macOS 15.6",
    supportedCapabilities: ["browser", "desktop"],
    permissions: computerUsePermissions(),
    status: args.status,
    lastSeenAt: "2026-08-18T12:00:00.000Z",
    createdAt: "2026-08-01T09:00:00.000Z",
  };
}

function installComputerHosts(
  readHosts: () => readonly ComputerUseHost[] | null,
): void {
  context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
    const hosts = readHosts();
    if (hosts === null) {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Computer Use hosts are temporarily unavailable",
        },
      });
    }
    return respond(200, { hosts: [...hosts] });
  });
}

async function openComputerMenu(): Promise<void> {
  if (!queryButton("Connect my computer")) {
    click(await findButton("Connectors"));
  }
  await expect(findButton("Connect my computer")).resolves.toBeVisible();
}

function fastControl(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const control = queryAllByRoleFast(role, container).find((candidate) => {
    const text = candidate.textContent?.replace(/\s+/gu, " ").trim();
    return candidate.getAttribute("aria-label") === name || text === name;
  });
  if (!control) {
    throw new Error(`${name} ${role} was not visible`);
  }
  return control;
}

async function waitForComputerSend(
  sends: readonly CapturedComputerSend[],
  count: number,
): Promise<CapturedComputerSend> {
  await waitFor(() => {
    expect(sends).toHaveLength(count);
  });
  const send = sends[count - 1];
  if (!send) {
    throw new Error("Expected Computer Use send was not captured");
  }
  return send;
}

function installNewComputerChat(
  sends: CapturedComputerSend[],
  hosts: readonly ComputerUseHost[],
): void {
  installRunChat({
    onSendRequest(body) {
      sends.push({
        prompt: body.prompt,
        ...(body.computerUseHostId === undefined
          ? {}
          : { computerUseHostId: body.computerUseHostId }),
        ...(body.cloudBrowserEnabled === undefined
          ? {}
          : { cloudBrowserEnabled: body.cloudBrowserEnabled }),
      });
    },
  });
  installComputerHosts(() => {
    return hosts;
  });
}

async function openComputerDownloadDialog(title: string): Promise<HTMLElement> {
  await openComputerMenu();
  click(await findButton("Connect my computer"));
  return await screen.findByRole("dialog", { name: title });
}

async function prepareCloudBrowserDefaults() {
  const sends: CapturedComputerSend[] = [];
  installNewComputerChat(sends, [
    computerHost({
      id: PRIMARY_HOST_ID,
      displayName: "Studio Mac",
      status: "online",
    }),
  ]);
  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  return { sends };
}

test("Show cloud browser and local computer defaults in a new chat", async () => {
  await prepareCloudBrowserDefaults();
  await openComputerMenu();
  expect(screen.getByText("Cloud browser")).toBeVisible();
  expect(
    screen.getByRole("switch", { name: "Disable Cloud browser" }),
  ).toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Connect Studio Mac" }),
  ).not.toBeChecked();
});

test("Send a new chat with the default cloud browser", async () => {
  const { sends } = await prepareCloudBrowserDefaults();
  await sendText("Research the launch market");
  const sent = await waitForComputerSend(sends, 1);
  expect(sent).toMatchObject({
    prompt: "Research the launch market",
    cloudBrowserEnabled: true,
  });
  expect(sent.computerUseHostId).toBeUndefined();
  await expect(
    screen.findByText("Research the launch market"),
  ).resolves.toBeVisible();
});

test("Start a new chat with Cloud browser disabled", async () => {
  const user = userEvent.setup({ delay: null });
  const sends: CapturedComputerSend[] = [];
  installNewComputerChat(sends, []);

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyChat();
  await openComputerMenu();
  const cloudBrowser = screen.getByRole("switch", {
    name: "Disable Cloud browser",
  });
  expect(cloudBrowser).toBeChecked();

  await user.click(cloudBrowser);

  const disabledCloudBrowser = await screen.findByRole("switch", {
    name: "Enable Cloud browser",
  });
  expect(disabledCloudBrowser).not.toBeChecked();

  await sendText("Summarize the product launch");

  const sent = await waitForComputerSend(sends, 1);
  expect(sent.prompt).toBe("Summarize the product launch");
  expect(sent.cloudBrowserEnabled).toBeUndefined();
  expect(sent.computerUseHostId).toBeUndefined();
});

test("Use the saved Cloud browser default for an untouched new chat", async () => {
  const sends: CapturedComputerSend[] = [];
  context.mocks.data.userPreferences({
    cloudBrowserEnabledByDefault: false,
  });
  installNewComputerChat(sends, []);

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatPreference]: true },
  });

  await readyChat();
  await openComputerMenu();
  expect(
    screen.getByRole("switch", { name: "Enable Cloud browser" }),
  ).not.toBeChecked();

  await sendText("Review the launch notes");

  const sent = await waitForComputerSend(sends, 1);
  expect(sent.prompt).toBe("Review the launch notes");
  expect(sent.cloudBrowserEnabled).toBeUndefined();
  expect(sent.computerUseHostId).toBeUndefined();
});

test("Start a new chat with a selected local computer", async () => {
  const user = userEvent.setup({ delay: null });
  const sends: CapturedComputerSend[] = [];
  installNewComputerChat(sends, [
    computerHost({
      id: PRIMARY_HOST_ID,
      displayName: "Studio Mac",
      status: "online",
    }),
  ]);

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyChat();
  await openComputerMenu();
  const localComputer = screen.getByRole("switch", {
    name: "Connect Studio Mac",
  });

  await user.click(localComputer);

  await expect(
    screen.findByRole("switch", { name: "Disconnect Studio Mac" }),
  ).resolves.toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Enable Cloud browser" }),
  ).not.toBeChecked();

  await sendText("Open the desktop dashboard");

  const sent = await waitForComputerSend(sends, 1);
  expect(sent).toMatchObject({
    prompt: "Open the desktop dashboard",
    computerUseHostId: PRIMARY_HOST_ID,
  });
  expect(sent.cloudBrowserEnabled).toBeUndefined();
});

test("Discover computers that are available for Computer Use", async () => {
  const user = userEvent.setup({ delay: null });
  let hosts: readonly ComputerUseHost[] | null = [
    computerHost({
      id: PRIMARY_HOST_ID,
      displayName: "Studio Mac",
      status: "online",
    }),
    computerHost({
      id: SECONDARY_HOST_ID,
      displayName: "Travel Mac",
      status: "offline",
    }),
  ];
  installRunChat();
  installComputerHosts(() => {
    return hosts;
  });

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyChat();
  await openComputerMenu();
  const hostGroup = await screen.findByRole("group", {
    name: "Computer Use hosts",
  });
  expect(within(hostGroup).getByText("Studio Mac")).toBeVisible();
  expect(within(hostGroup).queryByText("Travel Mac")).toBeNull();
  expect(screen.getByText("Cloud browser")).toBeVisible();
  const studioSwitch = screen.getByRole("switch", {
    name: "Connect Studio Mac",
  });
  expect(studioSwitch).not.toBeChecked();

  await user.click(studioSwitch);
  await expect(
    screen.findByRole("switch", { name: "Disconnect Studio Mac" }),
  ).resolves.toBeChecked();
  hosts = [
    computerHost({
      id: PRIMARY_HOST_ID,
      displayName: "Studio Mac",
      status: "offline",
    }),
    computerHost({
      id: SECONDARY_HOST_ID,
      displayName: "Travel Mac",
      status: "offline",
    }),
  ];
  context.mocks.ably.trigger("computerUseHostsChanged");

  await waitFor(() => {
    expect(screen.getByText("Studio Mac")).toBeVisible();
    expect(screen.getByText("Offline")).toBeVisible();
  });

  hosts = [
    computerHost({
      id: PRIMARY_HOST_ID,
      displayName: "Studio Mac",
      status: "offline",
    }),
    computerHost({
      id: SECONDARY_HOST_ID,
      displayName: "Travel Mac",
      status: "online",
    }),
  ];
  context.mocks.ably.trigger("computerUseHostsChanged");

  await expect(screen.findByText("Travel Mac")).resolves.toBeVisible();
  expect(
    screen.getByRole("switch", { name: "Connect Travel Mac" }),
  ).not.toBeChecked();

  hosts = null;
  context.mocks.ably.trigger("computerUseHostsChanged");

  await expect(screen.findByText("No online computers")).resolves.toBeVisible();
  await expect(findButton("Connect my computer")).resolves.toBeVisible();
});

test("Guide users to the compatible Computer Use app", async () => {
  mockMacUserAgentData("arm");
  installRunChat();

  await setupPage({ context, path: NEW_CHAT_PATH, host: "app.okou.ai" });

  await readyChat();
  const dialog = await openComputerDownloadDialog("Let Okou use your computer");
  expect(dialog).toHaveTextContent(
    "So Okou can work in your browser and apps for you",
  );
  expect(dialog).toHaveTextContent(
    "Requires an Apple silicon Mac with macOS 14 or newer",
  );
  const download = fastControl("link", "Download for macOS", dialog);
  expect(download).toBeVisible();
  expect(download).toHaveAttribute(
    "href",
    expect.stringContaining("/api/desktop/updates/stable/darwin/arm64/dmg"),
  );
});

test("Explain Computer Use incompatibility on an Intel Mac", async () => {
  mockMacUserAgentData("x86_64");
  installRunChat();

  await setupPage({ context, path: NEW_CHAT_PATH, host: "app.okou.ai" });

  await readyChat();
  const dialog = await openComputerDownloadDialog("Let Okou use your computer");
  const incompatibility = fastControl(
    "button",
    "Requires an Apple silicon Mac",
    dialog,
  );
  expect(incompatibility).toBeDisabled();
  expect(dialog).toHaveTextContent("Intel Macs aren't supported");
  expect(
    queryAllByRoleFast("link", dialog).find((link) => {
      return link.textContent?.trim() === "Download for macOS";
    }),
  ).toBeUndefined();
});

async function connectExistingChatComputer() {
  const user = userEvent.setup({ delay: null });
  const sends: CapturedComputerSend[] = [];
  const updates: CapturedComputerUpdate[] = [];
  const externalOrder: string[] = [];
  installRunChat({
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    onComputerUseHostUpdate(body) {
      updates.push(body);
      externalOrder.push(
        `save:${body.computerUseHostId ?? "none"}:${String(body.cloudBrowserEnabled)}`,
      );
    },
    onSendRequest(body) {
      sends.push({
        prompt: body.prompt,
        ...(body.computerUseHostId === undefined
          ? {}
          : { computerUseHostId: body.computerUseHostId }),
        ...(body.cloudBrowserEnabled === undefined
          ? {}
          : { cloudBrowserEnabled: body.cloudBrowserEnabled }),
      });
      externalOrder.push(`send:${body.prompt}`);
    },
  });
  installComputerHosts(() => {
    return [
      computerHost({
        id: PRIMARY_HOST_ID,
        displayName: "Studio Mac",
        status: "online",
      }),
    ];
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await openComputerMenu();
  await user.click(screen.getByRole("switch", { name: "Connect Studio Mac" }));

  await waitFor(() => {
    expect(updates).toHaveLength(1);
  });
  expect(updates[0]).toMatchObject({
    computerUseHostId: PRIMARY_HOST_ID,
    cloudBrowserEnabled: false,
  });
  await expect(
    screen.findByRole("switch", { name: "Disconnect Studio Mac" }),
  ).resolves.toBeChecked();
  return { user, sends, updates, externalOrder };
}

test("Save and retain an existing chat's Computer Use host before sending", async () => {
  const { sends, externalOrder } = await connectExistingChatComputer();
  await sendText("Inspect the desktop report");

  await waitForComputerSend(sends, 1);
  expect(externalOrder.slice(0, 2)).toStrictEqual([
    `save:${PRIMARY_HOST_ID}:false`,
    "send:Inspect the desktop report",
  ]);
  await openComputerMenu();
  const savedHost = await screen.findByRole("switch", {
    name: "Disconnect Studio Mac",
  });
  expect(savedHost).toBeChecked();
});

test("Save an existing chat's Computer Use disconnection before sending", async () => {
  const { user, sends, updates, externalOrder } =
    await connectExistingChatComputer();
  const savedHost = screen.getByRole("switch", {
    name: "Disconnect Studio Mac",
  });
  await user.click(savedHost);

  await waitFor(() => {
    expect(updates).toHaveLength(2);
  });
  expect(updates[1]).toMatchObject({
    computerUseHostId: null,
    cloudBrowserEnabled: false,
  });
  await expect(
    screen.findByRole("switch", { name: "Connect Studio Mac" }),
  ).resolves.not.toBeChecked();

  await sendText("Continue without the desktop");

  const laterSend = await waitForComputerSend(sends, 1);
  expect(externalOrder.at(-2)).toBe("save:none:false");
  expect(externalOrder.at(-1)).toBe("send:Continue without the desktop");
  expect(laterSend.computerUseHostId).toBeUndefined();
  expect(laterSend.cloudBrowserEnabled).toBeUndefined();
});
