import { screen, waitFor, within } from "@testing-library/react";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  cachedChatListEvents,
  chatListAuth,
  chatListEvent,
  chatListThread,
  chatListThreadId,
  fastButton,
  installActiveChatBoundaries,
  installChatListAgent,
  installChatListModelPolicies,
  installChatListStream,
  onlineComputerUseHost,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import {
  composerModelTrigger,
  composerModelTriggerIn,
} from "./chat-composer-test-helpers.ts";

const context = testContext();
const HOST_ID = "a7000000-0000-4000-a000-000000000001";

async function openMediaCategory(
  name: "Image" | "Video",
): Promise<HTMLElement> {
  if (!screen.queryByRole("tablist", { name: "Models" })) {
    click(await waitFor(composerModelTriggerOrThrow));
  }
  const types = await screen.findByRole("tablist", { name: "Models" });
  const type = queryAllByRoleFast("tab", types).find((candidate) => {
    return candidate.textContent?.startsWith(name);
  });
  if (!type) {
    throw new Error(`${name} models are not on the flyout's type rail`);
  }
  click(type);
  return await screen.findByRole("listbox", { name: `${name} models` });
}

/**
 * A row reads as its model followed by a price tier. Compare the complete model
 * name so models with a shared prefix remain distinct.
 */
function expectSelectedMediaModel(panel: HTMLElement, label: string): void {
  const row = within(panel)
    .getAllByRole("option")
    .find((option) => {
      return option.textContent?.replace(/\$+$/u, "").trim() === label;
    });
  if (!row) {
    throw new Error(`Expected a ${label} row in the open model panel`);
  }
  expect(row).toHaveAttribute("aria-selected", "true");
}

function composerModelTriggerOrThrow(): HTMLElement {
  const trigger = composerModelTriggerIn(document);
  if (!trigger) {
    throw new Error("The composer model trigger is not visible");
  }
  return trigger;
}

function computerMenuIsOpen(): boolean {
  return queryAllByRoleFast("button", document).some((candidate) => {
    return (
      candidate.textContent?.replace(/\s+/gu, " ").trim() ===
      "Connect my computer"
    );
  });
}

async function openComputerMenu(): Promise<void> {
  if (!computerMenuIsOpen()) {
    click(
      await waitFor(() => {
        return fastButton("Connectors");
      }),
    );
  }
  await waitFor(() => {
    expect(fastButton("Connect my computer")).toBeVisible();
  });
}

async function expectSelectedModel(modelLabel: string): Promise<void> {
  await expect(composerModelTrigger(modelLabel)).resolves.toBeVisible();
}

async function findThreadLink(threadId: string): Promise<HTMLAnchorElement> {
  return await waitFor(() => {
    const link = sidebarThreadLinks().find((candidate) => {
      return candidate.dataset.sidebarChatThreadId === threadId;
    });
    if (!link) {
      throw new Error(`Conversation ${threadId} not found in the sidebar`);
    }
    return link;
  });
}

test("Enabling cloud browser replaces the Computer Use host", async () => {
  const auth = chatListAuth(2);
  const thread = chatListThread(36, "Hosted conversation", {
    computerUseHostId: HOST_ID,
  });
  const remote = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListModelPolicies(context);
  installChatListStream(context, {
    caseId: 2,
    snapshot: [thread],
    events: [
      chatListEvent(2, 2, "computer_use_host_updated", thread.id, {
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      }),
    ],
    remoteGate: remote.promise,
  });
  installActiveChatBoundaries(context, {
    metadata: thread,
    hosts: [onlineComputerUseHost(HOST_ID)],
  });
  context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [onlineComputerUseHost(HOST_ID)] });
  });

  const page = await startPage({
    context,
    path: `/chats/${thread.id}`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(2, [thread]),
  });

  await openComputerMenu();
  const selectedHost = await screen.findByRole("switch", {
    name: "Disconnect Studio Mac",
  });
  expect(selectedHost).toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Enable Cloud browser" }),
  ).not.toBeChecked();
  remote.resolve();
  await page.ready;

  await openComputerMenu();
  const enabledCloudBrowser = await screen.findByRole("switch", {
    name: "Disable Cloud browser",
  });
  expect(enabledCloudBrowser).toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Connect Studio Mac" }),
  ).not.toBeChecked();
});

test("Conversation configuration arriving before creation is retained", async () => {
  const auth = chatListAuth(4);
  const threadId = chatListThreadId(37);
  const host = onlineComputerUseHost(HOST_ID);
  installChatListAgent(context);
  installChatListModelPolicies(context);
  installChatListStream(context, {
    caseId: 4,
    snapshot: [],
    events: [
      chatListEvent(4, 2, "model_selection_updated", threadId, {
        selectedModel: "gpt-5.6-sol",
        createdAt: "2026-08-01T02:00:02.000Z",
      }),
      chatListEvent(4, 3, "service_tier_updated", threadId, {
        serviceTier: "priority",
        createdAt: "2026-08-01T02:00:03.000Z",
      }),
      chatListEvent(4, 4, "computer_use_host_updated", threadId, {
        computerUseHostId: HOST_ID,
        cloudBrowserEnabled: false,
        createdAt: "2026-08-01T02:00:04.000Z",
      }),
      chatListEvent(4, 5, "video_model_updated", threadId, {
        selectedVideoModel: "MiniMax-H3",
        createdAt: "2026-08-01T02:00:05.000Z",
      }),
      chatListEvent(4, 6, "image_model_updated", threadId, {
        selectedImageModel: "gpt-image-2",
        createdAt: "2026-08-01T02:00:06.000Z",
      }),
      chatListEvent(4, 7, "created", threadId, {
        title: "Out-of-order configuration",
        selectedModel: "deepseek-v4-flash",
        createdAt: "2026-08-01T02:00:00.000Z",
      }),
    ],
  });
  installActiveChatBoundaries(context, { hosts: [host] });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Out-of-order configuration"]);
  });
  expect(sidebarThreadLinks()).toHaveLength(1);
  click(await findThreadLink(threadId));

  await expectSelectedModel("GPT 5.6 Sol Fast");
  await openComputerMenu();
  const configuredHost = await screen.findByRole("switch", {
    name: "Disconnect Studio Mac",
  });
  expect(configuredHost).toBeChecked();

  expectSelectedMediaModel(await openMediaCategory("Image"), "GPT Image 2");
  expectSelectedMediaModel(await openMediaCategory("Video"), "MiniMax H3");
});

test("Media models do not overwrite one another or the run model", async () => {
  const auth = chatListAuth(6);
  const thread = chatListThread(38, "Independent media models", {
    selectedModel: "claude-sonnet-4-6",
    selectedVideoModel: "MiniMax-H3",
    selectedImageModel: "gpt-image-1",
  });
  installChatListAgent(context);
  installChatListModelPolicies(context);
  installChatListStream(context, {
    caseId: 6,
    snapshot: [thread],
    events: [
      chatListEvent(6, 2, "image_model_updated", thread.id, {
        selectedImageModel: "gpt-image-2",
      }),
    ],
  });
  installActiveChatBoundaries(context, { metadata: thread });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(6, [thread]),
  });

  await expectSelectedModel("Claude Sonnet 4.6");
  expectSelectedMediaModel(await openMediaCategory("Image"), "GPT Image 2");
  expectSelectedMediaModel(await openMediaCategory("Video"), "MiniMax H3");
  // Picking either media model must leave the run model where it was.
  await expect(
    composerModelTrigger("Claude Sonnet 4.6"),
  ).resolves.toBeVisible();
});

test("Service tier and Computer Use settings update independently", async () => {
  const auth = chatListAuth(14);
  const target = chatListThread(43, "Configured conversation", {
    selectedModel: "gpt-5.6-sol",
  });
  const newer = chatListThread(44, "Newer conversation");
  const remote = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListModelPolicies(context);
  installChatListStream(context, {
    caseId: 14,
    snapshot: [target, newer],
    events: [
      chatListEvent(14, 2, "service_tier_updated", target.id, {
        serviceTier: "priority",
      }),
      chatListEvent(14, 3, "computer_use_host_updated", target.id, {
        computerUseHostId: HOST_ID,
        cloudBrowserEnabled: false,
      }),
    ],
    remoteGate: remote.promise,
  });
  installActiveChatBoundaries(context, {
    metadata: target,
    hosts: [onlineComputerUseHost(HOST_ID)],
  });

  const page = await startPage({
    context,
    path: `/chats/${target.id}`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(14, [target, newer]),
  });

  const order = ["Newer conversation", "Configured conversation"];
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(order);
  });
  await expectSelectedModel("GPT 5.6 Sol");
  await openComputerMenu();
  const disconnectedHost = await screen.findByRole("switch", {
    name: "Connect Studio Mac",
  });
  expect(disconnectedHost).not.toBeChecked();
  remote.resolve();
  await page.ready;

  await expectSelectedModel("GPT 5.6 Sol Fast");
  await openComputerMenu();
  const connectedHost = await screen.findByRole("switch", {
    name: "Disconnect Studio Mac",
  });
  expect(connectedHost).toBeChecked();
  expect(sidebarThreadTitles()).toStrictEqual(order);
});
