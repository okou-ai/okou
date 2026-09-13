import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import userEvent from "@testing-library/user-event";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import {
  chatScrollContainer,
  context,
  mockChatLifecycleWithoutBrowserSession,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import { selectPassage } from "./chat-capability-test-helpers.ts";

const ROW_HEIGHT_PX = 100;
const ROW_CONTENT_HEIGHT_PX = 80;
const CONTENT_BOTTOM_PADDING_PX = 100;
const INITIAL_VIEWPORT_HEIGHT_PX = 300;

const THREAD_IDS = {
  growingHistory: "b0000000-0000-4000-a000-000000000921",
  incomingLatest: "b0000000-0000-4000-a000-000000000922",
  incomingHistory: "b0000000-0000-4000-a000-000000000923",
  richContent: "b0000000-0000-4000-a000-000000000924",
  layoutResize: "b0000000-0000-4000-a000-000000000925",
  olderHistory: "b0000000-0000-4000-a000-000000000926",
  desktopResize: "b0000000-0000-4000-a000-000000000927",
  emptyHistory: "b0000000-0000-4000-a000-000000000928",
  prependedHistory: "b0000000-0000-4000-a000-000000000929",
  mobileHistory: "b0000000-0000-4000-a000-000000000930",
  mobileLatest: "b0000000-0000-4000-a000-000000000931",
  expandedWork: "b0000000-0000-4000-a000-000000000932",
  selectedPassage: "b0000000-0000-4000-a000-000000000933",
  sharingHistory: "b0000000-0000-4000-a000-000000000934",
} as const;

interface ChatScrollGeometry {
  readonly bottomScrollTop: () => number;
  readonly firstVisibleAnchor: () => HTMLElement;
  readonly growBeforeMessages: (height: number) => void;
  readonly resizeViewport: (height: number) => void;
}

interface MutableConversation {
  readonly add: (events: readonly MockChatEventInput[]) => void;
  readonly publish: (events: readonly MockChatEventInput[]) => void;
}

interface AnimationFrameController {
  readonly flush: () => void;
}

function installQueuedAnimationFrames(): AnimationFrameController {
  let nextFrameId = 0;
  let callbacks = new Map<number, FrameRequestCallback>();

  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrameId += 1;
    callbacks.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    callbacks.delete(frameId);
  });

  return {
    flush: () => {
      const scheduledCallbacks = Array.from(callbacks.values());
      callbacks = new Map<number, FrameRequestCallback>();
      for (const callback of scheduledCallbacks) {
        callback(performance.now());
      }
    },
  };
}

function mockPointerDevice(pointer: "desktop" | "touch"): void {
  context.mocks.browser.maxTouchPoints(pointer === "touch" ? 5 : 0);
  context.mocks.browser.matchMedia((query) => {
    return pointer === "touch" && query === "(pointer: coarse)";
  });
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

function installChatScrollGeometry(container: HTMLElement): ChatScrollGeometry {
  const prototypeRectDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  let clientHeight = INITIAL_VIEWPORT_HEIGHT_PX;
  let scrollTop = 0;
  let heightBeforeMessages = 0;

  const scrollHeight = (): number => {
    return (
      heightBeforeMessages +
      renderedAnchors(container).length * ROW_HEIGHT_PX +
      CONTENT_BOTTOM_PADDING_PX
    );
  };
  const clampScrollTop = (top: number): number => {
    return Math.max(0, Math.min(top, scrollHeight() - clientHeight));
  };

  Object.defineProperties(container, {
    clientHeight: {
      configurable: true,
      get: () => {
        return clientHeight;
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
        return rect(0, clientHeight);
      }
      if (Object.hasOwn(this.dataset, "chatScrollAnchorEventId")) {
        const index = renderedAnchors(container).indexOf(this);
        if (index !== -1) {
          return rect(
            heightBeforeMessages + index * ROW_HEIGHT_PX - scrollTop,
            ROW_CONTENT_HEIGHT_PX,
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
      return scrollHeight() - clientHeight;
    },
    firstVisibleAnchor: () => {
      const anchor = renderedAnchors(container).find((candidate) => {
        const candidateRect = candidate.getBoundingClientRect();
        return candidateRect.bottom > 0 && candidateRect.top < clientHeight;
      });
      if (!anchor) {
        throw new Error("No chat message is visible in the mocked viewport");
      }
      return anchor;
    },
    growBeforeMessages: (height) => {
      heightBeforeMessages += height;
    },
    resizeViewport: (height) => {
      clientHeight = height;
      scrollTop = clampScrollTop(scrollTop);
    },
  };
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
    return event.id === "scroll-assistant-4"
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
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    const rows = mockChatEventRows(normalizeMockChatEvents(events, threadId))
      .filter((row) => {
        return row.seqId > query.sinceSeqId;
      })
      .slice(0, query.limit ?? 50);
    return respond(200, chatEventRowsResponse(rows, query));
  });
  return {
    add: (nextEvents) => {
      events.push(...nextEvents);
    },
    publish: (nextEvents) => {
      events.push(...nextEvents);
      createChatEvent(threadId);
    },
  };
}

async function openConversation(
  threadId: string,
  loadedText: string,
): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/chats/${threadId}`,
    host: "app.okou.ai",
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

function queryPassageAction(name: string): HTMLElement | null {
  return (
    queryAllByRoleFast("button").find((candidate) => {
      return (
        candidate.getAttribute("aria-keyshortcuts") !== null &&
        candidate.textContent?.replace(/\s+/gu, " ").trim().startsWith(name)
      );
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

test("Preserve the visible message when earlier content grows", async () => {
  mockMutableConversation(THREAD_IDS.growingHistory, historyWithLateImage(8));
  const container = await openConversation(
    THREAD_IDS.growingHistory,
    "History answer 8",
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
});

test("Keep passage actions until the selection moves beyond the scroll buffer", async () => {
  mockMutableConversation(
    THREAD_IDS.selectedPassage,
    completedHistoryEvents(8),
  );
  const container = await openConversation(
    THREAD_IDS.selectedPassage,
    "History answer 8",
  );
  const geometry = installChatScrollGeometry(container);
  scrollFromUser(container, 440);
  await expectHistoryPositionHeld();
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingAnchorId = anchorId(readingAnchor);
  const readingTop = readingAnchor.getBoundingClientRect().top;
  await selectPassage("History answer 8");
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    throw new Error("Selected passage range not found");
  }
  const selectedRange = selection.getRangeAt(0);
  const selectedAtScrollTop = container.scrollTop;
  let heightBeforeSelection = 0;
  const selectionRect = (): DOMRect => {
    return rect(
      24 + heightBeforeSelection - (container.scrollTop - selectedAtScrollTop),
      24,
      200,
      24,
    );
  };
  Object.defineProperty(selectedRange, "getClientRects", {
    configurable: true,
    value: () => {
      return [selectionRect()];
    },
  });
  Object.defineProperty(selectedRange, "getBoundingClientRect", {
    configurable: true,
    value: selectionRect,
  });

  expect(queryPassageAction("Quote")).toBeVisible();
  const animationFrames = installQueuedAnimationFrames();

  geometry.growBeforeMessages(75);
  heightBeforeSelection += 75;
  container.scrollTop += 75;
  fireEvent.scroll(container);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });
  act(() => {
    animationFrames.flush();
  });

  expect(queryPassageAction("Quote")).toBeVisible();

  scrollFromUser(container, container.scrollTop - 4);
  act(() => {
    animationFrames.flush();
  });
  expect(queryPassageAction("Quote")).toBeVisible();

  scrollFromUser(container, container.scrollTop - 4);
  act(() => {
    animationFrames.flush();
  });
  expect(queryPassageAction("Quote")).toBeVisible();

  scrollFromUser(container, container.scrollTop - 1);
  act(() => {
    animationFrames.flush();
  });

  await waitFor(() => {
    expect(queryPassageAction("Quote")).not.toBeInTheDocument();
  });
});

test("Keep a visible work message in place when its run completes", async () => {
  const activeRunId = "scroll-expanded-work-run";
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
  const historyMessageTop = anchorById(
    container,
    "scroll-expanded-work-earlier",
  ).getBoundingClientRect().top;

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
  await waitFor(() => {
    expect(screen.getByText("Checked the first rollout stage")).toBeVisible();
    expect(buttonByLabel("Collapse work history")).toBeVisible();
    expect(screen.getByText("Worked for 1m")).toBeVisible();
    expect(
      anchorById(
        container,
        "scroll-expanded-work-earlier",
      ).getBoundingClientRect().top,
    ).toBe(historyMessageTop);
  });
});

test.each(["answer", "work message", "hidden history", "bottom"] as const)(
  "Preserve the reading position when sharing hides an expanded history at the %s",
  async (reading) => {
    mockMutableConversation(THREAD_IDS.sharingHistory, [
      ...completedHistoryEvents(6),
      {
        id: "scroll-sharing-user",
        role: "user",
        content: "Inspect the rollout",
        runId: "scroll-sharing-run",
        seqId: 19,
        createdAt: "2026-08-20T12:20:00.000Z",
      },
      ...["First check", "Second check", "The rollout is healthy"].map(
        (content, index) => {
          return {
            id: `scroll-sharing-output-${index.toString()}`,
            role: "assistant" as const,
            content,
            runId: "scroll-sharing-run",
            seqId: 20 + index,
            createdAt: `2026-08-20T12:20:0${(index + 1).toString()}.000Z`,
          };
        },
      ),
      {
        id: "scroll-sharing-complete",
        role: "assistant",
        content: null,
        runId: "scroll-sharing-run",
        runLifecycleEvent: "completed",
        seqId: 23,
        createdAt: "2026-08-20T12:20:04.000Z",
      },
      ...completedTurn(9),
    ]);
    const container = await openConversation(
      THREAD_IDS.sharingHistory,
      "History answer 9",
    );
    click(buttonByLabel("Expand work history"));
    await screen.findByText("First check");
    const geometry = installChatScrollGeometry(container);
    if (reading === "hidden history") {
      geometry.resizeViewport(150);
    }
    const answerId = "scroll-sharing-output-2";
    const readingId =
      reading === "answer" ? answerId : "scroll-sharing-output-0";
    if (reading === "bottom") {
      scrollFromUser(container, geometry.bottomScrollTop());
    } else {
      scrollFromUser(
        container,
        container.scrollTop +
          anchorById(container, readingId).getBoundingClientRect().top +
          20,
      );
    }
    await waitFor(() => {
      expect(queryButtonByLabel("Scroll to bottom") !== null).toBe(
        reading !== "bottom",
      );
    });
    expect(anchorId(geometry.firstVisibleAnchor())).toBe(
      reading === "bottom" ? "scroll-user-9" : readingId,
    );
    const answerTop =
      reading === "hidden history"
        ? 0
        : anchorById(container, answerId).getBoundingClientRect().top;
    const expectReadingPosition = () => {
      expect(
        reading === "bottom"
          ? container.scrollTop
          : anchorById(container, answerId).getBoundingClientRect().top,
      ).toBe(reading === "bottom" ? geometry.bottomScrollTop() : answerTop);
    };

    click(buttonByLabel("Share messages"));
    await screen.findAllByText("0 selected");
    expect(screen.queryByText("First check")).not.toBeInTheDocument();
    await waitFor(expectReadingPosition);

    fireEvent(window, new Event("resize"));
    expectReadingPosition();

    click(screen.getByText("Cancel", { selector: "button" }));
    await screen.findByText("First check");
    await waitFor(expectReadingPosition);
    expect(buttonByLabel("Collapse work history")).toBeVisible();
  },
);

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

test("Keep following the latest message while rich content finishes rendering", async () => {
  const richEvents = historyWithLateImage(5).map((event) => {
    return event.id === "scroll-assistant-5"
      ? {
          ...event,
          content:
            "Latest rich report\n\n| Item | Status |\n| --- | --- |\n| Diagram | Ready |",
        }
      : event;
  });
  const conversation = mockMutableConversation(
    THREAD_IDS.richContent,
    richEvents,
  );
  const container = await openConversation(
    THREAD_IDS.richContent,
    "Latest rich report",
  );
  const table = await screen.findByRole("table");
  const geometry = installChatScrollGeometry(container);
  expect(container.scrollTop).toBe(geometry.bottomScrollTop());

  geometry.growBeforeMessages(120);
  act(() => {
    fireEvent.load(screen.getByAltText("Late history image"));
  });

  await waitFor(() => {
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
  });
  expect(screen.getByText("Latest rich report")).toBeVisible();
  expect(queryButtonByLabel("Scroll to bottom")).toBeNull();

  const richScroller = table.parentElement ?? table;
  Object.defineProperty(richScroller, "scrollLeft", {
    configurable: true,
    value: 80,
    writable: true,
  });
  fireEvent.scroll(richScroller);
  const nextTurn = completedTurn(6).map((event) => {
    return event.id === "scroll-assistant-6"
      ? {
          ...event,
          content: "A newer message arrived after the table.",
        }
      : event;
  });
  act(() => {
    conversation.publish(nextTurn);
  });

  const newerMessage = await screen.findByText(
    "A newer message arrived after the table.",
  );
  expect(newerMessage).toBeVisible();
  await waitFor(() => {
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
  });
  expect(queryButtonByLabel("Scroll to bottom")).toBeNull();
});

test("Preserve reading intent when the chat layout changes size", async () => {
  mockMutableConversation(THREAD_IDS.layoutResize, completedHistoryEvents(8));
  const container = await openConversation(
    THREAD_IDS.layoutResize,
    "History answer 8",
  );
  const geometry = installChatScrollGeometry(container);
  expect(container.scrollTop).toBe(geometry.bottomScrollTop());

  scrollFromUser(container, 240);
  await expectHistoryPositionHeld();
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingAnchorId = anchorId(readingAnchor);
  const readingTop = readingAnchor.getBoundingClientRect().top;
  geometry.resizeViewport(220);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });

  click(buttonByLabel("Scroll to bottom"));
  await waitFor(() => {
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
    expect(queryButtonByLabel("Scroll to bottom")).toBeNull();
  });
  geometry.resizeViewport(180);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  await waitFor(() => {
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
  });
  expect(screen.getByText("History answer 8")).toBeVisible();
});

test("Keep the current message in place while older history loads", async () => {
  mockMutableConversation(THREAD_IDS.olderHistory, completedHistoryEvents(12));
  const container = await openConversation(
    THREAD_IDS.olderHistory,
    "History answer 12",
  );
  const geometry = installChatScrollGeometry(container);
  expect(screen.queryByText("History question 3")).toBeNull();

  container.scrollTop = 40;
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingAnchorId = anchorId(readingAnchor);
  const readingTop = readingAnchor.getBoundingClientRect().top;
  fireEvent.scroll(container);

  const olderMessage = await screen.findByText("History question 3");
  expect(olderMessage).toBeVisible();
  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });
});

test("Desktop resize does not trigger mobile scroll correction", async () => {
  mockPointerDevice("desktop");
  mockMutableConversation(THREAD_IDS.desktopResize, completedHistoryEvents(8));
  const container = await openConversation(
    THREAD_IDS.desktopResize,
    "History answer 8",
  );
  const geometry = installChatScrollGeometry(container);
  scrollFromUser(container, 240);
  await expectHistoryPositionHeld();
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingAnchorId = anchorId(readingAnchor);
  const readingTop = readingAnchor.getBoundingClientRect().top;

  geometry.resizeViewport(220);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });
  expect(container.scrollTop).not.toBe(geometry.bottomScrollTop());
});

test("An empty history load does not cause a later scroll jump", async () => {
  mockMutableConversation(THREAD_IDS.emptyHistory, historyWithLateImage(5));
  const container = await openConversation(
    THREAD_IDS.emptyHistory,
    "History answer 5",
  );
  const oldestAvailableMessage = screen.getByText("History question 1");
  expect(oldestAvailableMessage).toBeVisible();
  const geometry = installChatScrollGeometry(container);
  scrollFromUser(container, 40);
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
  expect(oldestAvailableMessage).toBeVisible();
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
  expect(screen.queryByText("History question 3")).toBeNull();
  container.scrollTop = 40;
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingAnchorId = anchorId(readingAnchor);
  const readingTop = readingAnchor.getBoundingClientRect().top;

  fireEvent.scroll(container);

  const olderMessage = await screen.findByText("History question 3");
  expect(olderMessage).toBeVisible();
  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });
});

test("A mobile history reader keeps their position when the viewport shrinks", async () => {
  mockPointerDevice("touch");
  mockMutableConversation(THREAD_IDS.mobileHistory, completedHistoryEvents(8));
  const container = await openConversation(
    THREAD_IDS.mobileHistory,
    "History answer 8",
  );
  const geometry = installChatScrollGeometry(container);
  scrollFromUser(container, 240);
  await expectHistoryPositionHeld();
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingAnchorId = anchorId(readingAnchor);
  const readingTop = readingAnchor.getBoundingClientRect().top;

  geometry.resizeViewport(180);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  await waitFor(() => {
    expect(
      anchorById(container, readingAnchorId).getBoundingClientRect().top,
    ).toBe(readingTop);
  });
  expect(container.scrollTop).not.toBe(geometry.bottomScrollTop());
});

test("A mobile user at the bottom stays with the latest message", async () => {
  mockPointerDevice("touch");
  mockMutableConversation(THREAD_IDS.mobileLatest, completedHistoryEvents(8));
  const container = await openConversation(
    THREAD_IDS.mobileLatest,
    "History answer 8",
  );
  const geometry = installChatScrollGeometry(container);
  expect(container.scrollTop).toBe(geometry.bottomScrollTop());

  geometry.resizeViewport(180);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  await waitFor(() => {
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
  });
  expect(screen.getByText("History answer 8")).toBeVisible();
  expect(queryButtonByLabel("Scroll to bottom")).toBeNull();
});

test("Deleting composer text keeps following the tail after a transient viewport resize", async () => {
  mockMutableConversation(THREAD_IDS.incomingLatest, completedHistoryEvents(8));
  const container = await openConversation(
    THREAD_IDS.incomingLatest,
    "History answer 8",
  );
  const composer = await screen.findByLabelText("Message");
  await fill(composer, "1\n2\n3\n4");
  const geometry = installChatScrollGeometry(container);
  // Native contenteditable editing can temporarily enlarge the sibling viewport
  // and clamp scrollTop, then restore exactly the original dimensions. No resize
  // notification is delivered for that final, unchanged size.
  geometry.resizeViewport(INITIAL_VIEWPORT_HEIGHT_PX + 16);
  geometry.resizeViewport(INITIAL_VIEWPORT_HEIGHT_PX);
  expect(container.scrollTop).toBe(geometry.bottomScrollTop() - 16);
  await userEvent.keyboard("{Backspace}");
  expect(composer).not.toHaveTextContent("4");
  fireEvent.scroll(container);
  await waitFor(() => {
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
    expect(queryButtonByLabel("Scroll to bottom")).toBeNull();
  });
});

test("Editing the composer preserves the message being read", async () => {
  mockMutableConversation(
    THREAD_IDS.incomingHistory,
    completedHistoryEvents(8),
  );
  const container = await openConversation(
    THREAD_IDS.incomingHistory,
    "History answer 8",
  );
  const composer = await screen.findByLabelText("Message");
  await fill(composer, "1\n2\n3\n4");
  const geometry = installChatScrollGeometry(container);
  scrollFromUser(container, 240);
  await expectHistoryPositionHeld();
  const readingAnchor = geometry.firstVisibleAnchor();
  const readingTop = readingAnchor.getBoundingClientRect().top;
  geometry.resizeViewport(180);
  await userEvent.keyboard("{Backspace}");
  expect(composer).not.toHaveTextContent("4");
  expect(readingAnchor.getBoundingClientRect().top).toBe(readingTop);
  expect(queryButtonByLabel("Scroll to bottom")).toBeVisible();
});
