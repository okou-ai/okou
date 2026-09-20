import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  chatScrollContainer,
  context,
  mockChatLifecycleWithoutBrowserSession,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000825";
const VIEWPORT_HEIGHT = 600;
const ROW_HEIGHT = 240;
const ANCHOR_SELECTOR = "[data-chat-scroll-anchor-event-id]";

function conversationEvents(): MockChatEventInput[] {
  return Array.from({ length: 30 }, (_, index) => {
    const number = index + 1;
    const runId = `locator-run-${number}`;
    const minute = index.toString().padStart(2, "0");
    return [
      {
        id: `locator-question-${number}`,
        role: "user" as const,
        content: `Locator question ${number}`,
        runId,
        createdAt: `2026-08-01T10:${minute}:00.000Z`,
      },
      {
        id: `locator-answer-${number}`,
        role: "assistant" as const,
        content: `Locator answer ${number}`,
        runId,
        runLifecycleEvent: "completed" as const,
        createdAt: `2026-08-01T10:${minute}:30.000Z`,
      },
    ];
  }).flat();
}

function anchors(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR));
}

/** Happy DOM has no layout engine; retain real rendering and navigation. */
function mockChatGeometry(): void {
  const positions = new WeakMap<HTMLElement, number>();
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalScrollTo = HTMLElement.prototype.scrollTo;

  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return Object.hasOwn(this.dataset, "scrollContainer")
        ? VIEWPORT_HEIGHT
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return Object.hasOwn(this.dataset, "scrollContainer")
        ? anchors(this).length * ROW_HEIGHT + VIEWPORT_HEIGHT
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
    function (this: HTMLElement) {
      return positions.get(this) ?? 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
    function (this: HTMLElement, value: number) {
      positions.set(
        this,
        Object.hasOwn(this.dataset, "scrollContainer")
          ? Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
          : value,
      );
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
    this: HTMLElement,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    if (!Object.hasOwn(this.dataset, "scrollContainer")) {
      if (typeof options === "number") {
        originalScrollTo.call(this, options, y ?? 0);
      } else {
        originalScrollTo.call(
          this,
          options?.left ?? this.scrollLeft,
          options?.top ?? this.scrollTop,
        );
      }
      return;
    }
    this.scrollTop =
      typeof options === "number" ? (y ?? 0) : (options?.top ?? this.scrollTop);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (Object.hasOwn(this.dataset, "scrollContainer")) {
        return new DOMRect(0, 0, 800, VIEWPORT_HEIGHT);
      }
      if (Object.hasOwn(this.dataset, "conversationLocator")) {
        return new DOMRect(0, 0, 24, VIEWPORT_HEIGHT);
      }
      const container = this.closest<HTMLElement>("[data-scroll-container]");
      if (container && this.matches(ANCHOR_SELECTOR)) {
        return new DOMRect(
          0,
          anchors(container).indexOf(this) * ROW_HEIGHT - container.scrollTop,
          800,
          80,
        );
      }
      return originalRect.call(this);
    },
  );
}

function requiredElement(
  selector: string,
  root: ParentNode = document,
): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`Expected ${selector}`);
  }
  return element;
}

function messageOffset(text: string, container: HTMLElement): number {
  const message = within(container).getByText(text);
  const anchor = message.closest(ANCHOR_SELECTOR);
  if (!anchor) {
    throw new Error(`Expected a scroll anchor for ${text}`);
  }
  return (
    anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
  );
}

test("sampled user markers preview and navigate beyond the rendered conversation", async () => {
  const user = userEvent.setup();
  mockChatGeometry();
  mockChatLifecycleWithoutBrowserSession({
    threadId: THREAD_ID,
    threadTitle: "Locator sampled history",
    chatEvents: conversationEvents(),
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await screen.findByText("Locator answer 30");
  const container = chatScrollContainer();
  expect(
    within(container).queryByText("Locator question 1"),
  ).not.toBeInTheDocument();

  // Native scrolling reports the initial tail position after the DOM commit.
  fireEvent.scroll(container);
  const rail = requiredElement("[data-conversation-locator]");
  await waitFor(() => {
    expect(rail.querySelectorAll("[data-locator-tick]")).toHaveLength(24);
  });

  // The compact 24-mark scale has a 10px pitch around the rail's center.
  const firstMarkY = VIEWPORT_HEIGHT / 2 - 115;
  const lastMarkY = VIEWPORT_HEIGHT / 2 + 115;
  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: firstMarkY },
  });
  const preview = requiredElement("[data-conversation-locator-preview]");
  await waitFor(() => {
    expect(preview).toHaveTextContent("Locator question 1");
  });
  click(rail);

  await within(container).findByText("Locator question 1");
  await waitFor(() => {
    // The first message cannot move below the top edge without overscrolling.
    expect(messageOffset("Locator question 1", container)).toBe(0);
  });

  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: lastMarkY },
  });
  await waitFor(() => {
    expect(preview).toHaveTextContent("Locator question 30");
  });
  click(rail);
  await waitFor(() => {
    expect(messageOffset("Locator question 30", container)).toBeCloseTo(168);
    expect(messageOffset("Locator question 1", container)).toBeLessThan(0);
  });

  await user.unhover(rail);
  await waitFor(() => {
    expect(
      within(preview).queryByText("Locator question 30"),
    ).not.toBeInTheDocument();
  });
});
