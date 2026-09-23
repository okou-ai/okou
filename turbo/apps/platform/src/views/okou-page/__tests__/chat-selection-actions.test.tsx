import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

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

test("Finish a keyboard copy through the legacy clipboard fallback", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Clipboard API denied", "NotAllowedError"),
  );
  context.mocks.browser.clipboardExecCommand();
  let selectedText: string | null = null;
  const clipboardWrites: string[] = [];
  vi.spyOn(HTMLTextAreaElement.prototype, "select").mockImplementation(
    function (this: HTMLTextAreaElement) {
      selectedText = this.value;
    },
  );
  vi.spyOn(document, "execCommand").mockImplementation((command) => {
    if (command !== "copy" || selectedText === null) {
      return false;
    }
    const defaultCopy = document.dispatchEvent(
      new Event("copy", { bubbles: true, cancelable: true }),
    );
    if (defaultCopy) {
      clipboardWrites.push(selectedText);
    }
    return defaultCopy;
  });
  await openSelection();

  fireEvent.keyDown(document, { key: "c" });

  await expect(screen.findByText("Copied")).resolves.toBeInTheDocument();
  expect(clipboardWrites).toStrictEqual([PASSAGE]);
  expect(queryQuoteButton()).not.toBeInTheDocument();
});

test("Keep the captured passage available to retry when both clipboard methods fail", async () => {
  const fallbackAttempted = context.mocks.deferred<void>();
  const clipboardWrites: string[] = [];
  vi.spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(
      new DOMException("Clipboard API denied", "NotAllowedError"),
    )
    .mockImplementation((text) => {
      clipboardWrites.push(text);
      return Promise.resolve();
    });
  context.mocks.browser.clipboardExecCommand();
  vi.spyOn(document, "execCommand").mockImplementation(() => {
    document.dispatchEvent(
      new Event("copy", { bubbles: true, cancelable: true }),
    );
    fallbackAttempted.resolve();
    return false;
  });
  await openSelection();
  const button = await findButton("Copy");

  releaseToolbarPointer(button, "mouse");
  fireEvent.click(button);
  await fallbackAttempted.promise;
  const retry = await findButton("Copy");
  expect(retry).toBeEnabled();
  fireEvent.click(retry);

  await expect(screen.findByText("Copied")).resolves.toBeInTheDocument();
  expect(clipboardWrites).toStrictEqual([PASSAGE]);
  expect(queryQuoteButton()).not.toBeInTheDocument();
});

test("Keep a newly selected passage when an earlier clipboard write completes", async () => {
  const copied = context.mocks.deferred<void>();
  const clipboardWrites: string[] = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation((text) => {
    clipboardWrites.push(text);
    return copied.promise;
  });
  await openSelection();
  const button = await findButton("Copy");

  releaseToolbarPointer(button, "mouse");
  fireEvent.click(button);
  await selectPassage(NEXT_PASSAGE);
  copied.resolve();
  await expect(screen.findByText("Copied")).resolves.toBeInTheDocument();
  expect(clipboardWrites).toStrictEqual([PASSAGE]);
  expect(queryQuoteButton()).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "q" });

  await expect(
    screen.findByRole("textbox", { name: "Ask or comment on this quote" }),
  ).resolves.toBeInTheDocument();
  expect(feedbackItems()[0]).toHaveTextContent(NEXT_PASSAGE);
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

test("Release a cancelled toolbar gesture and accept the next keyboard action", async () => {
  await openSelection();
  const button = await findButton("Quote");

  fireEvent.pointerDown(button, { pointerId: 1, pointerType: "touch" });
  clearPassageSelection();
  expect(button).toBeInTheDocument();
  fireEvent.pointerCancel(button, { pointerId: 1, pointerType: "touch" });

  await waitFor(() => {
    expect(queryQuoteButton()).not.toBeInTheDocument();
  });
  await selectPassage(NEXT_PASSAGE);
  fireEvent.keyDown(document, { key: "q" });

  await expect(
    screen.findByRole("textbox", { name: "Ask or comment on this quote" }),
  ).resolves.toBeInTheDocument();
  expect(feedbackItems()[0]).toHaveTextContent(NEXT_PASSAGE);
});

test("Keep the passage actions through the click that ends the selecting drag", async () => {
  await openSelection();

  await expect(findButton("Quote")).resolves.toBeInTheDocument();
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

test("Keep the passage actions closed while a click collapses the selection", async () => {
  await openSelection();
  const target = screen.getByText(NEXT_PASSAGE);

  fireEvent.pointerDown(target, {
    button: 0,
    isPrimary: true,
    pointerId: 3,
    pointerType: "mouse",
  });
  expect(queryQuoteButton()).not.toBeInTheDocument();

  // Chromium can retain the old range through pointerup. A gesture that did
  // not change that range must not recapture the just-dismissed toolbar.
  fireEvent.pointerUp(target, {
    button: 0,
    isPrimary: true,
    pointerId: 3,
    pointerType: "mouse",
  });
  expect(queryQuoteButton()).not.toBeInTheDocument();

  window.getSelection()?.removeAllRanges();
  fireEvent(document, new Event("selectionchange"));
  fireEvent.click(target, { button: 0 });

  expect(queryQuoteButton()).not.toBeInTheDocument();
});

test("Capture a new gesture when the previous toolbar press never clicked", async () => {
  await openSelection();
  const button = await findButton("Quote");
  releaseToolbarPointer(button, "touch");

  fireEvent.pointerDown(screen.getByText(NEXT_PASSAGE), {
    pointerId: 2,
    pointerType: "mouse",
  });
  await selectPassage(NEXT_PASSAGE);
  fireEvent.keyDown(document, { key: "q" });

  await expect(
    screen.findByRole("textbox", { name: "Ask or comment on this quote" }),
  ).resolves.toBeInTheDocument();
  expect(feedbackItems()[0]).toHaveTextContent(NEXT_PASSAGE);
});
