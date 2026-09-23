import {
  computerUseHostsContract,
  type ComputerUseHost,
} from "@okouai/api-contracts/contracts/computer-use";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  startPage,
} from "../../../__tests__/page-helper.ts";
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
    screen.getByRole("switch", { name: "Cloud browser", checked: true }),
  ).toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Studio Mac", checked: false }),
  ).not.toBeChecked();
});

test("Choose and clear a computer through its row and switch keyboard controls", async () => {
  const user = userEvent.setup({ delay: null });
  installNewComputerChat(
    [],
    [
      computerHost({
        id: PRIMARY_HOST_ID,
        displayName: "Studio Mac",
        status: "online",
      }),
      computerHost({
        id: SECONDARY_HOST_ID,
        displayName: "Travel Mac",
        status: "online",
      }),
    ],
  );
  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await openComputerMenu();

  await user.click(screen.getByText("Studio Mac"));
  const studio = await screen.findByRole("switch", {
    name: "Studio Mac",
    checked: true,
  });
  expect(studio).toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Cloud browser", checked: false }),
  ).not.toBeChecked();

  await user.click(screen.getByText("Travel Mac"));
  const travel = await screen.findByRole("switch", {
    name: "Travel Mac",
    checked: true,
  });
  expect(travel).toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Studio Mac", checked: false }),
  ).not.toBeChecked();
  expect(travel).toHaveFocus();

  await user.keyboard(" ");
  expect(travel).not.toBeChecked();
  await user.keyboard("{Enter}");
  expect(travel).toBeChecked();

  await user.click(screen.getByText("Cloud browser"));
  const cloudBrowser = await screen.findByRole("switch", {
    name: "Cloud browser",
    checked: true,
  });
  expect(cloudBrowser).toBeChecked();
  expect(travel).not.toBeChecked();
  expect(cloudBrowser).toHaveFocus();
  await user.keyboard(" ");
  expect(cloudBrowser).not.toBeChecked();
  await user.keyboard("{Enter}");
  expect(cloudBrowser).toBeChecked();
  expect(queryButton("Connect my computer")).toBeInTheDocument();
});

test("Ignore the Cloud browser row while its saved default is loading", async () => {
  const preferences = context.mocks.deferred<void>();
  installNewComputerChat([], []);
  context.mocks.api(
    userPreferencesContract.get,
    async ({ respond, withSignal }) => {
      await withSignal(preferences.promise);
      return respond(200, {
        timezone: "UTC",
        locale: "en-US",
        supportedLocales: ["en-US"],
        pinnedAgentIds: [],
        sendMode: "enter",
        cloudBrowserEnabledByDefault: true,
        theme: "system",
        colorTheme: null,
        captureNetworkBodiesRemaining: 0,
        voiceInputModel: null,
      });
    },
  );
  const page = await startPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatPreference]: true },
  });
  await page.content;
  await openComputerMenu();
  const cloudBrowser = await screen.findByRole("switch", {
    name: "Cloud browser",
    checked: true,
  });
  expect(cloudBrowser).toHaveAttribute("aria-disabled", "true");

  click(screen.getByText("Cloud browser"));
  preferences.resolve();
  await page.ready;
  await waitFor(() => {
    expect(cloudBrowser).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(cloudBrowser).toBeChecked();

  click(screen.getByText("Cloud browser"));
  await expect(
    screen.findByRole("switch", { name: "Cloud browser", checked: false }),
  ).resolves.not.toBeChecked();
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
    name: "Cloud browser",
    checked: true,
  });
  expect(cloudBrowser).toBeChecked();

  await user.click(cloudBrowser);

  const disabledCloudBrowser = await screen.findByRole("switch", {
    name: "Cloud browser",
    checked: false,
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
    screen.getByRole("switch", { name: "Cloud browser", checked: false }),
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
    name: "Studio Mac",
    checked: false,
  });

  await user.click(localComputer);

  await expect(
    screen.findByRole("switch", { name: "Studio Mac", checked: true }),
  ).resolves.toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Cloud browser", checked: false }),
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
    name: "Studio Mac",
    checked: false,
  });
  expect(studioSwitch).not.toBeChecked();

  await user.click(studioSwitch);
  await expect(
    screen.findByRole("switch", { name: "Studio Mac", checked: true }),
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
    screen.getByRole("switch", { name: "Travel Mac", checked: false }),
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
  await user.click(
    screen.getByRole("switch", { name: "Studio Mac", checked: false }),
  );

  await waitFor(() => {
    expect(updates).toHaveLength(1);
  });
  expect(updates[0]).toMatchObject({
    computerUseHostId: PRIMARY_HOST_ID,
    cloudBrowserEnabled: false,
  });
  await expect(
    screen.findByRole("switch", { name: "Studio Mac", checked: true }),
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
    name: "Studio Mac",
    checked: true,
  });
  expect(savedHost).toBeChecked();
});

test("Save an existing chat's Computer Use disconnection before sending", async () => {
  const { user, sends, updates, externalOrder } =
    await connectExistingChatComputer();
  const savedHost = screen.getByRole("switch", {
    name: "Studio Mac",
    checked: true,
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
    screen.findByRole("switch", { name: "Studio Mac", checked: false }),
  ).resolves.not.toBeChecked();

  await sendText("Continue without the desktop");

  const laterSend = await waitForComputerSend(sends, 1);
  expect(externalOrder.at(-2)).toBe("save:none:false");
  expect(externalOrder.at(-1)).toBe("send:Continue without the desktop");
  expect(laterSend.computerUseHostId).toBeUndefined();
  expect(laterSend.cloudBrowserEnabled).toBeUndefined();
});
