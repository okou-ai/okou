import { fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  findButton,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const PASSAGE = "The launch plan has three careful stages.";
const NOTE = "Keep this review in the quote.";

function placeNoteCaret(note: HTMLElement, offset: number): void {
  const text = note.querySelector("p")?.firstChild;
  const selection = window.getSelection();
  if (!(text instanceof Text) || !selection) {
    throw new Error("Quoted note text selection is unavailable");
  }
  selection.collapse(text, offset);
  fireEvent(document, new Event("selectionchange"));
}

test("ArrowDown at the end of a quote note keeps the caret there for the sent note", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(PASSAGE),
    onSend(send) {
      sends.push(send);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await selectPassage(PASSAGE);
  const note = await quoteSelectedPassage();
  const user = userEvent.setup({ delay: null });
  await user.type(note, NOTE);
  placeNoteCaret(note, NOTE.length);

  await user.keyboard("{ArrowDown}");

  await waitFor(() => {
    const selection = window.getSelection();
    expect(selection?.isCollapsed).toBeTruthy();
    expect(note.contains(selection?.focusNode ?? null)).toBeTruthy();
    expect(selection?.focusNode?.textContent).toBe(NOTE);
    expect(selection?.focusOffset).toBe(NOTE.length);
  });
  await user.keyboard("!");
  expect(note.querySelector("p")?.textContent).toBe(`${NOTE}!`);
  click(await findButton("Send"));
  const sent = await waitForSend(sends, 1);
  expect(sent.userMessage?.parts).toContainEqual(
    expect.objectContaining({
      type: "feedback",
      quote: PASSAGE,
      note: [{ type: "text", text: `${NOTE}!` }],
    }),
  );
});
