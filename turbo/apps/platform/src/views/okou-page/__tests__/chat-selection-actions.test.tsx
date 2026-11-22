import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, fill, click } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { RUN_THREAD_ID, RUN_PATH } from "./chat-run-test-fixtures.ts";
import {
  completedConversation,
  feedbackItems,
  findButton,
  selectPassage,
  clearPassageSelection,
} from "./chat-capability-test-helpers.ts";

import { findComposerEditor } from "./chat-composer-test-helpers.ts";
const context = testContext();
const passage = "The launch plan has three careful stages.";
async function conversation() {
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: completedConversation(passage),
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText(passage);
}
test("chat-selection-actions-001 quoting after a rename preserves the unfinished draft", async () => {
  await conversation();
  const editor = await findComposerEditor();
  await fill(editor, "Keep this outline");
  editor.focus();
  await userEvent.keyboard("{F2}");
  const form = await screen.findByRole("dialog");
  const title = within(form).getByRole("textbox");
  await fill(title, "Launch review");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(
      screen.getAllByText("Launch review", { exact: true }).some((element) => {
        return element.closest("nav") === null;
      }),
    ).toBeTruthy();
  });
  await selectPassage(passage);
  click(await findButton("Quote"));
  await screen.findByRole("textbox", { name: "Ask or comment on this quote" });
  expect(editor).toHaveTextContent("Keep this outline");
  expect(feedbackItems()).toHaveLength(1);
  expect(feedbackItems()[0]).toHaveTextContent(passage);
});
async function releaseSelection(name: string) {
  await selectPassage(passage);
  const action = await findButton(name);
  fireEvent.pointerDown(action, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    pointerType: "mouse",
  });
  clearPassageSelection();
  fireEvent.pointerUp(action, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    pointerType: "mouse",
  });
  click(action);
}
test("chat-selection-actions-002 Copy keeps the selected passage through native selection collapse", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await conversation();
  await releaseSelection("Copy");
  await screen.findByText("Copied");
  expect(clipboard.writes).toContain(passage);
  expect(document.querySelector("[aria-keyshortcuts=q]")).toBeNull();
});
test("chat-selection-actions-004 Fork carries the original passage after pointer release clears selection", async () => {
  await conversation();
  await releaseSelection("Fork");
  const dialog = await screen.findByRole("dialog", { name: "Okou" });
  expect(within(dialog).getByText(passage)).toBeInTheDocument();
  expect(document.querySelector("[aria-keyshortcuts=q]")).toBeNull();
});
