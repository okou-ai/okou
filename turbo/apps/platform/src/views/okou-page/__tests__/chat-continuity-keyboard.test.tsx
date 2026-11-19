import { chatThreadRenameContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

function threadContainer(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!container) {
    throw new Error(`Expected chat pane ${threadId}`);
  }
  return container;
}

function composerIn(threadId: string): HTMLElement {
  const composer = threadContainer(threadId).querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Message"]',
  );
  if (!composer) {
    throw new Error(`Expected composer for ${threadId}`);
  }
  return composer;
}

test("Moving to a newer chat from the main composer keeps the side pane", async () => {
  const user = userEvent.setup({ delay: null });
  const current = continuityThread(16, 2, "Current keyboard chat");
  const side = continuityThread(16, 3, "Side keyboard chat");
  const newest = continuityThread(16, 4, "Newest neighboring chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 16,
    threads: [current, side, newest],
  });
  await setupPage({
    context,
    path: `/chats/${current.id}?sidebar=${side.id}`,
    locale: "en-US",
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(composerIn(current.id)).toBeVisible();
    expect(composerIn(side.id)).toBeVisible();
  });
  const mainComposer = composerIn(current.id);
  mainComposer.focus();
  expect(mainComposer).toHaveFocus();

  await user.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");

  await waitFor(() => {
    expect(threadContainer(newest.id)).toBeVisible();
    expect(continuitySidebarLink(newest.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(threadContainer(side.id)).toBeVisible();
  expect(threadContainer(side.id)).toHaveTextContent("Side keyboard chat");
});

test("Icon shortcuts add and remove the focused main chat's checkmark", async () => {
  const current = continuityThread(18, 1, "Project plan");
  const emojiOnlySide = continuityThread(18, 2, "❓");
  const workspace = installContinuityWorkspace(context, {
    caseId: 18,
    threads: [current, emojiOnlySide],
  });
  const renameRequests: { threadId: string; title: string }[] = [];
  context.mocks.api(
    chatThreadRenameContract.rename,
    ({ body, params, respond }) => {
      renameRequests.push({ threadId: params.id, title: body.title });
      return respond(204);
    },
  );
  await setupPage({
    context,
    path: `/chats/${current.id}?sidebar=${emojiOnlySide.id}`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(composerIn(current.id)).toBeVisible();
    expect(composerIn(emojiOnlySide.id)).toBeVisible();
  });
  const currentLink = continuitySidebarLink(current.id);

  composerIn(current.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}1{/Shift}{/Control}");
  await waitFor(() => {
    expect(renameRequests.at(-1)).toStrictEqual({
      threadId: current.id,
      title: "✅ Project plan",
    });
    expect(currentLink).toHaveTextContent("✅ Project plan");
  });
  expect(screen.queryByLabelText("Search emoji")).toBeNull();

  composerIn(current.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}0{/Shift}{/Control}");
  await waitFor(() => {
    expect(renameRequests.at(-1)).toStrictEqual({
      threadId: current.id,
      title: "Project plan",
    });
    expect(currentLink).toHaveTextContent(/^Project plan$/u);
  });
  expect(screen.queryByLabelText("Search emoji")).toBeNull();
});
