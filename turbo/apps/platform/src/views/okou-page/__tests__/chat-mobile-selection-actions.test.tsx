import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
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
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

const PASSAGE = "The launch plan has three careful stages.";
const NEXT_PASSAGE = "Review a different decision.";
const DRAFT = "Keep this unfinished draft.";

async function openConversation(sends: CapturedChatSend[] = []) {
  installCapabilityChat({
    events: completedConversation(`${PASSAGE}\n\n${NEXT_PASSAGE}`),
    onSend(send) {
      sends.push(send);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  return screen.getByRole("textbox", { name: "Message" });
}

function composerActions(): HTMLElement | null {
  return document.querySelector(
    "[data-chat-composer] [data-chat-selection-interaction]",
  );
}

function pressWithCollapsedSelection(button: HTMLElement): void {
  fireEvent.pointerDown(button, {
    button: 0,
    pointerId: 1,
    pointerType: "touch",
  });
  clearPassageSelection();
  fireEvent.pointerUp(button, {
    button: 0,
    pointerId: 1,
    pointerType: "touch",
  });
  fireEvent(document, new Event("selectionchange"));
  expect(button).toBeInTheDocument();
  fireEvent.click(button);
}

test.each([
  { interaction: "native" as const, coarse: true },
  { interaction: "touch" as const, coarse: false },
])(
  "Keep $interaction mobile actions in the composer without a floating menu",
  async ({ interaction, coarse }) => {
    context.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)"
        ? coarse
        : query === "(any-pointer: fine)";
    });
    const composer = await openConversation();

    await selectPassage(PASSAGE, 0, interaction);

    const actions = composerActions();
    if (!actions) {
      throw new Error("Mobile passage actions are unavailable");
    }
    expect(actions.closest("[data-chat-composer]")).toBe(
      composer.closest("[data-chat-composer]"),
    );
    expect(
      actions.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const buttons = queryAllByRoleFast("button", actions);
    expect(
      buttons.map((button) => {
        return button.textContent?.trim();
      }),
    ).toStrictEqual(["Quote", "Forward"]);
    for (const button of buttons) {
      expect(button).not.toHaveAttribute("aria-keyshortcuts");
    }
    expect(actions.querySelector("kbd")).not.toBeInTheDocument();
    expect(actions.closest("[data-scroll-container]")).toBeNull();
    expect(
      document.querySelector(
        '[data-slot="popover-content"][data-chat-selection-interaction]',
      ),
    ).not.toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe(PASSAGE);
    expect(actions.contains(document.activeElement)).toBeFalsy();
  },
);

test("Quote a captured touch passage with its source range and existing draft", async () => {
  const sends: CapturedChatSend[] = [];
  const composer = await openConversation(sends);
  await fill(composer, DRAFT);
  await selectPassage(PASSAGE, 0, "touch");
  const quote = await findButton("Quote");

  pressWithCollapsedSelection(quote);

  await expect(
    screen.findByRole("textbox", { name: "Ask or comment on this quote" }),
  ).resolves.toBeInTheDocument();
  expect(feedbackItems()[0]).toHaveTextContent(PASSAGE);
  expect(composer).toHaveTextContent(DRAFT);
  expect(composerActions()).not.toBeInTheDocument();

  click(await findButton("Send"));

  const sent = await waitForSend(sends, 1);
  expect(sent.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      { type: "text", text: DRAFT },
      expect.objectContaining({
        type: "feedback",
        quote: PASSAGE,
        eventId: "capability-first-assistant",
        range: { start: 0, end: PASSAGE.length },
      }),
    ]),
  );
});

test("Forward a captured touch passage after selection collapse without losing the draft", async () => {
  const composer = await openConversation();
  await fill(composer, DRAFT);
  await selectPassage(PASSAGE, 0, "touch");
  const forward = await findButton("Forward");

  pressWithCollapsedSelection(forward);

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(PASSAGE)).toBeInTheDocument();
  expect(composer).toHaveTextContent(DRAFT);
  expect(composerActions()).not.toBeInTheDocument();
});

test("Leave native copy and unadvertised keyboard actions intact for touch selection", async () => {
  await openConversation();
  await selectPassage(PASSAGE, 0, "touch");
  const actions = composerActions();

  for (const key of ["c", "q", "f"]) {
    expect(fireEvent.keyDown(document, { key })).toBeTruthy();
  }
  expect(feedbackItems()).toHaveLength(0);
  expect(actions).toBeInTheDocument();

  expect(fireEvent.copy(screen.getByText(PASSAGE))).toBeTruthy();

  await waitFor(() => {
    expect(actions).not.toBeInTheDocument();
  });
  expect(window.getSelection()?.toString()).toBe(PASSAGE);
});

test("Dismiss touch actions through outside press and native selection cancellation", async () => {
  await openConversation();
  await selectPassage(PASSAGE, 0, "touch");
  const actions = composerActions();

  fireEvent.pointerDown(screen.getByText(NEXT_PASSAGE), {
    pointerId: 2,
    pointerType: "touch",
  });

  await waitFor(() => {
    expect(actions).not.toBeInTheDocument();
  });
  await selectPassage(PASSAGE, 0, "touch");
  const nextActions = composerActions();

  clearPassageSelection();

  await waitFor(() => {
    expect(nextActions).not.toBeInTheDocument();
  });
});

test("Restore the floating toolbar when a touch device switches to mouse selection", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
  await openConversation();
  await selectPassage(PASSAGE, 0, "touch");
  expect(composerActions()).toBeInTheDocument();

  await selectPassage(PASSAGE);

  expect(composerActions()).not.toBeInTheDocument();
  await expect(findButton("Copy")).resolves.toBeInTheDocument();
  await expect(findButton("Quote")).resolves.toHaveAttribute(
    "aria-keyshortcuts",
    "q",
  );
  await expect(findButton("Forward")).resolves.toHaveAttribute(
    "aria-keyshortcuts",
    "f",
  );
});

test("Keep desktop native keyboard selections in the floating toolbar", async () => {
  await openConversation();

  await selectPassage(PASSAGE, 0, "native");

  expect(composerActions()).not.toBeInTheDocument();
  await expect(findButton("Quote")).resolves.toHaveAttribute(
    "aria-keyshortcuts",
    "q",
  );
});

test("Follow the transcript tail when mobile actions reserve and release footer height", async () => {
  await openConversation();
  const container = document.querySelector<HTMLElement>(
    "[data-scroll-container]",
  );
  if (!container) {
    throw new Error("The transcript scroll viewport is unavailable");
  }
  // happy-dom has no layout. Model the existing flex footer reducing the
  // scrollport, then verify the real commit-aware scroll owner follows its tail.
  let scrollTop = 600;
  const viewportHeight = () => {
    return composerActions() ? 348 : 400;
  };
  Object.defineProperties(container, {
    clientHeight: { configurable: true, get: viewportHeight },
    scrollHeight: { configurable: true, value: 1000 },
    scrollTop: {
      configurable: true,
      get: () => {
        return scrollTop;
      },
      set: (top: number) => {
        scrollTop = Math.max(0, Math.min(top, 1000 - viewportHeight()));
      },
    },
  });

  await selectPassage(PASSAGE, 0, "touch");

  await waitFor(() => {
    expect(container.scrollTop).toBe(652);
  });
  expect(composerActions()).toBeInTheDocument();

  clearPassageSelection();

  await waitFor(() => {
    expect(container.scrollTop).toBe(600);
  });
});
