import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  cachedChatListEvents,
  chatListAuth,
  chatListThread,
  installActiveChatBoundaries,
  installChatListAgent,
  installChatListRunModels,
  installChatListStream,
} from "./chat-list-test-helpers.ts";

const context = testContext();

const UP = "{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}";
const DOWN = "{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}";

function installChatList(
  caseId: number,
  threads: readonly ReturnType<typeof chatListThread>[],
): void {
  installChatListAgent(context);
  // My Okou's New chat page chats with the default agent.
  context.mocks.data.onboardingStatus({ defaultAgentId: CHAT_LIST_AGENT_ID });
  installChatListRunModels(context);
  installChatListStream(context, { caseId, snapshot: threads });
  installActiveChatBoundaries(context);
}

function messageComposerIn(threadId: string): HTMLElement {
  const container = document.querySelector(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  const composer = container?.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Message"]',
  );
  if (!composer) {
    throw new Error(`Expected the composer of chat ${threadId}`);
  }
  return composer;
}

test("Without For you, the first chat moves up to New chat and New chat moves down into the list", async () => {
  const user = userEvent.setup({ delay: null });
  const caseId = 802;
  const older = chatListThread(1, "Older chat");
  const newest = chatListThread(2, "Newest chat");
  installChatList(caseId, [older, newest]);

  await setupPage({
    context,
    path: `/chats/${newest.id}`,
    auth: chatListAuth(caseId),
    cachedChatThreadEvents: cachedChatListEvents(caseId, [older, newest]),
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: false,
    },
  });
  await waitFor(() => {
    expect(messageComposerIn(newest.id)).toBeVisible();
  });

  await user.keyboard(UP);
  await waitFor(() => {
    expect(window.location.pathname).toBe("/");
  });

  await user.keyboard(DOWN);
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${newest.id}`);
  });
});

test("The side pane moves only between chats and never onto the entries", async () => {
  const user = userEvent.setup({ delay: null });
  const caseId = 803;
  const older = chatListThread(1, "Older chat");
  const middle = chatListThread(2, "Middle chat");
  const newest = chatListThread(3, "Newest chat");
  installChatList(caseId, [older, middle, newest]);

  await setupPage({
    context,
    path: `/chats/${older.id}?sidebar=${newest.id}`,
    auth: chatListAuth(caseId),
    cachedChatThreadEvents: cachedChatListEvents(caseId, [
      older,
      middle,
      newest,
    ]),
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
    },
  });
  const sideComposer = await waitFor(() => {
    return messageComposerIn(newest.id);
  });
  await user.click(sideComposer);

  await user.keyboard(UP);
  await user.keyboard(DOWN);

  await waitFor(() => {
    expect(new URLSearchParams(window.location.search).get("sidebar")).toBe(
      middle.id,
    );
  });
  expect(window.location.pathname).toBe(`/chats/${older.id}`);
});
