import { fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { fill } from "../../../__tests__/page-helper.ts";
import {
  activeElementIsInside,
  chatComposerTextarea,
  chatScrollContainer,
  setScrollMetrics,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  context,
  installRunChat,
  promptEvent,
  readyChat,
  RUN_PATH,
  thinkingEvent,
} from "./chat-run-test-fixtures.ts";

const ACTIVE_RUN_ID = "a0000000-0000-4000-a000-000000000601";

function setKeyboardOpenFixture(): void {
  const root = document.documentElement;
  const previous = root.dataset.keyboardOpen;
  root.dataset.keyboardOpen = "true";
  context.signal.addEventListener(
    "abort",
    () => {
      if (previous === undefined) {
        delete root.dataset.keyboardOpen;
      } else {
        root.dataset.keyboardOpen = previous;
      }
    },
    { once: true },
  );
}

function swipe(
  target: Element,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): boolean {
  fireEvent.touchStart(target, {
    touches: [{ clientX: start.x, clientY: start.y }],
  });
  const allowed = fireEvent.touchMove(target, {
    cancelable: true,
    touches: [{ clientX: end.x, clientY: end.y }],
  });
  fireEvent.touchEnd(target, { touches: [] });
  return allowed;
}

function installScrollableActiveChat(): void {
  installRunChat({
    activeRunIds: [ACTIVE_RUN_ID],
    chatEvents: [
      promptEvent({
        id: "mobile-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Prepare the mobile launch plan",
      }),
      assistantEvent({
        id: "mobile-update",
        runId: ACTIVE_RUN_ID,
        seqId: 2,
        text: "The first launch section is ready.",
      }),
      thinkingEvent({
        id: "mobile-progress",
        runId: ACTIVE_RUN_ID,
        seqId: 3,
        text: "Preparing the remaining launch sections",
      }),
    ],
  });
}

test("Show a complete thinking message before the carousel advances", async () => {
  const thinkingText =
    "Preparing the launch checklist\nReviewing the release evidence";
  installRunChat({
    activeRunIds: [ACTIVE_RUN_ID],
    chatEvents: [
      promptEvent({
        id: "thinking-lines-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Show the current progress",
      }),
      thinkingEvent({
        id: "thinking-lines-progress",
        runId: ACTIVE_RUN_ID,
        seqId: 2,
        text: thinkingText,
      }),
    ],
  });

  // The carousel splits the run's own thinking event, which is the producer
  // an account keeps while thread activity summaries are off.
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
  });

  await readyChat();
  await expect(
    screen.findByLabelText("Preparing the launch checklist"),
  ).resolves.toBeVisible();
  expect(
    screen.queryByText("Reviewing the release evidence"),
  ).not.toBeInTheDocument();
});

test("Keep mobile chat gestures predictable in the standalone app", async () => {
  context.mocks.browser.standaloneDisplayMode(true);
  context.mocks.browser.maxTouchPoints(5);
  installScrollableActiveChat();

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const composer = chatComposerTextarea();
  await fill(composer, "Short standalone draft");
  composer.focus();
  setKeyboardOpenFixture();

  const upwardAllowed = swipe(composer, { x: 40, y: 120 }, { x: 40, y: 80 });
  expect(upwardAllowed).toBeFalsy();
  expect(activeElementIsInside(composer)).toBeTruthy();
  expect(composer.closest("[data-chat-composer]")).not.toBeNull();

  swipe(composer, { x: 40, y: 80 }, { x: 40, y: 120 });
  expect(activeElementIsInside(composer)).toBeFalsy();
  expect(composer.closest("[data-chat-composer]")).not.toBeNull();

  composer.focus();
  const history = chatScrollContainer();
  swipe(history, { x: 40, y: 80 }, { x: 40, y: 120 });
  expect(activeElementIsInside(composer)).toBeFalsy();
  expect(composer.closest("[data-chat-composer]")).not.toBeNull();
});

test("Preserve normal composer scrolling in a mobile browser", async () => {
  context.mocks.browser.standaloneDisplayMode(false);
  context.mocks.browser.maxTouchPoints(5);
  installScrollableActiveChat();

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const composer = chatComposerTextarea();
  await fill(
    composer,
    "A long mobile-browser draft that can scroll independently through several paragraphs and should retain normal native touch behavior.",
  );
  composer.style.overflowY = "auto";
  setScrollMetrics(composer, { scrollHeight: 640, clientHeight: 120 });
  composer.scrollTop = 120;
  composer.focus();
  setKeyboardOpenFixture();

  const composerScrollAllowed = swipe(
    composer,
    { x: 40, y: 120 },
    { x: 40, y: 80 },
  );
  expect(composerScrollAllowed).toBeTruthy();
  expect(activeElementIsInside(composer)).toBeTruthy();

  const historyScrollAllowed = swipe(
    chatScrollContainer(),
    { x: 40, y: 80 },
    { x: 40, y: 120 },
  );
  expect(historyScrollAllowed).toBeTruthy();
  expect(activeElementIsInside(composer)).toBeTruthy();
});
