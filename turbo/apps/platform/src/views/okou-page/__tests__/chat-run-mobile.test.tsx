import { fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  createChatRunFixtures,
  promptEvent,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const RUN_ID = "a0000000-0000-4000-a000-000000000e61";

/** The phone's visual viewport, which shrinks when the keyboard opens. */
class PhoneViewport extends EventTarget {
  height = window.innerHeight;
  width = 390;
  scale = 1;
  offsetTop = 0;
  offsetLeft = 0;
  pageTop = 0;
  pageLeft = 0;
}

function swipe(target: Element, fromY: number, toY: number): void {
  fireEvent.touchStart(target, { touches: [{ clientX: 120, clientY: fromY }] });
  fireEvent.touchMove(target, { touches: [{ clientX: 120, clientY: toY }] });
  fireEvent.touchEnd(target, { touches: [] });
}

test("Keep mobile chat gestures predictable in the standalone app", async () => {
  const viewport = new PhoneViewport();
  vi.stubGlobal("visualViewport", viewport);
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(pointer: coarse)"
    );
  });
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "audit-request",
        runId: RUN_ID,
        seqId: 1,
        text: "Audit the release notes",
      }),
    ],
    activeRunIds: [RUN_ID],
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const editor = await findComposerEditor();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  await user.paste("Add a summary");
  // The on-screen keyboard covers the lower part of the screen.
  viewport.height = window.innerHeight - 340;
  viewport.dispatchEvent(new Event("resize"));
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute(
      "data-keyboard-open",
      "true",
    );
  });

  swipe(editor, 520, 470);
  expect(editor).toHaveFocus();

  swipe(editor, 470, 520);
  expect(editor).not.toHaveFocus();
  expect(editor).toBeInTheDocument();

  await user.click(editor);
  expect(editor).toHaveFocus();
  const history = document.querySelector(
    "[data-scroll-container]",
  ) as HTMLElement;
  swipe(history, 200, 260);

  expect(editor).not.toHaveFocus();
  await expect(findComposerEditor()).resolves.toHaveTextContent(
    "Add a summary",
  );
});
