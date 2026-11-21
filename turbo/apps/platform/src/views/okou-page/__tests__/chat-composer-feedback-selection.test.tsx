import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import {
  createChatRunFixtures,
  findButton,
  findEnabledButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();

test("chat-composer-feedback-selection-001 ArrowDown at the end keeps the next character in the quote note", async () => {
  const passage = "The launch plan has three careful stages.",
    comment = "Keep this review in the quote.";
  const sent = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    chatEvents: completedConversation(passage),
    onSendRequest(body) {
      sent.resolve(body.userMessage);
    },
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await screen.findByText(passage);
  await selectPassage(passage);
  click(await findButton("Quote"));
  const editor = await screen.findByRole("textbox", {
    name: "Ask or comment on this quote",
  });
  const user = userEvent.setup({ delay: null });
  await user.type(editor, comment);
  await user.keyboard("{ArrowDown}");
  const caret = window.getSelection();
  expect(caret?.isCollapsed).toBeTruthy();
  expect(editor.contains(caret?.focusNode ?? null)).toBeTruthy();
  expect(caret?.focusNode?.textContent).toBe(comment);
  expect(caret?.focusOffset).toBe(comment.length);
  await user.keyboard("!");
  expect(editor).toHaveTextContent(comment + "!");
  click(await findEnabledButton("Send"));
  expect((await sent.promise)?.parts).toContainEqual(
    expect.objectContaining({
      type: "feedback",
      quote: passage,
      note: [{ type: "text", text: comment + "!" }],
    }),
  );
});
