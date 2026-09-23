import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  clearPassageSelection,
  completedConversation,
  context,
  feedbackItems,
  findButton,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
  selectPassage,
} from "./chat-capability-test-helpers.ts";

const PASSAGE = "The launch plan has three careful stages.";
const NEXT_PASSAGE = "Review a different decision.";

function queryQuoteButton(): HTMLElement | null {
  return (
    queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-keyshortcuts") === "q";
    }) ?? null
  );
}

async function openSelection(): Promise<void> {
  installCapabilityChat({
    events: completedConversation(`${PASSAGE}\n\n${NEXT_PASSAGE}`),
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await selectPassage(PASSAGE);
}

function releaseToolbarPointer(button: HTMLElement, pointerType: string): void {
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, pointerType });
  clearPassageSelection();
  fireEvent.pointerUp(button, { button: 0, pointerId: 1, pointerType });
  // Some browsers report the focus-induced selection change after pointerup,
  // before dispatching the button's click.
  fireEvent(document, new Event("selectionchange"));
  expect(button).toBeInTheDocument();
}

test("Copy the captured passage when pointerup clears its native selection", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openSelection();
  const button = await findButton("Copy");

  releaseToolbarPointer(button, "mouse");
  fireEvent.click(button);

  await expect(screen.findByText("Copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([PASSAGE]);
  expect(queryQuoteButton()).not.toBeInTheDocument();
});

test("Quote the captured passage after a touch selection collapses", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
  await openSelection();
  const button = await findButton("Quote");

  releaseToolbarPointer(button, "touch");
  fireEvent.click(button);

  await expect(
    screen.findByRole("textbox", { name: "Ask or comment on this quote" }),
  ).resolves.toBeInTheDocument();
  expect(feedbackItems()[0]).toHaveTextContent(PASSAGE);
  expect(queryQuoteButton()).not.toBeInTheDocument();
});

test("Forward the captured passage after the native selection collapses", async () => {
  await openSelection();
  const button = await findButton("Forward");

  releaseToolbarPointer(button, "mouse");
  fireEvent.click(button);

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(PASSAGE)).toBeInTheDocument();
  expect(queryQuoteButton()).not.toBeInTheDocument();
});

test("Preserve the native rich selection until the copy event closes its toolbar", async () => {
  installCapabilityChat({ events: completedConversation(`**${PASSAGE}**`) });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await selectPassage(PASSAGE);
  const passage = screen.getByText(PASSAGE, { selector: "strong" });
  const selection = window.getSelection();
  const selectedRange = selection?.getRangeAt(0).cloneRange();
  if (!selection || !selectedRange) {
    throw new Error("The native passage selection is unavailable");
  }
  const focusedElement = document.activeElement;

  expect(fireEvent.keyDown(document, { key: "c", ctrlKey: true })).toBeTruthy();
  expect(queryQuoteButton()).toBeInTheDocument();
  expect(fireEvent.copy(passage)).toBeTruthy();

  await waitFor(() => {
    expect(queryQuoteButton()).not.toBeInTheDocument();
  });
  expect(selection.toString()).toBe(PASSAGE);
  expect(passage.contains(selection.anchorNode)).toBeTruthy();
  expect(
    selection
      .getRangeAt(0)
      .compareBoundaryPoints(Range.START_TO_START, selectedRange),
  ).toBe(0);
  expect(
    selection
      .getRangeAt(0)
      .compareBoundaryPoints(Range.END_TO_END, selectedRange),
  ).toBe(0);
  expect(document.activeElement).toBe(focusedElement);
});

test("Dismiss the passage actions when a press lands outside them", async () => {
  await openSelection();
  await findButton("Quote");

  fireEvent.pointerDown(screen.getByText(NEXT_PASSAGE), {
    button: 0,
    pointerId: 3,
    pointerType: "mouse",
  });

  await waitFor(() => {
    expect(queryQuoteButton()).not.toBeInTheDocument();
  });
});
