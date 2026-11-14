import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import {
  chatScrollContainer,
  chatComposerTextarea,
  setupPage,
  createChatLifecycleHelpers,
} from "./chat-lifecycle-test-helpers.ts";

import {
  createThread,
  mockChatThreadSnapshot,
} from "./sidebar-test-helpers.tsx";

// Exercise the checked-in renderer rather than the global SVG render stub.
vi.mock("@okouai/mermaid-lite", async () => {
  return await import("mermaid-lite-real");
});

const context = testContext();
const { mockChatLifecycleWithoutBrowserSession } =
  createChatLifecycleHelpers(context);

// Keep the transcript scrollable even with the compact initial window.
const ROW_HEIGHT_PX = 200;
const ROW_CONTENT_HEIGHT_PX = 180;
const CONTENT_BOTTOM_PADDING_PX = 100;
const INITIAL_VIEWPORT_HEIGHT_PX = 300;

const THREAD_IDS = {
  growingHistory: "b0000000-0000-4000-a000-000000000921",
  incomingLatest: "b0000000-0000-4000-a000-000000000922",
  incomingHistory: "b0000000-0000-4000-a000-000000000923",
  prependedHistory: "b0000000-0000-4000-a000-000000000929",
  expandedWork: "b0000000-0000-4000-a000-000000000932",
  unfilledViewport: "b0000000-0000-4000-a000-000000000941",
  runWindowStart: "b0000000-0000-4000-a000-000000000942",
  settledHistory: "b0000000-0000-4000-a000-000000000944",
  capabilityTail: "b0000000-0000-4000-a000-000000000945",
  capabilityHistory: "b0000000-0000-4000-a000-000000000946",
} as const;

interface ChatScrollGeometry {
  readonly bottomScrollTop: () => number;
  readonly firstVisibleAnchor: () => HTMLElement;
  readonly growBeforeMessages: (height: number) => void;
  readonly growWithinMessage: (
    anchor: HTMLElement,
    height: number | (() => number),
  ) => void;
}

interface MutableConversation {
  readonly publish: (events: readonly MockChatEventInput[]) => void;
}

function rect(top: number, height: number, width = 800, left = 0): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => {
      return {};
    },
    top,
    width,
    x: left,
    y: top,
  } as DOMRect;
}

function renderedAnchors(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "[data-chat-scroll-anchor-event-id]",
    ),
  );
}

function installChatScrollGeometry(
  container: HTMLElement,
  viewportHeight = () => {
    return INITIAL_VIEWPORT_HEIGHT_PX;
  },
  viewportTop = () => {
    return 0;
  },
): ChatScrollGeometry {
  const prototypeRectDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  let scrollTop = 0;
  let heightBeforeMessages = 0;
  const growthByEventId = new Map<string, () => number>();
  const messageGrowth = (anchor: HTMLElement): number => {
    return growthByEventId.get(anchorId(anchor))?.() ?? 0;
  };

  const scrollHeight = (): number => {
    const anchors = renderedAnchors(container);
    return (
      heightBeforeMessages +
      anchors.length * ROW_HEIGHT_PX +
      anchors.reduce((height, anchor) => {
        return height + messageGrowth(anchor);
      }, 0) +
      CONTENT_BOTTOM_PADDING_PX
    );
  };
  const clampScrollTop = (top: number): number => {
    return Math.max(0, Math.min(top, scrollHeight() - viewportHeight()));
  };

  Object.defineProperties(container, {
    clientHeight: {
      configurable: true,
      get: () => {
        return viewportHeight();
      },
    },
    scrollHeight: {
      configurable: true,
      get: scrollHeight,
    },
    scrollTop: {
      configurable: true,
      get: () => {
        return scrollTop;
      },
      set: (top: number) => {
        scrollTop = clampScrollTop(top);
      },
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (this === container) {
        return rect(viewportTop(), viewportHeight());
      }
      if (Object.hasOwn(this.dataset, "chatScrollAnchorEventId")) {
        const anchors = renderedAnchors(container);
        const index = anchors.indexOf(this);
        if (index !== -1) {
          const growthBefore = anchors
            .slice(0, index)
            .reduce((height, anchor) => {
              return height + messageGrowth(anchor);
            }, 0);
          return rect(
            viewportTop() +
              heightBeforeMessages +
              index * ROW_HEIGHT_PX +
              growthBefore -
              scrollTop,
            ROW_CONTENT_HEIGHT_PX + messageGrowth(this),
          );
        }
      }
      return rect(0, 0);
    },
  });
  scrollTop = clampScrollTop(Number.POSITIVE_INFINITY);
  context.signal.addEventListener(
    "abort",
    () => {
      if (prototypeRectDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "getBoundingClientRect",
          prototypeRectDescriptor,
        );
        return;
      }
      Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
    },
    { once: true },
  );

  return {
    bottomScrollTop: () => {
      return scrollHeight() - viewportHeight();
    },
    firstVisibleAnchor: () => {
      const anchor = renderedAnchors(container).find((candidate) => {
        const candidateRect = candidate.getBoundingClientRect();
        return (
          candidateRect.bottom > viewportTop() &&
          candidateRect.top < viewportTop() + viewportHeight()
        );
      });
      if (!anchor) {
        throw new Error("No chat message is visible in the mocked viewport");
      }
      return anchor;
    },
    growBeforeMessages: (height) => {
      heightBeforeMessages += height;
    },
    growWithinMessage: (anchor, height) => {
      const id = anchorId(anchor);
      const previousGrowth = growthByEventId.get(id);
      growthByEventId.set(id, () => {
        return (
          (previousGrowth?.() ?? 0) +
          (typeof height === "function" ? height() : height)
        );
      });
    },
  };
}

/**
 * Gives every chat viewport a fixed height and a content height derived from
 * its rendered messages from the first render, before a test can reach the
 * mounted container.
 */
function installViewportHeightBeforeOpen(viewportHeight: number): void {
  const clientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  const scrollHeight = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollHeight",
  );
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get(this: HTMLElement): number {
        return Object.hasOwn(this.dataset, "scrollContainer")
          ? viewportHeight
          : Number(clientHeight?.get?.call(this) ?? 0);
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement): number {
        return Object.hasOwn(this.dataset, "scrollContainer")
          ? renderedAnchors(this).length * ROW_HEIGHT_PX +
              CONTENT_BOTTOM_PADDING_PX
          : Number(scrollHeight?.get?.call(this) ?? 0);
      },
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (clientHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "clientHeight",
          clientHeight,
        );
      }
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    },
    { once: true },
  );
}

function completedTurn(turn: number): MockChatEventInput[] {
  const runId = `scroll-run-${turn.toString()}`;
  const minute = turn.toString().padStart(2, "0");
  const firstSeqId = (turn - 1) * 3 + 1;
  return [
    {
      id: `scroll-user-${turn.toString()}`,
      role: "user",
      content: `History question ${turn.toString()}`,
      runId,
      seqId: firstSeqId,
      createdAt: `2026-08-20T12:${minute}:00.000Z`,
    },
    {
      id: `scroll-assistant-${turn.toString()}`,
      role: "assistant",
      content: `History answer ${turn.toString()}`,
      runId,
      seqId: firstSeqId + 1,
      createdAt: `2026-08-20T12:${minute}:01.000Z`,
    },
    {
      id: `scroll-completed-${turn.toString()}`,
      role: "assistant",
      content: null,
      runId,
      runLifecycleEvent: "completed",
      seqId: firstSeqId + 2,
      createdAt: `2026-08-20T12:${minute}:02.000Z`,
    },
  ];
}

function completedHistoryEvents(turnCount: number): MockChatEventInput[] {
  return Array.from({ length: turnCount }, (_, index) => {
    return completedTurn(index + 1);
  }).flat();
}

function historyWithLateImage(turnCount: number): MockChatEventInput[] {
  return completedHistoryEvents(turnCount).map((event) => {
    return event.id === "scroll-assistant-6"
      ? {
          ...event,
          content: `${event.content}\n\n![Late history image](https://example.com/history.png)`,
        }
      : event;
  });
}

function mockMutableConversation(
  threadId: string,
  initialEvents: readonly MockChatEventInput[],
  activeRunIds: readonly string[] = [],
): MutableConversation {
  const events = [...initialEvents];
  mockChatLifecycleWithoutBrowserSession({
    threadId,
    threadTitle: "Scroll behavior conversation",
    chatEvents: [...initialEvents],
    activeRunIds: [...activeRunIds],
  });
  const rowsSince = (sinceSeqId: number) => {
    return mockChatEventRows(normalizeMockChatEvents(events, threadId))
      .filter((row) => {
        return row.seqId > sinceSeqId;
      })
      .map((row) => {
        // The batched catch-up stores the last row ID as the next rows cursor.
        // Use real UUID IDs in both paths so that cursor is valid on replay.
        return {
          ...row,
          id: `00000000-0000-4000-8000-${row.seqId.toString(16).padStart(12, "0")}`,
        };
      });
  };
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      return respond(
        200,
        chatEventRowsResponse(
          params.threadId === threadId
            ? rowsSince(query.sinceSeqId).slice(0, query.limit ?? 50)
            : [],
          query,
        ),
      );
    },
  );
  // The Worker may warm its cache through the batched endpoint before the
  // page fetches rows. Both endpoints must describe the same persisted events.
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    return respond(200, {
      events: Object.fromEntries(
        body.map(([id, sinceSeqId]) => {
          return [id, id === threadId ? rowsSince(sinceSeqId) : []];
        }),
      ),
      notFoundThreads: [],
    });
  });
  return {
    publish: (nextEvents) => {
      events.push(...nextEvents);
      createChatEvent(threadId);
    },
  };
}

async function openConversation(
  threadId: string,
  loadedText: string,
  capabilitiesEnabled = false,
): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/chats/${threadId}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.HomeCapabilities]: capabilitiesEnabled,
    },
  });
  const loadedMessage = await screen.findByText(loadedText);
  expect(loadedMessage).toBeVisible();
  await waitFor(() => {
    expect(
      document.querySelector("[data-chat-skeleton]"),
    ).not.toBeInTheDocument();
  });
  return chatScrollContainer();
}

function scrollFromUser(container: HTMLElement, top: number): void {
  container.scrollTop = top;
  fireEvent.scroll(container);
}

function anchorId(anchor: HTMLElement): string {
  const id = anchor.dataset.chatScrollAnchorEventId;
  if (!id) {
    throw new Error("Chat scroll anchor has no event id");
  }
  return id;
}

function anchorById(container: HTMLElement, id: string): HTMLElement {
  const anchor = container.querySelector<HTMLElement>(
    `[data-chat-scroll-anchor-event-id="${id}"]`,
  );
  if (!anchor) {
    throw new Error(`Chat scroll anchor ${id} is not rendered`);
  }
  return anchor;
}

function queryButtonByLabel(label: string): HTMLElement | null {
  return (
    queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-label") === label;
    }) ?? null
  );
}

function buttonByLabel(label: string): HTMLElement {
  const button = queryButtonByLabel(label);
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

async function expectHistoryPositionHeld(): Promise<void> {
  await waitFor(() => {
    expect(queryButtonByLabel("Scroll to bottom")).toBeVisible();
  });
}

class KeyboardViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  pageTop = 0;
  scale = 1;

  resize(height: number, pageTop: number): void {
    this.height = height;
    this.offsetTop = pageTop;
    this.pageTop = pageTop;
    this.dispatchEvent(new Event("resize"));
  }
}

function installKeyboardViewport(): KeyboardViewport {
  context.mocks.browser.standaloneDisplayMode(true);
  const viewport = new KeyboardViewport();
  vi.stubGlobal("innerHeight", viewport.height);
  vi.stubGlobal("visualViewport", viewport);
  return viewport;
}

function installKeyboardChatGeometry(
  container: HTMLElement,
  viewport: KeyboardViewport,
): ChatScrollGeometry {
  // happy-dom has no layout engine. Model the layout viewport and native
  // focus pan; bootstrap, editor and transcript scroll ownership run unchanged.
  return installChatScrollGeometry(
    container,
    () => {
      return window.innerHeight - 200;
    },
    () => {
      return 64 - viewport.pageTop;
    },
  );
}

/** Model CSS hiding and the browser's native reveal reset, not application repair. */
function installUtilitySidebarGeometry(container: HTMLElement, wide = false) {
  const covered = () => {
    return (
      !wide &&
      document.querySelector(
        '[data-testid="chat-thread-sidebar-pane"][aria-hidden="false"]',
      ) !== null
    );
  };
  const geometry = installChatScrollGeometry(container, () => {
    return covered() ? 0 : INITIAL_VIEWPORT_HEIGHT_PX;
  });
  Object.defineProperty(container, "clientWidth", {
    configurable: true,
    get: () => {
      return wide ? 1280 : 390;
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(container, "scrollTop");
  if (!descriptor?.get || !descriptor.set) {
    throw new Error("Expected controlled scroll geometry");
  }
  const read = descriptor.get;
  const write = descriptor.set;
  const writes: number[] = [];
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get: () => {
      return read.call(container);
    },
    set: (top: number) => {
      writes.push(top);
      write.call(container, top);
    },
  });
  Object.defineProperty(container, "scrollTo", {
    configurable: true,
    value: (options: ScrollToOptions | number, y?: number) => {
      container.scrollTop =
        typeof options === "number"
          ? (y ?? container.scrollTop)
          : (options.top ?? container.scrollTop);
      fireEvent.scroll(container);
      fireEvent(container, new Event("scrollend"));
    },
  });
  let wasCovered = covered();
  const observer = new MutationObserver(() => {
    const isCovered = covered();
    if (wasCovered && !isCovered) {
      // Native layout updates do not go through JavaScript's scrollTop setter.
      write.call(container, 0);
      fireEvent.scroll(container);
    }
    wasCovered = isCovered;
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden"],
    childList: true,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
    },
    { once: true },
  );
  return { ...geometry, writes };
}

function controlRevealFrames() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      callbacks.delete(id);
    });
  context.signal.addEventListener(
    "abort",
    () => {
      request.mockRestore();
      cancel.mockRestore();
    },
    { once: true },
  );
  return {
    paint: async () => {
      await act(() => {
        const frame = [...callbacks];
        for (const [id, callback] of frame) {
          if (callbacks.delete(id)) {
            callback(performance.now());
          }
        }
      });
    },
  };
}

async function openUtilityAutomations(): Promise<void> {
  click(buttonByLabel("More actions"));
  const menu = await screen.findByRole("menu");
  const automations = queryAllByRoleFast("menuitem", menu).find((item) => {
    return item.textContent?.trim() === "Automations";
  });
  if (!automations) {
    throw new Error("Automations menu item not found");
  }
  click(automations);
  await screen.findByRole("complementary", { name: "Automations" });
}

async function setupUtilitySidebarScroll(wide = false) {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 80rem)" && wide;
  });
  const conversation = mockMutableConversation(
    THREAD_IDS.incomingHistory,
    completedHistoryEvents(8),
  );
  const container = await openConversation(
    THREAD_IDS.incomingHistory,
    "History answer 8",
  );
  const geometry = installUtilitySidebarGeometry(container, wide);
  scrollFromUser(container, 240);
  await expectHistoryPositionHeld();
  return { container, geometry, conversation };
}

test.each(["history", "tail", "history after tail"] as const)(
  "Restore %s once after a narrow automation sidebar reveals the transcript",
  async (position) => {
    const { container, geometry } = await setupUtilitySidebarScroll();
    if (position !== "history") {
      scrollFromUser(container, geometry.bottomScrollTop());
      fireEvent(container, new Event("scrollend"));
    }
    await waitFor(() => {
      expect(queryButtonByLabel("Scroll to bottom") === null).toBe(
        position !== "history",
      );
    });
    // No scroll event: capture the latest rendered offset, not the last saved one.
    if (position !== "tail") {
      container.scrollTop = 275;
    }
    const readingId = anchorId(geometry.firstVisibleAnchor());
    const anchorY = anchorById(container, readingId).getBoundingClientRect()
      .top;
    await openUtilityAutomations();
    expect(container.clientWidth).toBe(390);
    expect(container.clientHeight).toBe(0);
    const frames = controlRevealFrames();
    geometry.writes.length = 0;
    click(buttonByLabel("Close automations"));
    await waitFor(() => {
      expect(container.clientHeight).toBe(INITIAL_VIEWPORT_HEIGHT_PX);
      expect(container.scrollTop).toBe(0);
    });
    await frames.paint();
    expect(container.scrollTop).toBe(0);
    expect(geometry.writes).toStrictEqual([]);
    await frames.paint();
    await waitFor(() => {
      expect(anchorById(container, readingId).getBoundingClientRect().top).toBe(
        anchorY,
      );
      expect(geometry.writes).toHaveLength(1);
    });
    await frames.paint();
    expect(geometry.writes).toHaveLength(1);
  },
);

test("Keep the wide transcript in place without reveal compensation", async () => {
  const { container, geometry } = await setupUtilitySidebarScroll(true);
  const initialTop = container.scrollTop;
  const readingId = anchorId(geometry.firstVisibleAnchor());
  const anchorY = anchorById(container, readingId).getBoundingClientRect().top;
  await openUtilityAutomations();
  expect(container.clientHeight).toBe(INITIAL_VIEWPORT_HEIGHT_PX);
  const frames = controlRevealFrames();
  geometry.writes.length = 0;
  click(buttonByLabel("Close automations"));
  await frames.paint();
  await frames.paint();
  expect(container.scrollTop).toBe(initialTop);
  expect(anchorById(container, readingId).getBoundingClientRect().top).toBe(
    anchorY,
  );
  expect(geometry.writes).toStrictEqual([]);
});

test("Keep the pre-hide anchor when incoming messages arrive behind automations", async () => {
  const { container, geometry, conversation } =
    await setupUtilitySidebarScroll();
  container.scrollTop = 275;
  const readingId = anchorId(geometry.firstVisibleAnchor());
  const anchorY = anchorById(container, readingId).getBoundingClientRect().top;
  await openUtilityAutomations();
  const frames = controlRevealFrames();
  act(() => {
    conversation.publish(completedTurn(9));
  });
  await screen.findByText("History answer 9");
  geometry.writes.length = 0;
  click(buttonByLabel("Close automations"));
  await waitFor(() => {
    expect(container.scrollTop).toBe(0);
  });
  await frames.paint();
  await frames.paint();
  await waitFor(() => {
    expect(anchorById(container, readingId).getBoundingClientRect().top).toBe(
      anchorY,
    );
    expect(geometry.writes).toStrictEqual([container.scrollTop]);
  });
});

test("Hand the retained primary transcript restore to the new Router page when the chat list opens a side conversation", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  const primaryId = THREAD_IDS.incomingHistory;
  const secondaryId = THREAD_IDS.incomingLatest;
  const conversation = mockMutableConversation(
    primaryId,
    historyWithLateImage(8),
  );
  mockChatThreadSnapshot(context, () => {
    return [
      createThread(primaryId, "Primary reading conversation"),
      createThread(secondaryId, "Side conversation"),
    ];
  });
  const container = await openConversation(primaryId, "History answer 8");
  const geometry = installUtilitySidebarGeometry(container);
  scrollFromUser(container, 275);
  await expectHistoryPositionHeld();
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingId = anchorId(readingAnchor);
  const anchorY = readingAnchor.getBoundingClientRect().top;
  const sideLink = await waitFor(() => {
    const link = document.querySelector(
      `[data-sidebar-chat-thread-id="${secondaryId}"]`,
    );
    if (!(link instanceof HTMLElement)) {
      throw new Error("Side conversation link not rendered in the chat list");
    }
    return link;
  });
  await openUtilityAutomations();
  expect(container.clientHeight).toBe(0);
  const frames = controlRevealFrames();
  // This is the production chat-list selection command: Alt-click requests
  // loadRightThread, dismisses the covering utility pane and navigates Router.
  fireEvent.click(sideLink, { altKey: true });
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${primaryId}`);
    expect(new URLSearchParams(window.location.search).get("sidebar")).toBe(
      secondaryId,
    );
    expect(document.querySelectorAll("[data-scroll-container]")).toHaveLength(
      2,
    );
    expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
    expect(container.clientHeight).toBe(INITIAL_VIEWPORT_HEIGHT_PX);
    expect(container.scrollTop).toBe(0);
  });
  await frames.paint();
  await frames.paint();
  await waitFor(() => {
    expect(
      anchorById(chatScrollContainer(), readingId).getBoundingClientRect().top,
    ).toBe(anchorY);
    expect(chatScrollContainer().scrollTop).toBe(275);
  });
  // No pointer/wheel takeover or second sidebar cycle may be needed to
  // release the old page's snapshot. Normal reading and layout repair work.
  await act(() => {
    scrollFromUser(container, 475);
  });
  const nextReadingId = anchorId(geometry.firstVisibleAnchor());
  const nextAnchorY = anchorById(
    chatScrollContainer(),
    nextReadingId,
  ).getBoundingClientRect().top;
  geometry.growBeforeMessages(75);
  act(() => {
    fireEvent.load(screen.getByAltText("Late history image"));
  });
  await waitFor(() => {
    expect(
      anchorById(chatScrollContainer(), nextReadingId).getBoundingClientRect()
        .top,
    ).toBe(nextAnchorY);
    expect(container.scrollTop).toBe(550);
  });
  act(() => {
    conversation.publish(completedTurn(9));
  });
  await screen.findByText("History answer 9");
  await frames.paint();
  await waitFor(() => {
    expect(
      anchorById(chatScrollContainer(), nextReadingId).getBoundingClientRect()
        .top,
    ).toBe(nextAnchorY);
    // The render window may trim preceding rows; reader position is the
    // message's screen offset, not an absolute scrollTop across batches.
    expect(container.scrollTop).toBeLessThan(geometry.bottomScrollTop());
  });
});

test("Keep a fresh live history capture after tail when incoming messages arrive while hidden", async () => {
  const { container, geometry, conversation } =
    await setupUtilitySidebarScroll();
  scrollFromUser(container, geometry.bottomScrollTop());
  fireEvent(container, new Event("scrollend"));
  await waitFor(() => {
    expect(queryButtonByLabel("Scroll to bottom")).toBeNull();
  });
  // Native scrolling can precede its scroll event. The held intent is still
  // tail, but opening the utility pane must capture this live history offset.
  container.scrollTop = 275;
  const readingId = anchorId(geometry.firstVisibleAnchor());
  const anchorY = anchorById(container, readingId).getBoundingClientRect().top;
  await openUtilityAutomations();
  expect(container.clientHeight).toBe(0);
  const frames = controlRevealFrames();
  act(() => {
    conversation.publish(completedTurn(9));
  });
  await screen.findByText("History answer 9");
  click(buttonByLabel("Close automations"));
  await waitFor(() => {
    expect(container.scrollTop).toBe(0);
  });
  await frames.paint();
  await frames.paint();
  await waitFor(() => {
    expect(container.scrollTop).toBe(275);
    expect(anchorById(container, readingId).getBoundingClientRect().top).toBe(
      anchorY,
    );
  });
});

test("Keep the captured oldest message when automations closes during incoming Mermaid image preparation", async () => {
  // happy-dom has no SVG layout engine. Supply only the browser measurement
  // capability; parsing, rendering and asynchronous image preparation are real.
  const bboxDescriptor = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getBBox",
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => {
      return rect(0, 80, 120);
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (bboxDescriptor) {
        Object.defineProperty(SVGElement.prototype, "getBBox", bboxDescriptor);
      } else {
        Reflect.deleteProperty(SVGElement.prototype, "getBBox");
      }
    },
    { once: true },
  );
  const imageUrl = "https://example.com/incoming-scroll-diagram.png";
  const imageReady = context.mocks.deferred<void>();
  let imagePending = false;
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    Object.defineProperties(this, {
      naturalWidth: { configurable: true, value: 120 },
      naturalHeight: { configurable: true, value: 80 },
    });
    if (this.src === imageUrl) {
      imagePending = true;
      return imageReady.promise.then(() => {
        imagePending = false;
      });
    }
    return Promise.resolve();
  });
  const { container, geometry, conversation } =
    await setupUtilitySidebarScroll();
  scrollFromUser(container, geometry.bottomScrollTop());
  fireEvent(container, new Event("scrollend"));
  await waitFor(() => {
    expect(queryButtonByLabel("Scroll to bottom")).toBeNull();
  });
  // The native offset changed before its scroll event. The saved intent is
  // still tail; opening the pane must retain the actual oldest reading row.
  container.scrollTop = 275;
  const readingId = anchorId(geometry.firstVisibleAnchor());
  const anchorY = anchorById(container, readingId).getBoundingClientRect().top;
  await openUtilityAutomations();
  const frames = controlRevealFrames();
  act(() => {
    conversation.publish(
      completedTurn(9).map((event) => {
        return event.id === "scroll-assistant-9"
          ? {
              ...event,
              content: [
                "History answer 9",
                "",
                "```mermaid",
                "flowchart TD",
                `  Incoming@{ img: "${imageUrl}", h: 80 }`,
                "```",
              ].join("\n"),
            }
          : event;
      }),
    );
  });
  // This gate is the real renderer's external Image.decode, not an internal
  // presentation mock. Close only once preparation has genuinely suspended.
  await waitFor(() => {
    expect(imagePending).toBeTruthy();
    expect(screen.getByText("History answer 9")).toBeInTheDocument();
  });
  click(buttonByLabel("Close automations"));
  await waitFor(() => {
    expect(container.clientHeight).toBe(INITIAL_VIEWPORT_HEIGHT_PX);
    expect(container.scrollTop).toBe(0);
  });
  await frames.paint();
  await frames.paint();
  await waitFor(() => {
    expect(imagePending).toBeTruthy();
    expect(
      anchorById(chatScrollContainer(), readingId).getBoundingClientRect().top,
    ).toBe(anchorY);
  });
  imageReady.resolve();
  await screen.findByRole("img", { name: "Diagram" });
  await frames.paint();
  await waitFor(() => {
    expect(imagePending).toBeFalsy();
    expect(
      anchorById(chatScrollContainer(), readingId).getBoundingClientRect().top,
    ).toBe(anchorY);
    expect(container.scrollTop).toBeLessThan(geometry.bottomScrollTop());
  });
});

test("A pointer press on the rendered scrollbar thumb takes over before the final reveal frame", async () => {
  const { container, geometry } = await setupUtilitySidebarScroll();
  // Base UI only mounts an overflowing scrollbar after both scroll extents
  // are nonzero. happy-dom otherwise reports scrollWidth = 0.
  Object.defineProperty(container, "scrollWidth", {
    configurable: true,
    value: container.clientWidth,
  });
  act(() => {
    fireEvent.scroll(container);
  });
  const scrollbar = await screen.findByTestId("chat-message-scrollbar");
  const thumb = scrollbar.querySelector('[data-slot="scroll-area-thumb"]');
  if (!(thumb instanceof HTMLElement)) {
    throw new Error("Rendered chat scrollbar thumb not found");
  }
  scrollbar.style.paddingBlockStart = "0px";
  scrollbar.style.paddingBlockEnd = "0px";
  thumb.style.marginBlockStart = "0px";
  thumb.style.marginBlockEnd = "0px";
  Object.defineProperty(scrollbar, "offsetHeight", {
    configurable: true,
    value: INITIAL_VIEWPORT_HEIGHT_PX,
  });
  Object.defineProperty(thumb, "offsetHeight", {
    configurable: true,
    value: 30,
  });
  let capturedPointer: number | null = null;
  Object.defineProperties(thumb, {
    setPointerCapture: {
      configurable: true,
      value: (id: number) => {
        capturedPointer = id;
      },
    },
    hasPointerCapture: {
      configurable: true,
      value: (id: number) => {
        return capturedPointer === id;
      },
    },
    releasePointerCapture: {
      configurable: true,
      value: () => {
        capturedPointer = null;
      },
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      for (const property of [
        "setPointerCapture",
        "hasPointerCapture",
        "releasePointerCapture",
        "offsetHeight",
      ]) {
        Reflect.deleteProperty(thumb, property);
      }
      Reflect.deleteProperty(scrollbar, "offsetHeight");
      Reflect.deleteProperty(container, "scrollWidth");
    },
    { once: true },
  );
  expect(container.contains(scrollbar)).toBeFalsy();
  expect(scrollbar.parentElement).toBe(container.parentElement);
  await openUtilityAutomations();
  const frames = controlRevealFrames();
  click(buttonByLabel("Close automations"));
  await waitFor(() => {
    expect(container.scrollTop).toBe(0);
  });
  await frames.paint();
  // Use Base UI's real drag handler with browser-capability geometry and
  // pointer capture, not a viewport pointer event or application command.
  fireEvent.pointerDown(thumb, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    clientY: 20,
  });
  expect(capturedPointer).toBe(1);
  fireEvent.pointerMove(thumb, {
    pointerId: 1,
    pointerType: "mouse",
    buttons: 1,
    clientY: 20 + (INITIAL_VIEWPORT_HEIGHT_PX - 30) / 10,
  });
  fireEvent.scroll(container);
  fireEvent.pointerUp(thumb, { pointerId: 1, pointerType: "mouse", button: 0 });
  expect(capturedPointer).toBeNull();
  const chosenTop = geometry.bottomScrollTop() / 10;
  expect(container.scrollTop).toBe(chosenTop);
  geometry.writes.length = 0;
  await frames.paint();
  expect(container.scrollTop).toBe(chosenTop);
  expect(geometry.writes).toStrictEqual([]);
});

test("Reopening automations cancels the first reveal and restores only the final close", async () => {
  const { container, geometry } = await setupUtilitySidebarScroll();
  container.scrollTop = 275;
  const readingId = anchorId(geometry.firstVisibleAnchor());
  const anchorY = anchorById(container, readingId).getBoundingClientRect().top;
  await openUtilityAutomations();
  const frames = controlRevealFrames();
  geometry.writes.length = 0;
  click(buttonByLabel("Close automations"));
  await waitFor(() => {
    expect(container.scrollTop).toBe(0);
  });
  await frames.paint();
  await openUtilityAutomations();
  await frames.paint();
  expect(container.clientHeight).toBe(0);
  expect(geometry.writes).toStrictEqual([]);
  click(buttonByLabel("Close automations"));
  await waitFor(() => {
    expect(container.clientHeight).toBe(INITIAL_VIEWPORT_HEIGHT_PX);
  });
  await frames.paint();
  expect(container.scrollTop).toBe(0);
  await frames.paint();
  await waitFor(() => {
    expect(anchorById(container, readingId).getBoundingClientRect().top).toBe(
      anchorY,
    );
    expect(geometry.writes).toStrictEqual([container.scrollTop]);
  });
});

test.each(["wheel", "touchmove", "pointerdown", "keydown"] as const)(
  "Reader %s input takes over before the narrow sidebar reveal finishes",
  async (input) => {
    const { container, geometry } = await setupUtilitySidebarScroll();
    await openUtilityAutomations();
    const frames = controlRevealFrames();
    click(buttonByLabel("Close automations"));
    await waitFor(() => {
      expect(container.scrollTop).toBe(0);
    });
    await frames.paint();
    if (input === "keydown") {
      fireEvent.keyDown(container, { key: "PageDown" });
    } else if (input === "wheel") {
      fireEvent.wheel(container, { deltaY: 125 });
    } else if (input === "pointerdown") {
      fireEvent.pointerDown(container);
    } else {
      fireEvent.touchMove(container);
    }
    scrollFromUser(container, 125);
    geometry.writes.length = 0;
    await frames.paint();
    expect(container.scrollTop).toBe(125);
    expect(geometry.writes).toStrictEqual([]);
  },
);

test("A reader jump to the latest message wins over pending sidebar restoration", async () => {
  const { container, geometry } = await setupUtilitySidebarScroll();
  await openUtilityAutomations();
  const frames = controlRevealFrames();
  click(buttonByLabel("Close automations"));
  await waitFor(() => {
    expect(container.scrollTop).toBe(0);
  });
  await frames.paint();
  click(buttonByLabel("Scroll to bottom"));
  await waitFor(() => {
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
  });
  geometry.writes.length = 0;
  await frames.paint();
  expect(container.scrollTop).toBe(geometry.bottomScrollTop());
  expect(geometry.writes).toStrictEqual([]);
});

test.each(["tail", "history"])(
  "Keep %s through PWA keyboard cycles",
  async (position) => {
    const viewport = installKeyboardViewport();
    const threadId = THREAD_IDS.growingHistory;
    mockMutableConversation(threadId, completedHistoryEvents(8));
    const container = await openConversation(threadId, "History answer 8");
    const geometry = installKeyboardChatGeometry(container, viewport);
    const editor = chatComposerTextarea();
    await fill(editor, "Keep this multiline draft\nand its second line");
    editor.focus();
    if (position === "history") {
      scrollFromUser(container, 240);
      await expectHistoryPositionHeld();
    }
    const readingId = anchorId(geometry.firstVisibleAnchor());
    const readingOffset = () => {
      return (
        anchorById(container, readingId).getBoundingClientRect().top -
        container.getBoundingClientRect().top
      );
    };
    const initialOffset = readingOffset();
    const initialScrollTop = container.scrollTop;
    const expectPosition = () => {
      const expectedScrollTop =
        position === "tail" ? geometry.bottomScrollTop() : initialScrollTop;
      expect(container.scrollTop).toBe(expectedScrollTop);
      expect(readingOffset()).toBe(
        initialOffset - (expectedScrollTop - initialScrollTop),
      );
    };

    for (let cycle = 0; cycle < 3; cycle += 1) {
      editor.focus();
      act(() => {
        viewport.resize(420, 180);
        // WebKit can expose its final pan without a second viewport event.
        viewport.pageTop = 240;
        vi.stubGlobal("scrollY", 240);
      });
      await waitFor(() => {
        expect(container.clientHeight).toBe(644);
        expect(container.getBoundingClientRect().top).toBe(
          64 - viewport.pageTop,
        );
        expectPosition();
      });

      act(() => {
        viewport.pageTop = 280;
        // Document scrolling and offsetTop are not additive on iOS.
        vi.stubGlobal("scrollY", 280);
        fireEvent.scroll(window);
        viewport.dispatchEvent(new Event("scroll"));
      });
      await waitFor(() => {
        expect(container.getBoundingClientRect().top).toBe(
          64 - viewport.pageTop,
        );
        expectPosition();
      });
      expect(editor).toHaveFocus();
      expect(editor).toHaveTextContent("Keep this multiline draft");
      expect(editor).toHaveTextContent("and its second line");

      act(() => {
        editor.blur();
        viewport.resize(844, 0);
        vi.stubGlobal("scrollY", 0);
      });
      await waitFor(() => {
        expect(container.clientHeight).toBe(644);
        expect(container.getBoundingClientRect().top).toBe(64);
        expectPosition();
      });
    }

    // A layout-viewport resize must also preserve the reading position.
    act(() => {
      vi.stubGlobal("innerHeight", 740);
      viewport.resize(740, 0);
      fireEvent.resize(window);
    });
    await waitFor(() => {
      expect(container.clientHeight).toBe(540);
      expectPosition();
    });
  },
);

test.each([
  {
    position: "tail",
    status: "completed",
    threadId: THREAD_IDS.capabilityTail,
  },
  {
    position: "history",
    status: "stopped",
    threadId: THREAD_IDS.capabilityHistory,
  },
] as const)(
  "Keep $position when opening and closing capabilities in a $status conversation",
  async ({ position, status, threadId }) => {
    const events = completedHistoryEvents(8).map(
      (event): MockChatEventInput => {
        return status === "stopped" && event.id === "scroll-completed-8"
          ? {
              ...event,
              runLifecycleEvent: "cancelled",
              error: "Run cancelled",
            }
          : event;
      },
    );
    mockMutableConversation(threadId, events);
    const container = await openConversation(
      threadId,
      "History answer 8",
      true,
    );
    // happy-dom has no layout engine. The tray takes space only once the
    // user's menu selection has actually rendered it beside the transcript.
    const geometry = installChatScrollGeometry(container, () => {
      return document.querySelector('[data-slot="capability-tray"]')
        ? INITIAL_VIEWPORT_HEIGHT_PX - 120
        : INITIAL_VIEWPORT_HEIGHT_PX;
    });
    const editor = chatComposerTextarea();
    // Keep the draft untouched: editor transactions must not restore this
    // layout change on behalf of the capability action.
    expect(editor.textContent).toBe("");
    if (position === "history") {
      scrollFromUser(container, 240);
      await expectHistoryPositionHeld();
    }
    const readingAnchorId = anchorId(geometry.firstVisibleAnchor());
    const readingOffset = () => {
      return (
        anchorById(container, readingAnchorId).getBoundingClientRect().top -
        container.getBoundingClientRect().top
      );
    };
    const initialOffset = readingOffset();
    const initialScrollTop = container.scrollTop;
    const expectPosition = () => {
      expect(container.scrollTop).toBe(
        position === "tail" ? geometry.bottomScrollTop() : initialScrollTop,
      );
      expect(readingOffset()).toBe(
        position === "tail"
          ? initialOffset + container.clientHeight - INITIAL_VIEWPORT_HEIGHT_PX
          : initialOffset,
      );
      expect(editor.textContent).toBe("");
    };
    expectPosition();

    click(buttonByLabel("Add"));
    const menu = await screen.findByRole("menu", { name: "Add" });
    const research = queryAllByRoleFast("menuitem", menu).find((candidate) => {
      return candidate.textContent?.trim() === "Research";
    });
    if (!research) {
      throw new Error("Research menu item not found");
    }
    expect(container.clientHeight).toBe(INITIAL_VIEWPORT_HEIGHT_PX);
    click(research);
    await screen.findByRole("region", { name: "Research" });
    await waitFor(() => {
      expect(container.clientHeight).toBe(INITIAL_VIEWPORT_HEIGHT_PX - 120);
      expectPosition();
    });

    click(buttonByLabel("All capabilities"));
    await waitFor(() => {
      expect(container.clientHeight).toBe(INITIAL_VIEWPORT_HEIGHT_PX);
      expectPosition();
    });
    expect(screen.getByText("History answer 8")).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/chats/${threadId}`);
  },
);

type LayoutReflow = "fonts finish loading" | "a capability layout commits";
const LAYOUT_REFLOWS: readonly LayoutReflow[] = [
  "fonts finish loading",
  "a capability layout commits",
];

async function prepareLayoutReflow(
  trigger: LayoutReflow,
): Promise<() => Promise<void>> {
  if (trigger === "fonts finish loading") {
    return async () => {
      await act(() => {
        document.fonts.dispatchEvent(new Event("loadingdone"));
      });
    };
  }
  click(buttonByLabel("Add"));
  const menu = await screen.findByRole("menu", { name: "Add" });
  const research = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === "Research";
  });
  if (!research) {
    throw new Error("Research menu item not found");
  }
  return async () => {
    click(research);
    await screen.findByRole("region", { name: "Research" });
  };
}

test.each(LAYOUT_REFLOWS)(
  "Keep the browser's history passage when %s",
  async (trigger) => {
    const events = completedHistoryEvents(8).map((event) => {
      return event.id === "scroll-assistant-6"
        ? { ...event, content: "History answer 6\n\nThe passage being read" }
        : event;
    });
    mockMutableConversation(THREAD_IDS.growingHistory, events);
    const container = await openConversation(
      THREAD_IDS.growingHistory,
      "History answer 8",
      true,
    );
    const geometry = installChatScrollGeometry(container);
    scrollFromUser(container, 240);
    await expectHistoryPositionHeld();
    const reflow = await prepareLayoutReflow(trigger);
    const passage = screen.getByText("The passage being read");
    const body = passage.closest<HTMLElement>(
      "[data-chat-scroll-anchor-event-id]",
    );
    if (!body) {
      throw new Error("Reading passage has no message body");
    }
    let paragraphOffset = 120;
    Object.defineProperty(passage, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return rect(body.getBoundingClientRect().top + paragraphOffset, 24);
      },
    });
    const passageTop = passage.getBoundingClientRect().top;
    const bodyTop = body.getBoundingClientRect().top;

    // Model internal paragraph wrapping and the browser's native anchoring.
    // Its scroll event has not arrived yet; the held message offset is stale.
    geometry.growWithinMessage(body, 75);
    paragraphOffset += 75;
    container.scrollTop += 75;
    const nativeScrollTop = container.scrollTop;
    expect(body.getBoundingClientRect().top).toBe(bodyTop - 75);
    expect(passage.getBoundingClientRect().top).toBe(passageTop);

    await reflow();

    expect(container.scrollTop).toBe(nativeScrollTop);
    expect(passage.getBoundingClientRect().top).toBe(passageTop);
    expect(buttonByLabel("Scroll to bottom")).toBeInTheDocument();
  },
);

test("Keep the browser's history passage when the responsive workspace commits", async () => {
  const viewport = context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  mockMutableConversation(
    THREAD_IDS.growingHistory,
    completedHistoryEvents(8).map((event) => {
      return event.id === "scroll-assistant-6"
        ? { ...event, content: "History answer 6\n\nThe passage being read" }
        : event;
    }),
  );
  const container = await openConversation(
    THREAD_IDS.growingHistory,
    "History answer 8",
    true,
  );
  const geometry = installChatScrollGeometry(container);
  scrollFromUser(container, 240);
  await expectHistoryPositionHeld();
  const passage = screen.getByText("The passage being read");
  const body = passage.closest<HTMLElement>(
    "[data-chat-scroll-anchor-event-id]",
  );
  if (!body) {
    throw new Error("Reading passage has no message body");
  }
  let paragraphOffset = 120;
  Object.defineProperty(passage, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return rect(body.getBoundingClientRect().top + paragraphOffset, 24);
    },
  });
  const passageTop = passage.getBoundingClientRect().top;
  geometry.growWithinMessage(body, 75);
  paragraphOffset += 75;
  container.scrollTop += 75;
  const nativeScrollTop = container.scrollTop;

  act(() => {
    viewport.setMatches(false);
  });
  await screen.findByLabelText("Back to chats");

  expect(chatScrollContainer()).toBe(container);
  expect(container.scrollTop).toBe(nativeScrollTop);
  expect(passage.getBoundingClientRect().top).toBe(passageTop);
});

test.each(LAYOUT_REFLOWS)(
  "Follow the latest reply when %s",
  async (trigger) => {
    mockMutableConversation(
      THREAD_IDS.growingHistory,
      completedHistoryEvents(8),
    );
    const container = await openConversation(
      THREAD_IDS.growingHistory,
      "History answer 8",
      true,
    );
    const geometry = installChatScrollGeometry(container);
    const reflow = await prepareLayoutReflow(trigger);
    const latest = screen
      .getByText("History answer 8")
      .closest<HTMLElement>("[data-chat-scroll-anchor-event-id]");
    if (!latest) {
      throw new Error("Latest reply has no message body");
    }
    const initialBottomScrollTop = geometry.bottomScrollTop();
    expect(container.scrollTop).toBe(initialBottomScrollTop);
    // The capability action captures tail intent before committing the tray.
    // Its paragraph reflow must become visible only after that DOM commit.
    geometry.growWithinMessage(latest, () => {
      return trigger === "fonts finish loading" ||
        document.querySelector('[data-slot="capability-tray"]')
        ? 75
        : 0;
    });
    const growthBeforeReflow = trigger === "fonts finish loading" ? 75 : 0;
    expect(geometry.bottomScrollTop()).toBe(
      initialBottomScrollTop + growthBeforeReflow,
    );
    await reflow();

    await waitFor(() => {
      expect(geometry.bottomScrollTop()).toBe(initialBottomScrollTop + 75);
      expect(container.scrollTop).toBe(geometry.bottomScrollTop());
      expect(latest.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        container.getBoundingClientRect().bottom,
      );
    });
  },
);

test.each(LAYOUT_REFLOWS)(
  "Finish an initially unmeasured linked-message restore when %s",
  async (trigger) => {
    // Keep the linked event ID intact; the mutable fixture intentionally
    // replaces row IDs with cursor-compatible UUIDs.
    mockChatLifecycleWithoutBrowserSession({
      threadId: THREAD_IDS.growingHistory,
      threadTitle: "Initially hidden linked conversation",
      chatEvents: completedHistoryEvents(8),
    });
    installViewportHeightBeforeOpen(0);
    await setupPage({
      context,
      path: `/chats/${THREAD_IDS.growingHistory}#event-scroll-assistant-6`,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.HomeCapabilities]: true },
    });
    await screen.findByText("History answer 6");
    const container = chatScrollContainer();
    await waitFor(() => {
      expect(container.querySelector("[data-locator-landed]")).not.toBeNull();
    });
    await expectHistoryPositionHeld();
    expect(container.clientHeight).toBe(0);
    let viewportHeight = 0;
    const geometry = installChatScrollGeometry(container, () => {
      return viewportHeight;
    });
    const reflow = await prepareLayoutReflow(trigger);
    const linkedMessage = screen
      .getByText("History answer 6")
      .closest<HTMLElement>("[data-chat-scroll-anchor-event-id]");
    if (!linkedMessage) {
      throw new Error("Linked reply has no message body");
    }
    expect(container.clientHeight).toBe(0);
    // The first attempt had no viewport. Real layout now places the target
    // elsewhere, so completing its original request must still be allowed.
    geometry.growBeforeMessages(75);
    viewportHeight = INITIAL_VIEWPORT_HEIGHT_PX;

    await reflow();

    await waitFor(() => {
      expect(linkedMessage.getBoundingClientRect().top).toBe(
        container.getBoundingClientRect().top,
      );
      expect(container.scrollTop).toBeLessThan(geometry.bottomScrollTop());
      expect(buttonByLabel("Scroll to bottom")).toBeInTheDocument();
    });
  },
);

test.each([false, true])(
  "Preserve the visible message as content grows with Home capabilities %s",
  async (capabilitiesEnabled) => {
    mockMutableConversation(THREAD_IDS.growingHistory, historyWithLateImage(8));
    const container = await openConversation(
      THREAD_IDS.growingHistory,
      "History answer 8",
      capabilitiesEnabled,
    );
    const geometry = installChatScrollGeometry(container);
    scrollFromUser(container, 240);
    await expectHistoryPositionHeld();
    const readingAnchor = geometry.firstVisibleAnchor();
    const readingAnchorId = anchorId(readingAnchor);
    const readingTop = readingAnchor.getBoundingClientRect().top;

    geometry.growBeforeMessages(75);
    act(() => {
      fireEvent.load(screen.getByAltText("Late history image"));
    });

    await waitFor(() => {
      expect(
        anchorById(container, readingAnchorId).getBoundingClientRect().top,
      ).toBe(readingTop);
    });
  },
);

async function completeRunWhileReadingExpandedWork() {
  // A live run demands activity summaries, whose contract requires a UUID run ID.
  const activeRunId = "a0000000-0000-4000-a000-000000000937";
  const conversation = mockMutableConversation(
    THREAD_IDS.expandedWork,
    [
      ...completedHistoryEvents(6),
      {
        id: "scroll-expanded-work-user",
        role: "user",
        content: "Inspect the rollout",
        runId: activeRunId,
        seqId: 19,
        createdAt: "2026-08-20T12:20:00.000Z",
      },
      {
        id: "scroll-expanded-work-earlier",
        role: "assistant",
        content: "Checked the first rollout stage",
        runId: activeRunId,
        seqId: 20,
        createdAt: "2026-08-20T12:20:20.000Z",
      },
      {
        id: "scroll-expanded-work-reading",
        role: "assistant",
        content: "Reading the rollout health report",
        runId: activeRunId,
        seqId: 21,
        createdAt: "2026-08-20T12:20:40.000Z",
      },
    ],
    [activeRunId],
  );
  await setupPage({
    context,
    path: `/chats/${THREAD_IDS.expandedWork}`,
    host: "app.okou.ai",
  });
  await screen.findByText("Reading the rollout health report");
  await waitFor(() => {
    expect(
      document.querySelector("[data-chat-skeleton]"),
    ).not.toBeInTheDocument();
  });

  click(buttonByLabel("Expand work history"));
  await screen.findByText("Checked the first rollout stage");
  const container = chatScrollContainer();
  const geometry = installChatScrollGeometry(container);
  scrollFromUser(container, geometry.bottomScrollTop() - 150);
  await expectHistoryPositionHeld();

  act(() => {
    conversation.publish([
      {
        id: "scroll-expanded-work-final",
        role: "assistant",
        content: "The rollout is healthy",
        runId: activeRunId,
        seqId: 22,
        createdAt: "2026-08-20T12:21:00.000Z",
      },
      {
        id: "scroll-expanded-work-complete",
        role: "assistant",
        content: null,
        runId: activeRunId,
        runLifecycleEvent: "completed",
        seqId: 23,
        createdAt: "2026-08-20T12:21:01.000Z",
      },
    ]);
  });

  await screen.findByText("The rollout is healthy");
  await screen.findByText("Worked for 1 min");
}

test("Keep expanded work history and its duration visible after the run completes", async () => {
  await completeRunWhileReadingExpandedWork();
  await waitFor(() => {
    expect(screen.getByText("Checked the first rollout stage")).toBeVisible();
    expect(buttonByLabel("Collapse work history")).toBeVisible();
    expect(screen.getByText("Worked for 1 min")).toBeVisible();
  });
});

test("Follow new messages while reading the latest reply", async () => {
  const conversation = mockMutableConversation(
    THREAD_IDS.incomingLatest,
    completedHistoryEvents(5),
  );
  const container = await openConversation(
    THREAD_IDS.incomingLatest,
    "History answer 5",
  );
  const geometry = installChatScrollGeometry(container);
  expect(container.scrollTop).toBe(geometry.bottomScrollTop());

  act(() => {
    conversation.publish(completedTurn(6));
  });

  const incomingAnswer = await screen.findByText("History answer 6");
  expect(incomingAnswer).toBeVisible();
  await waitFor(() => {
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
  });
  expect(queryButtonByLabel("Scroll to bottom")).toBeNull();
});

test("Preserve the reading position when new messages are added", async () => {
  const conversation = mockMutableConversation(
    THREAD_IDS.incomingHistory,
    completedHistoryEvents(10),
  );
  const container = await openConversation(
    THREAD_IDS.incomingHistory,
    "History answer 10",
  );
  const geometry = installChatScrollGeometry(container);
  scrollFromUser(container, 240);
  await expectHistoryPositionHeld();
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingAnchorId = anchorId(readingAnchor);
  const readingTop = readingAnchor.getBoundingClientRect().top;

  act(() => {
    conversation.publish(completedTurn(11));
  });

  const liveAnswer = await screen.findByText("History answer 11");
  expect(liveAnswer).toBeVisible();
  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });

  act(() => {
    conversation.publish(completedTurn(12));
  });

  const nextAnswer = await screen.findByText("History answer 12");
  expect(nextAnswer).toBeVisible();
  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });
});

test("Loading older messages preserves the reading position", async () => {
  mockMutableConversation(
    THREAD_IDS.prependedHistory,
    completedHistoryEvents(12),
  );
  const container = await openConversation(
    THREAD_IDS.prependedHistory,
    "History answer 12",
  );
  const geometry = installChatScrollGeometry(container);
  expect(screen.queryByText("History question 6")).toBeNull();
  container.scrollTop = 40;
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingAnchorId = anchorId(readingAnchor);
  const readingTop = readingAnchor.getBoundingClientRect().top;

  fireEvent.scroll(container);

  const olderMessage = await screen.findByText("History question 6");
  expect(olderMessage).toBeVisible();
  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });
});

test("Load earlier messages once scrolling stops near the top", async () => {
  mockMutableConversation(
    THREAD_IDS.settledHistory,
    completedHistoryEvents(12),
  );
  const container = await openConversation(
    THREAD_IDS.settledHistory,
    "History answer 12",
  );
  const geometry = installChatScrollGeometry(container);
  // One gesture passes the top, moves away, and stops near the top again.
  // Earlier groups load once, after the last scroll, from where it stopped.
  scrollFromUser(container, 40);
  scrollFromUser(container, 500);
  scrollFromUser(container, 60);
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingAnchorId = anchorId(readingAnchor);
  const readingTop = readingAnchor.getBoundingClientRect().top;

  const olderMessage = await screen.findByText("History question 6");
  expect(olderMessage).toBeVisible();
  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });
  expect(screen.queryByText("History question 4")).not.toBeInTheDocument();
});

test("Load earlier messages while the latest ones do not fill the viewport", async () => {
  // The six messages of the initial window are shorter than this viewport.
  installViewportHeightBeforeOpen(1500);
  mockMutableConversation(
    THREAD_IDS.unfilledViewport,
    completedHistoryEvents(12),
  );
  await openConversation(THREAD_IDS.unfilledViewport, "History answer 12");

  await expect(
    screen.findByText("History question 5"),
  ).resolves.toBeInTheDocument();
});

test("Show the prompt and full work duration of the oldest visible answer", async () => {
  mockMutableConversation(THREAD_IDS.runWindowStart, [
    ...completedHistoryEvents(1),
    {
      id: "scroll-window-run-user",
      role: "user",
      content: "Review the release checklist",
      runId: "scroll-window-run",
      seqId: 4,
      createdAt: "2026-08-20T12:02:00.000Z",
    },
    {
      id: "scroll-window-run-work",
      role: "assistant",
      content: "Checked the release notes",
      runId: "scroll-window-run",
      seqId: 5,
      createdAt: "2026-08-20T12:02:30.000Z",
    },
    {
      id: "scroll-window-run-answer",
      role: "assistant",
      content: "The release checklist is complete",
      runId: "scroll-window-run",
      seqId: 6,
      createdAt: "2026-08-20T12:03:00.000Z",
    },
    {
      id: "scroll-window-run-completed",
      role: "assistant",
      content: null,
      runId: "scroll-window-run",
      runLifecycleEvent: "completed",
      seqId: 7,
      createdAt: "2026-08-20T12:03:00.000Z",
    },
    ...completedHistoryEvents(4)
      .slice(6)
      .map((event) => {
        return { ...event, seqId: (event.seqId ?? 0) + 1 };
      }),
  ]);
  await openConversation(THREAD_IDS.runWindowStart, "History answer 4");

  expect(
    screen.getByText("The release checklist is complete"),
  ).toBeInTheDocument();
  expect(screen.getByText("Review the release checklist")).toBeInTheDocument();
  await expect(
    screen.findByText("Worked for 1 min"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("History question 1")).not.toBeInTheDocument();
});
