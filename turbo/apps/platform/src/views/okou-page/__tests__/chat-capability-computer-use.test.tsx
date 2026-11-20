import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChatLifecycleHelpers } from "./chat-lifecycle-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  assistantEvent,
  createChatRunFixtures,
  NEW_CHAT_PATH,
  promptEvent,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const { mockMacUserAgentData } = createChatLifecycleHelpers(context);
const STUDIO_MAC = "f0000000-0000-4000-8000-000000000a01";
const TRAVEL_MAC = "f0000000-0000-4000-8000-000000000a02";
const EARLIER_RUN_ID = "d0000000-0000-4000-a000-000000000a01";

interface DirectoryHost {
  readonly id: string;
  readonly displayName: string;
  readonly status: "online" | "offline";
}

interface ComputerAccess {
  readonly computerUseHostId: string | null | undefined;
  readonly cloudBrowserEnabled: boolean | undefined;
}

interface SentMessage extends ComputerAccess {
  readonly prompt: string;
}

interface ChatServer {
  sent?: SentMessage;
  saved?: ComputerAccess;
  /** The thread's saved Computer Use choice when the message arrived. */
  savedWhenSent?: ComputerAccess;
}

/** The member's Computer Use directory, read whenever the menu opens. */
function mockComputerDirectory(initial: readonly DirectoryHost[]): {
  hosts: readonly DirectoryHost[];
} {
  const directory = { hosts: initial };
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: directory.hosts.map((host) => {
        return {
          ...host,
          hostName: `${host.displayName.toLowerCase().replace(" ", "-")}.local`,
          lastSeenAt: "2026-11-20T07:55:00.000Z",
        };
      }),
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: [],
      vncHosts: [],
    });
  });
  return directory;
}

function studioMac(status: DirectoryHost["status"] = "online"): DirectoryHost {
  return { id: STUDIO_MAC, displayName: "Studio Mac", status };
}

function travelMac(status: DirectoryHost["status"]): DirectoryHost {
  return { id: TRAVEL_MAC, displayName: "Travel Mac", status };
}

function installChat(
  saved: { computerUseHostId: string | null; cloudBrowserEnabled: boolean } = {
    computerUseHostId: null,
    cloudBrowserEnabled: false,
  },
): ChatServer {
  const server: ChatServer = {};
  installRunChat({
    ...saved,
    chatEvents: [
      promptEvent({
        id: "computer-earlier-user",
        runId: EARLIER_RUN_ID,
        seqId: 1,
        text: "Check the build",
      }),
      assistantEvent({
        id: "computer-earlier-assistant",
        runId: EARLIER_RUN_ID,
        seqId: 2,
        text: "The build is green.",
      }),
    ],
    onComputerUseHostUpdate(body) {
      server.saved = {
        computerUseHostId: body.computerUseHostId,
        cloudBrowserEnabled: body.cloudBrowserEnabled,
      };
    },
    onSendRequest(body) {
      server.savedWhenSent = server.saved;
      server.sent = {
        prompt: body.prompt,
        computerUseHostId: body.computerUseHostId,
        cloudBrowserEnabled: body.cloudBrowserEnabled,
      };
    },
  });
  return server;
}

async function openPage(path: string): Promise<void> {
  await setupPage({ context, path });
  await readyChat();
}

async function openConnectors(): Promise<HTMLElement> {
  click(await findFastControl("button", "Connectors"));
  return await screen.findByRole("dialog", { name: "Connectors" });
}

async function closeConnectors(): Promise<void> {
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Connectors" }),
    ).not.toBeInTheDocument();
  });
}

/** Base UI switches toggle on one complete pointer click. */
async function toggle(control: HTMLElement): Promise<void> {
  await userEvent.setup({ delay: null }).click(control);
}

async function findHosts(menu: HTMLElement): Promise<HTMLElement> {
  return await within(menu).findByRole("group", {
    name: "Computer Use hosts",
  });
}

test("Let the server apply the cloud browser default for an untouched new chat", async () => {
  mockComputerDirectory([studioMac()]);
  const server = installChat();
  await openPage(NEW_CHAT_PATH);

  await sendText("Open the analytics dashboard");

  await expect(
    screen.findByText("Open the analytics dashboard"),
  ).resolves.toBeInTheDocument();
  expect(server.sent).toStrictEqual({
    prompt: "Open the analytics dashboard",
    computerUseHostId: undefined,
    cloudBrowserEnabled: undefined,
  });
});

test("Start a new chat with a selected local computer", async () => {
  const directory = mockComputerDirectory([studioMac()]);
  const server = installChat();
  await openPage(NEW_CHAT_PATH);
  const menu = await openConnectors();
  await toggle(
    within(await findHosts(menu)).getByRole("switch", { name: "Studio Mac" }),
  );
  await waitFor(() => {
    expect(
      within(menu).getByRole("switch", { name: "Studio Mac" }),
    ).toBeChecked();
  });
  await closeConnectors();

  directory.hosts = [];
  const reopened = await openConnectors();

  await expect(
    within(reopened).findByText("No online computers"),
  ).resolves.toBeInTheDocument();
  expect(
    within(reopened).queryByRole("switch", { name: "Studio Mac" }),
  ).not.toBeInTheDocument();
  expect(
    within(reopened).getByRole("switch", { name: "Cloud browser" }),
  ).not.toBeChecked();
  await closeConnectors();

  await sendText("Open the design file on my Mac");

  await waitFor(() => {
    expect(server.sent).toStrictEqual({
      prompt: "Open the design file on my Mac",
      computerUseHostId: STUDIO_MAC,
      cloudBrowserEnabled: false,
    });
  });
});

test("Discover computers that are available for Computer Use", async () => {
  const directory = mockComputerDirectory([studioMac(), travelMac("offline")]);
  installChat();
  await openPage(NEW_CHAT_PATH);
  const menu = await openConnectors();
  const hosts = await findHosts(menu);

  expect(
    within(hosts)
      .getAllByRole("switch")
      .map((host) => {
        return host.closest("label")?.textContent;
      }),
  ).toStrictEqual(["Studio Mac"]);
  expect(within(menu).queryByText("Travel Mac")).not.toBeInTheDocument();

  await toggle(within(hosts).getByRole("switch", { name: "Studio Mac" }));
  await waitFor(() => {
    expect(
      within(menu).getByRole("switch", { name: "Studio Mac" }),
    ).toBeChecked();
  });
  await closeConnectors();

  directory.hosts = [studioMac(), travelMac("online")];
  const reopened = await openConnectors();

  await expect(
    within(reopened).findByRole("switch", { name: "Travel Mac" }),
  ).resolves.not.toBeChecked();
  expect(
    within(reopened).getByRole("switch", { name: "Studio Mac" }),
  ).toBeChecked();
});

test("Explain Computer Use incompatibility on an Intel Mac", async () => {
  mockMacUserAgentData("x86");
  mockComputerDirectory([]);
  installChat();
  await openPage(NEW_CHAT_PATH);
  await openConnectors();

  click(await findFastControl("button", "Connect my computer"));

  const guide = await screen.findByRole("dialog", {
    name: "Install and sign in",
  });
  await expect(
    findFastControl("button", "Requires an Apple silicon Mac", guide),
  ).resolves.toBeDisabled();
  expect(
    within(guide).getByText(
      "Requires an Apple silicon Mac with macOS 14 or newer. Intel Macs aren't supported.",
    ),
  ).toBeInTheDocument();
  expect(queryFastControl("link", "Download for macOS", guide)).toBeNull();
});

test("Save and retain an existing chat's Computer Use host before sending", async () => {
  mockComputerDirectory([studioMac()]);
  const server = installChat();
  await openPage(RUN_PATH);
  const menu = await openConnectors();
  await toggle(
    within(await findHosts(menu)).getByRole("switch", { name: "Studio Mac" }),
  );
  await closeConnectors();
  // Connecting finishes once the thread's choice reaches the server.
  await waitFor(() => {
    expect(server.saved).toStrictEqual({
      computerUseHostId: STUDIO_MAC,
      cloudBrowserEnabled: false,
    });
  });

  await sendText("Use the Studio Mac for this");

  await expect(
    screen.findByText("Use the Studio Mac for this"),
  ).resolves.toBeInTheDocument();
  expect(server.savedWhenSent).toStrictEqual({
    computerUseHostId: STUDIO_MAC,
    cloudBrowserEnabled: false,
  });
  const reopened = await openConnectors();
  await expect(
    within(reopened).findByRole("switch", { name: "Studio Mac" }),
  ).resolves.toBeChecked();
});

test("Save an existing chat's Computer Use disconnection before sending", async () => {
  mockComputerDirectory([studioMac()]);
  const server = installChat({
    computerUseHostId: STUDIO_MAC,
    cloudBrowserEnabled: false,
  });
  await openPage(RUN_PATH);
  const menu = await openConnectors();
  const studio = within(await findHosts(menu)).getByRole("switch", {
    name: "Studio Mac",
  });
  await waitFor(() => {
    expect(studio).toBeChecked();
  });
  await toggle(studio);
  await closeConnectors();
  // Disconnecting finishes once the thread's choice reaches the server.
  await waitFor(() => {
    expect(server.saved).toStrictEqual({
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });

  await sendText("Continue without my computer");

  await expect(
    screen.findByText("Continue without my computer"),
  ).resolves.toBeInTheDocument();
  expect(server.savedWhenSent).toStrictEqual({
    computerUseHostId: null,
    cloudBrowserEnabled: false,
  });
  expect(server.sent).toStrictEqual({
    prompt: "Continue without my computer",
    computerUseHostId: undefined,
    cloudBrowserEnabled: undefined,
  });
});
