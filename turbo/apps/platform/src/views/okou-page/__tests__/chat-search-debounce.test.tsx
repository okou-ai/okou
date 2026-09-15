import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { chatSearchContract } from "@okouai/api-contracts/contracts/chat-threads";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
} from "./chat-list-test-helpers.ts";

const context = testContext();
const SEARCH_LABEL = "Search workspace...";
const SEARCH_BUTTON_LABEL = "Search workspace";
const THREAD_TITLE = "Workspace notes";

async function openSearch() {
  const searchButton = await screen.findByLabelText(SEARCH_BUTTON_LABEL, {
    selector: "button",
  });
  click(searchButton);
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  return {
    dialog,
    search: within(dialog).getByPlaceholderText(SEARCH_LABEL),
  };
}

function installMessageSearch(threadId: string): string[] {
  const keywords: string[] = [];
  context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
    keywords.push(query.keyword);
    return respond(200, {
      results: [
        {
          chatThreadId: threadId,
          agentName: "Support Agent",
          matchedMessage: {
            chatThreadId: threadId,
            role: "user",
            content: query.keyword,
            createdAt: "2026-08-01T01:00:00.000Z",
            seqId: 1,
            runId: null,
          },
          matchedRanges: [{ start: 0, end: query.keyword.length }],
        },
      ],
    });
  });
  return keywords;
}

test("Search messages only after the latest input settles", async () => {
  const thread = chatListThread(1, THREAD_TITLE);
  const remoteChatList = context.mocks.deferred<void>();
  const workspace = installContinuityWorkspace(context, {
    caseId: 37,
    threads: [thread],
    chatListRemoteGate: remoteChatList.promise,
  });
  const keywords = installMessageSearch(thread.id);
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    ...workspace.pageOptions,
  });
  const chatThreads = await screen.findByLabelText("Chat threads");
  await within(chatThreads).findByText(THREAD_TITLE);
  expect(remoteChatList.settled()).toBeFalsy();
  const { dialog, search } = await openSearch();

  for (const value of ["3", "32", "320", "3205", "32059"]) {
    fireEvent.change(search, { target: { value } });
    expect(search).toHaveValue(value);
  }

  await expect(within(dialog).findByText("32059")).resolves.toBeInTheDocument();
  expect(keywords).toStrictEqual(["32059"]);
});

test("Clearing or closing search discards a pending message search", async () => {
  const thread = chatListThread(1, THREAD_TITLE);
  const remoteChatList = context.mocks.deferred<void>();
  const workspace = installContinuityWorkspace(context, {
    caseId: 38,
    threads: [thread],
    chatListRemoteGate: remoteChatList.promise,
  });
  const keywords = installMessageSearch(thread.id);
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    ...workspace.pageOptions,
  });
  const chatThreads = await screen.findByLabelText("Chat threads");
  await within(chatThreads).findByText(THREAD_TITLE);
  expect(remoteChatList.settled()).toBeFalsy();
  const { dialog, search } = await openSearch();

  fireEvent.change(search, { target: { value: "discarded" } });
  fireEvent.change(search, { target: { value: "" } });
  expect(search).toHaveValue("");
  await expect(
    within(dialog).findByText(THREAD_TITLE),
  ).resolves.toBeInTheDocument();

  await fill(search, "issue");
  await expect(within(dialog).findByText("issue")).resolves.toBeInTheDocument();
  expect(keywords).not.toContain("discarded");

  fireEvent.change(search, { target: { value: "dismissed" } });
  fireEvent.keyDown(search, { key: "Escape", code: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: SEARCH_LABEL })).toBeNull();
  });

  const reopened = await openSearch();
  expect(reopened.search).toHaveValue("");
  await fill(reopened.search, "budget");
  await expect(
    within(reopened.dialog).findByText("budget"),
  ).resolves.toBeInTheDocument();
  expect(keywords).not.toContain("dismissed");
});
