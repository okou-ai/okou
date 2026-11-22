import { fireEvent, screen, waitFor } from "@testing-library/react";

import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import {
  setupPage,
  createChatLifecycleHelpers,
} from "./chat-lifecycle-test-helpers.ts";

import { waitForBrowserPaint } from "../../../signals/utils.ts";

import { type MockChatEventInput } from "./chat-event-test-helpers.ts";

const context = testContext();

const { mockChatLifecycleWithoutBrowserSession } =
  createChatLifecycleHelpers(context);

const APP_HOST = "app.okou.ai";

const VIEWPORT_TOP = 100;

const VIEWPORT_HEIGHT = 360;

const ANCHOR_HEIGHT = 80;

const ANCHOR_STEP = 160;

const TAIL_SPACE = 40;

const READING_OFFSET = 64;

const SHARING_THREAD_ID = "b0000000-0000-4000-a000-000000000809";

interface ChatScrollGeometry {
  readonly refresh: () => void;
  readonly setViewportHeight: (height: number) => void;
  readonly scrollMessageTo: (text: string, viewportOffsetTop: number) => void;
  readonly viewportOffsetFor: (text: string) => number;
  readonly viewportHeight: () => number;
  readonly atBottom: () => boolean;
}

function conversationEvents(
  prefix: string,
  label: string,
  count = 6,
): MockChatEventInput[] {
  return Array.from({ length: count }, (_, index) => {
    const item = index + 1;
    const runId = `${prefix}-run-${item.toString()}`;
    const userSecond = (item * 3 - 2).toString().padStart(2, "0");
    const assistantSecond = (item * 3 - 1).toString().padStart(2, "0");
    const completedSecond = (item * 3).toString().padStart(2, "0");
    return [
      {
        id: `${prefix}-user-${item.toString()}`,
        role: "user" as const,
        content: `${label} message ${item.toString()}`,
        runId,
        seqId: item * 3 - 2,
        createdAt: `2026-07-01T10:00:${userSecond}Z`,
      },
      {
        id: `${prefix}-assistant-${item.toString()}`,
        role: "assistant" as const,
        content: `${label} reply ${item.toString()}`,
        runId,
        seqId: item * 3 - 1,
        createdAt: `2026-07-01T10:00:${assistantSecond}Z`,
      },
      {
        id: `${prefix}-completed-${item.toString()}`,
        role: "assistant" as const,
        content: null,
        runId,
        runLifecycleEvent: "completed" as const,
        seqId: item * 3,
        createdAt: `2026-07-01T10:00:${completedSecond}Z`,
      },
    ];
  }).flat();
}

function threadContainer(threadId: string): HTMLElement {
  const section = threadSection(threadId);
  const container = section.querySelector<HTMLElement>(
    "[data-scroll-container]",
  );
  if (!container) {
    throw new Error(`Scroll container for ${threadId} not found`);
  }
  return container;
}

function threadSection(threadId: string): HTMLElement {
  const section = Array.from(
    document.querySelectorAll<HTMLElement>("[data-chat-thread-container-id]"),
  ).find((candidate) => {
    return candidate.dataset.chatThreadContainerId === threadId;
  });
  if (!section) {
    throw new Error(`Thread section for ${threadId} not found`);
  }
  return section;
}

function messageAnchor(text: string, container?: HTMLElement): HTMLElement {
  const message = container
    ? Array.from(container.querySelectorAll<HTMLElement>("*")).find(
        (candidate) => {
          return (
            candidate.children.length === 0 && candidate.textContent === text
          );
        },
      )
    : screen.getByText(text);
  const anchor = message?.closest<HTMLElement>(
    "[data-chat-scroll-anchor-event-id]",
  );
  if (!anchor) {
    throw new Error(`Scroll anchor for ${text} not found`);
  }
  return anchor;
}

function installChatScrollGeometry(container: HTMLElement): ChatScrollGeometry {
  let scrollTop = container.scrollTop;
  let viewportHeight = VIEWPORT_HEIGHT;
  let nextContentTop = 0;
  const contentTopByEventId = new Map<string, number>();

  const anchors = (): HTMLElement[] => {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        "[data-chat-scroll-anchor-event-id]",
      ),
    );
  };

  const contentHeight = (): number => {
    refresh();
    const currentAnchorTops = anchors().flatMap((anchor) => {
      const eventId = anchor.dataset.chatScrollAnchorEventId;
      const contentTop = eventId ? contentTopByEventId.get(eventId) : undefined;
      return contentTop === undefined ? [] : [contentTop];
    });
    const lastContentTop = Math.max(0, ...currentAnchorTops);
    return Math.max(
      viewportHeight,
      lastContentTop + ANCHOR_HEIGHT + TAIL_SPACE,
    );
  };

  const maxScrollTop = (): number => {
    return Math.max(0, contentHeight() - viewportHeight);
  };

  const setScrollTop = (value: number): void => {
    scrollTop = Math.max(0, Math.min(value, maxScrollTop()));
  };

  function refresh(): void {
    for (const anchor of anchors()) {
      const eventId = anchor.dataset.chatScrollAnchorEventId;
      if (!eventId) {
        continue;
      }
      if (!contentTopByEventId.has(eventId)) {
        contentTopByEventId.set(eventId, nextContentTop);
        nextContentTop += ANCHOR_STEP;
      }
      Object.defineProperty(anchor, "getBoundingClientRect", {
        configurable: true,
        value: (): DOMRect => {
          const contentTop = contentTopByEventId.get(eventId);
          if (contentTop === undefined) {
            throw new Error(`No geometry for ${eventId}`);
          }
          return new DOMRect(
            0,
            VIEWPORT_TOP + contentTop - scrollTop,
            800,
            ANCHOR_HEIGHT,
          );
        },
      });
    }
  }

  Object.defineProperties(container, {
    clientHeight: {
      configurable: true,
      get: (): number => {
        return viewportHeight;
      },
    },
    scrollHeight: {
      configurable: true,
      get: (): number => {
        return contentHeight();
      },
    },
    scrollTop: {
      configurable: true,
      get: (): number => {
        return scrollTop;
      },
      set: (value: number): void => {
        setScrollTop(value);
      },
    },
    scrollTo: {
      configurable: true,
      value: (optionsOrX?: number | ScrollToOptions, y?: number): void => {
        const top =
          typeof optionsOrX === "number"
            ? (y ?? scrollTop)
            : (optionsOrX?.top ?? scrollTop);
        setScrollTop(top);
      },
    },
    getBoundingClientRect: {
      configurable: true,
      value: (): DOMRect => {
        return new DOMRect(0, VIEWPORT_TOP, 900, viewportHeight);
      },
    },
  });
  refresh();

  return {
    refresh,
    setViewportHeight: (height) => {
      viewportHeight = height;
      setScrollTop(scrollTop);
    },
    scrollMessageTo: (text, viewportOffsetTop) => {
      refresh();
      const anchor = messageAnchor(text, container);
      const eventId = anchor.dataset.chatScrollAnchorEventId;
      const contentTop = eventId ? contentTopByEventId.get(eventId) : undefined;
      if (contentTop === undefined) {
        throw new Error(`No content position for ${text}`);
      }
      setScrollTop(contentTop - viewportOffsetTop);
      fireEvent.scroll(container);
    },
    viewportOffsetFor: (text) => {
      refresh();
      return (
        messageAnchor(text, container).getBoundingClientRect().top -
        container.getBoundingClientRect().top
      );
    },
    viewportHeight: () => {
      return viewportHeight;
    },
    atBottom: () => {
      return container.scrollHeight - scrollTop - viewportHeight <= 10;
    },
  };
}

function normalizedText(element: Element): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function buttonNamed(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      normalizedText(candidate) === name
    );
  });
  if (!button) {
    throw new Error(`${name} button not found`);
  }
  return button;
}

async function waitForThreadMessage(
  threadId: string,
  text: string,
): Promise<void> {
  await waitFor(() => {
    expect(threadContainer(threadId)).toHaveTextContent(text);
  });
}

async function loadEarlierThreadMessage(
  threadId: string,
  latestText: string,
  earlierText: string,
): Promise<void> {
  await waitForThreadMessage(threadId, latestText);
  const container = threadContainer(threadId);
  container.scrollTop = 0;
  fireEvent.scroll(container);
  await waitForThreadMessage(threadId, earlierText);
}

async function chooseReadingPosition(
  geometry: ChatScrollGeometry,
  text: string,
): Promise<void> {
  geometry.scrollMessageTo(text, READING_OFFSET);
  await waitFor(() => {
    expect(buttonNamed("Scroll to bottom")).toBeInTheDocument();
    expect(geometry.viewportOffsetFor(text)).toBe(READING_OFFSET);
  });
}

async function setupSharingScroll() {
  mockChatLifecycleWithoutBrowserSession({
    threadId: SHARING_THREAD_ID,
    threadTitle: "Shareable research",
    chatEvents: conversationEvents("sharing", "Shareable"),
  });

  await setupPage({
    context,
    host: APP_HOST,
    path: `/chats/${SHARING_THREAD_ID}`,
  });

  const targetText = "Shareable message 3";
  await loadEarlierThreadMessage(
    SHARING_THREAD_ID,
    "Shareable message 6",
    targetText,
  );
  const geometry = installChatScrollGeometry(
    threadContainer(SHARING_THREAD_ID),
  );
  fireEvent.resize(window);
  await waitFor(() => {
    expect(geometry.atBottom()).toBeTruthy();
  });
  return { geometry, targetText };
}

test("Keep the latest reply pinned while entering and leaving sharing mode", async () => {
  const { geometry, targetText } = await setupSharingScroll();
  click(buttonNamed("Share messages"));
  geometry.setViewportHeight(VIEWPORT_HEIGHT - 80);
  fireEvent.scroll(threadContainer(SHARING_THREAD_ID));
  await waitFor(() => {
    expect(geometry.atBottom()).toBeTruthy();
  });
  click(buttonNamed("Cancel"));
  geometry.setViewportHeight(VIEWPORT_HEIGHT);
  geometry.scrollMessageTo(targetText, READING_OFFSET);
  await waitFor(() => {
    expect(geometry.atBottom()).toBeTruthy();
  });
});

test("Let reader input supersede the sharing position restore", async () => {
  const { geometry, targetText } = await setupSharingScroll();
  await chooseReadingPosition(geometry, targetText);
  click(buttonNamed("Share messages"));
  fireEvent.wheel(threadContainer(SHARING_THREAD_ID), { deltaY: 80 });
  geometry.scrollMessageTo(targetText, READING_OFFSET - 80);
  await waitForBrowserPaint(context.signal);
  expect(geometry.viewportOffsetFor(targetText)).toBe(READING_OFFSET - 80);
});
