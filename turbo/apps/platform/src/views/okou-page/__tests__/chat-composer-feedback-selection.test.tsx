import { fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, describe, beforeEach, it } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  context,
  findButton,
  installCapabilityChat,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

const PASSAGE = "The launch plan has three careful stages.";
const OTHER_PASSAGE = "The second decision needs a separate review.";
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

function expectNoteCaret(
  note: HTMLElement,
  text: string,
  offset: number,
): void {
  const selection = window.getSelection();
  expect(selection?.isCollapsed).toBeTruthy();
  expect(note.contains(selection?.focusNode ?? null)).toBeTruthy();
  expect(selection?.focusNode?.textContent).toBe(text);
  expect(selection?.focusOffset).toBe(offset);
}

async function openQuoteComposer(sends: CapturedChatSend[] = []) {
  installCapabilityChat({
    events: completedConversation(`${PASSAGE}\n\n${OTHER_PASSAGE}`),
    onSend(send) {
      sends.push(send);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await selectPassage(PASSAGE);
  return await quoteSelectedPassage();
}

describe.each([{ key: "ArrowDown", edge: "end", offset: NOTE.length }])(
  "keep the caret in quote text after $key at its $edge",
  ({ key, offset }) => {
    async function prepareScenario() {
      const sends: CapturedChatSend[] = [];
      const note = await openQuoteComposer(sends);
      const user = userEvent.setup({ delay: null });
      await user.type(note, NOTE);
      placeNoteCaret(note, offset);
      return { user, note, sends };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("preserves the complete scenario", async () => {
      const { user, note, sends } = preparedScenario;

      await user.keyboard(`{${key}}`);

      await waitFor(() => {
        expectNoteCaret(note, NOTE, offset);
      });
      await user.keyboard("!");
      const expected = offset === 0 ? `!${NOTE}` : `${NOTE}!`;
      expect(note).toHaveTextContent(expected);
      click(await findButton("Send"));
      const sent = await waitForSend(sends, 1);
      expect(
        sent.userMessage?.parts.filter((part) => {
          return part.type !== "model";
        }),
      ).toMatchObject([
        {
          type: "feedback",
          quote: PASSAGE,
          note: [{ type: "text", text: expected }],
        },
      ]);
    });
  },
);
