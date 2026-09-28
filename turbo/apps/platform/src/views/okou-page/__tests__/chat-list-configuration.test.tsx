import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";

const context = testContext();
const HOST_ID = "a7000000-0000-4000-a000-000000000001";

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

  const page = await startPage({
    context,
    path: `/chats/${thread.id}`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(2, [thread]),
  });

  await openComputerMenu();
  const selectedHost = await screen.findByRole("switch", {
    name: "Studio Mac",
    checked: true,
  });
  expect(selectedHost).toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Cloud browser", checked: false }),
  ).not.toBeChecked();
  remote.resolve();
  await page.ready;

  await openComputerMenu();
  const enabledCloudBrowser = await screen.findByRole("switch", {
    name: "Cloud browser",
    checked: true,
  });
  expect(enabledCloudBrowser).toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Studio Mac", checked: false }),
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
      chatListEvent(4, 5, "image_model_updated", threadId, {
        selectedImageModel: "gpt-image-2",
        createdAt: "2026-08-01T02:00:05.000Z",
      }),
      chatListEvent(4, 6, "created", threadId, {
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
    name: "Studio Mac",
    checked: true,
  });
  expect(configuredHost).toBeChecked();
});

test.each([
  { control: "model menu", panel: false, surface: "menu" as const },
  { control: "model panel", panel: true, surface: "dialog" as const },
])(
  "A thread's stored image model never appears in the $control",
  async ({ panel, surface }) => {
    const auth = chatListAuth(6);
    const thread = chatListThread(38, "Pinned image model", {
      selectedModel: "claude-sonnet-5",
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
      featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: panel },
    });

    // The menu's trigger names the model; the panel's adds the effort.
    const trigger = await waitFor(() => {
      const button = queryAllByRoleFast("button").find((candidate) => {
        return candidate
          .getAttribute("aria-label")
          ?.startsWith("Claude Sonnet 5");
      });
      if (!button) {
        throw new Error("The composer model trigger is not visible");
      }
      return button;
    });
    click(trigger);
    const models = await screen.findByRole(surface, { name: "Chat models" });
    // Images follow the member's settings: the control lists chat models only
    // and never names the thread's stored image model.
    expect(queryAllByRoleFast("menuitem", models)).toHaveLength(0);
    expect(document.body).not.toHaveTextContent("GPT Image");
    expect(document.body).not.toHaveTextContent("Images use");
  },
);

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
    name: "Studio Mac",
    checked: false,
  });
  expect(disconnectedHost).not.toBeChecked();
  remote.resolve();
  await page.ready;

  await expectSelectedModel("GPT 5.6 Sol Fast");
  await openComputerMenu();
  const connectedHost = await screen.findByRole("switch", {
    name: "Studio Mac",
    checked: true,
  });
  expect(connectedHost).toBeChecked();
  expect(sidebarThreadTitles()).toStrictEqual(order);
});
