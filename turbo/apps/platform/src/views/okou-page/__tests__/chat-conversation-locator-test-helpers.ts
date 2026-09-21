import { within } from "@testing-library/react";
import { vi } from "vitest";

import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

export const VIEWPORT_HEIGHT = 600;
const ROW_HEIGHT = 240;
const ANCHOR_SELECTOR = "[data-chat-scroll-anchor-event-id]";

export function conversationEvents(count: number): MockChatEventInput[] {
  return Array.from({ length: count }, (_, index) => {
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
export function mockChatGeometry(): void {
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

export function requiredElement(
  selector: string,
  root: ParentNode = document,
): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`Expected ${selector}`);
  }
  return element;
}

export function messageAnchor(
  text: string,
  container: HTMLElement,
): HTMLElement {
  const message = within(container).getByText(text);
  const anchor = message.closest<HTMLElement>(ANCHOR_SELECTOR);
  if (!anchor) {
    throw new Error(`Expected a scroll anchor for ${text}`);
  }
  return anchor;
}

export function messageOffset(text: string, container: HTMLElement): number {
  const anchor = messageAnchor(text, container);
  return (
    anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
  );
}
