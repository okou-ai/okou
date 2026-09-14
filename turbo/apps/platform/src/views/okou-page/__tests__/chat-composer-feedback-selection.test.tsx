import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

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

test.each([
  { key: "ArrowDown", edge: "end", offset: NOTE.length },
  { key: "ArrowRight", edge: "end", offset: NOTE.length },
  { key: "ArrowUp", edge: "start", offset: 0 },
  { key: "ArrowLeft", edge: "start", offset: 0 },
])(
  "Keep the caret in quote text after $key at its $edge",
  async ({ key, offset }) => {
    const sends: CapturedChatSend[] = [];
    const note = await openQuoteComposer(sends);
    const user = userEvent.setup({ delay: null });
    await user.type(note, NOTE);
    placeNoteCaret(note, offset);

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
  },
);

test.each(["start", "end"] as const)(
  "Keep native selection at the quote's %s on editable note text",
  async (edge) => {
    const note = await openQuoteComposer();
    const user = userEvent.setup({ delay: null });
    await user.type(note, NOTE);
    const composer = screen.getByRole("textbox", { name: "Message" });
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("Native text selection is unavailable");
    }

    // Browser selection changes also reach block boundaries without a keydown.
    selection.collapse(
      composer,
      edge === "start" ? 0 : composer.childNodes.length,
    );
    fireEvent(document, new Event("selectionchange"));

    await waitFor(() => {
      expectNoteCaret(note, NOTE, edge === "start" ? 0 : NOTE.length);
      expect(composer).toHaveFocus();
    });
  },
);

test("Move between quoted notes without leaving a block cursor between them", async () => {
  const firstNote = await openQuoteComposer();
  const user = userEvent.setup({ delay: null });
  await user.type(firstNote, NOTE);
  await selectPassage(OTHER_PASSAGE);
  const secondNote = await quoteSelectedPassage();
  const secondText = "Review this decision independently.";
  await user.type(secondNote, secondText);

  placeNoteCaret(firstNote, NOTE.length);
  await user.keyboard("{ArrowDown}");
  await waitFor(() => {
    expectNoteCaret(secondNote, secondText, 0);
  });

  await user.keyboard("{ArrowUp}");
  await waitFor(() => {
    expectNoteCaret(firstNote, NOTE, NOTE.length);
  });
  await user.keyboard("!");
  expect(firstNote).toHaveTextContent(`${NOTE}!`);
  expect(secondNote).toHaveTextContent(secondText);
});

test("Undo and redo quote edits after boundary navigation", async () => {
  const note = await openQuoteComposer();
  const user = userEvent.setup({ delay: null });
  await user.type(note, NOTE);
  placeNoteCaret(note, NOTE.length);
  await user.keyboard("{ArrowDown}!");
  const composer = screen.getByRole("textbox", { name: "Message" });
  expect(composer).toHaveTextContent(`${NOTE}!`);

  await user.keyboard("{Control>}z{/Control}");
  expect(composer).not.toHaveTextContent(`${NOTE}!`);
  await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  expect(composer).toHaveTextContent(`${NOTE}!`);
  expect(
    screen.getByRole("textbox", { name: "What should change about this?" }),
  ).toHaveTextContent(`${NOTE}!`);
});

test.each(["before", "after"] as const)(
  "Keep an insertion point beside a legacy template %s a quote",
  async (position) => {
    installCapabilityChat({ events: completedConversation(PASSAGE) });
    await setupPage({ context, path: RUN_PATH });
    await readyChat();
    const composer = screen.getByRole("textbox", { name: "Message" });
    const user = userEvent.setup({ delay: null });
    click(composer);

    // Current template pickers create inline chips. Restore the historical
    // block form through the editor's HTML clipboard boundary instead.
    const template =
      '<div data-composer-template-attachment title="Legacy deck"></div>';
    const quote = `<div data-feedback-item quote="${PASSAGE}"><p>${NOTE}</p></div>`;
    const clipboard = new DataTransfer();
    clipboard.setData(
      "text/html",
      position === "before" ? template + quote : quote + template,
    );
    await user.paste(clipboard);
    const note = screen.getByRole("textbox", {
      name: "What should change about this?",
    });
    expect(note).toHaveTextContent(NOTE);
    placeNoteCaret(note, position === "before" ? 0 : NOTE.length);

    await user.keyboard(position === "before" ? "{ArrowUp}" : "{ArrowDown}");
    await user.keyboard("Outside the quote.");

    expect(note.querySelector("p")).toHaveTextContent(NOTE);
    expect(note).not.toHaveTextContent("Outside the quote.");
    const outsideParagraph = Array.from(composer.children).find((child) => {
      return (
        child.tagName === "P" && child.textContent === "Outside the quote."
      );
    });
    expect(outsideParagraph).toBeVisible();
    await expect(
      findButton("Preview template Legacy deck"),
    ).resolves.toBeVisible();
  },
);
