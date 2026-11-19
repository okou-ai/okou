import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import userEvent from "@testing-library/user-event";

import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
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
  installChatListRunModels,
  installChatListStream,
  onlineComputerUseHost,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();

const STUDIO_MAC_ID = "c8000000-0000-4000-a000-000000000001";

async function computerHostSwitch(name: string): Promise<HTMLElement> {
  click(fastButton("Connectors"));
  const hosts = await screen.findByRole("group", {
    name: "Computer Use hosts",
  });
  return within(hosts).getByRole("switch", { name });
}

async function closeConnectors(): Promise<void> {
  const hosts = screen.getByRole("group", { name: "Computer Use hosts" });
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    expect(hosts).not.toBeInTheDocument();
  });
}

test("Conversation configuration arriving before creation is retained", async () => {
  const caseId = 702;
  const threadId = chatListThreadId(1);
  installChatListAgent(context);
  installChatListRunModels(context);
  installChatListStream(context, {
    caseId,
    snapshot: [],
    events: [
      chatListEvent(caseId, 2, "model_selection_updated", threadId, {
        selectedModel: "gpt-5.6-sol",
      }),
      chatListEvent(caseId, 3, "service_tier_updated", threadId, {
        serviceTier: "priority",
      }),
      chatListEvent(caseId, 4, "computer_use_host_updated", threadId, {
        computerUseHostId: STUDIO_MAC_ID,
      }),
      // The server authored creation first, but its event reaches the
      // stream after the configuration changes.
      chatListEvent(caseId, 5, "created", threadId, {
        title: "Configured conversation",
        selectedModel: "deepseek-v4-flash",
        createdAt: "2026-08-01T01:00:01.000Z",
      }),
    ],
  });
  installActiveChatBoundaries(context, {
    hosts: [onlineComputerUseHost(STUDIO_MAC_ID)],
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: chatListAuth(caseId),
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Configured conversation"]);
  });
  click(sidebarThreadLinks()[0]!);

  await expect(
    composerModelTrigger("GPT 5.6 Sol, Max, Fast"),
  ).resolves.toBeVisible();
  const studioMac = await computerHostSwitch("Studio Mac");
  expect(studioMac).toBeChecked();
});

test("Service tier and Computer Use settings update independently", async () => {
  const caseId = 703;
  const configured = chatListThread(1, "Configured conversation", {
    selectedModel: "gpt-5.6-sol",
  });
  const newer = chatListThread(2, "Newer conversation");
  const remoteGate = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListRunModels(context);
  installChatListStream(context, {
    caseId,
    snapshot: [configured, newer],
    events: [
      chatListEvent(caseId, 2, "service_tier_updated", configured.id, {
        serviceTier: "priority",
      }),
      chatListEvent(caseId, 3, "computer_use_host_updated", configured.id, {
        computerUseHostId: STUDIO_MAC_ID,
      }),
    ],
    remoteGate: remoteGate.promise,
  });
  installActiveChatBoundaries(context, {
    hosts: [onlineComputerUseHost(STUDIO_MAC_ID)],
  });

  await startPage({
    context,
    path: `/chats/${configured.id}`,
    auth: chatListAuth(caseId),
    cachedChatThreadEvents: cachedChatListEvents(caseId, [configured, newer]),
  });

  const before = await composerModelTrigger("GPT 5.6 Sol");
  expect(before).toHaveAttribute("aria-label", "GPT 5.6 Sol, Max");
  await expect(computerHostSwitch("Studio Mac")).resolves.not.toBeChecked();
  await closeConnectors();
  expect(sidebarThreadTitles()).toStrictEqual([
    "Newer conversation",
    "Configured conversation",
  ]);

  remoteGate.resolve();

  await expect(
    composerModelTrigger("GPT 5.6 Sol, Max, Fast"),
  ).resolves.toBeVisible();
  await expect(computerHostSwitch("Studio Mac")).resolves.toBeChecked();
  expect(sidebarThreadTitles()).toStrictEqual([
    "Newer conversation",
    "Configured conversation",
  ]);
});
