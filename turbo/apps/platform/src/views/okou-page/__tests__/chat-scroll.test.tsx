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
} as const;

interface ChatScrollGeometry {
  readonly bottomScrollTop: () => number;
  readonly firstVisibleAnchor: () => HTMLElement;
  readonly growBeforeMessages: (height: number) => void;
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

  const scrollHeight = (): number => {
    return (
      heightBeforeMessages +
      renderedAnchors(container).length * ROW_HEIGHT_PX +
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
        const index = renderedAnchors(container).indexOf(this);
        if (index !== -1) {
          return rect(
            viewportTop() +
              heightBeforeMessages +
              index * ROW_HEIGHT_PX -
              scrollTop,
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
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(
      200,
      chatEventRowsResponse(
        rowsSince(query.sinceSeqId).slice(0, query.limit ?? 50),
        query,
      ),
    );
  });
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
