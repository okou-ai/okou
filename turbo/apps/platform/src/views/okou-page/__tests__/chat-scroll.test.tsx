import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";

import { act, fireEvent, screen, waitFor } from "@testing-library/react";

import { expect, test, vi } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";

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
  capabilityTail: "b0000000-0000-4000-a000-000000000945",
  capabilityHistory: "b0000000-0000-4000-a000-000000000946",
} as const;

interface ChatScrollGeometry {
  readonly bottomScrollTop: () => number;
  readonly firstVisibleAnchor: () => HTMLElement;
  readonly growBeforeMessages: (height: number) => void;
}

type PublishedChatEvent = MockChatEventInput & { readonly seqId: number };

interface MutableConversation {
  readonly publish: (events: readonly PublishedChatEvent[]) => Promise<void>;
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

  const spacerHeight = (side: "before" | "after") => {
    const spacer = container.querySelector<HTMLElement>(
      `[data-transcript-spacer="${side}"]`,
    );
    return spacer ? Number.parseFloat(spacer.style.height) : 0;
  };
  const scrollHeight = (): number => {
    return (
      heightBeforeMessages +
      spacerHeight("before") +
      spacerHeight("after") +
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
      if (this.dataset.transcriptSpacer === "before") {
        return rect(
          viewportTop() + heightBeforeMessages - scrollTop,
          spacerHeight("before"),
        );
      }
      if (this.dataset.transcriptSpacer === "after") {
        return rect(
          viewportTop() +
            heightBeforeMessages +
            spacerHeight("before") +
            renderedAnchors(container).length * ROW_HEIGHT_PX -
            scrollTop,
          spacerHeight("after"),
        );
      }
      if (this.dataset.transcriptPage) {
        return rect(0, renderedAnchors(this).length * ROW_HEIGHT_PX);
      }
      if (Object.hasOwn(this.dataset, "chatScrollAnchorEventId")) {
        const index = renderedAnchors(container).indexOf(this);
        if (index !== -1) {
          return rect(
            viewportTop() +
              heightBeforeMessages +
              spacerHeight("before") +
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

function completedTurn(turn: number): PublishedChatEvent[] {
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
  let acknowledgeRows:
    ((rows: readonly { seqId: number }[]) => void) | undefined;
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
      const remaining =
        params.threadId === threadId ? rowsSince(query.sinceSeqId) : [];
      const rows = remaining.slice(0, query.limit ?? 50);
      const response = respond(
        200,
        chatEventRowsResponse(rows, query, {
          hasMore: rows.length < remaining.length,
        }),
      );
      acknowledgeRows?.(rows);
      return response;
    },
  );
  // The Worker may warm its cache through the batched endpoint before the
  // page fetches rows. Both endpoints must describe the same persisted events.
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    const eventRows = body.map(([id, sinceSeqId]) => {
      return [id, id === threadId ? rowsSince(sinceSeqId) : []] as const;
    });
    const response = respond(200, {
      events: Object.fromEntries(eventRows),
      notFoundThreads: [],
    });
    for (const [, rows] of eventRows) {
      acknowledgeRows?.(rows);
    }
    return response;
  });
  return {
    publish: async (nextEvents) => {
      const pendingSeqIds = new Set(
        nextEvents.map((event) => {
          return event.seqId;
        }),
      );
      const returned = context.mocks.deferred<void>();
      acknowledgeRows = (rows) => {
        for (const row of rows) {
          pendingSeqIds.delete(row.seqId);
        }
        if (pendingSeqIds.size === 0) {
          acknowledgeRows = undefined;
          returned.resolve();
        }
      };
      // The notification starts an asynchronous catch-up. Wait for the mock
      // API to return this batch before asserting its effect on the page.
      await act(async () => {
        events.push(...nextEvents);
        createChatEvent(threadId);
        await returned.promise;
      });
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

test.each([19, 20])(
  "Open a transcript with %i message groups at the latest reply",
  async (groupCount) => {
    const threadId = THREAD_IDS.incomingLatest;
    const turns = completedHistoryEvents(10);
    // An assistant-only opening turn contributes one group instead of two.
    mockMutableConversation(
      threadId,
      groupCount === 19 ? turns.slice(1) : turns,
    );
    const container = await openConversation(threadId, "History answer 10");
    const geometry = installChatScrollGeometry(container);

    // The compact tail contains three turns. The virtual tail also mounts its neighboring page.
    expect(screen.queryByText("History question 6") !== null).toBe(
      groupCount === 20,
    );
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
  },
);

test("Fill a tall viewport from a virtual tail while keeping the latest reply pinned", async () => {
  const id = THREAD_IDS.unfilledViewport;
  const conversation = mockMutableConversation(id, completedHistoryEvents(26));
  const container = await openConversation(id, "History answer 26");
  const geometry = installChatScrollGeometry(container, () => {
    return 6000;
  });
  await conversation.publish(completedTurn(27));
  await screen.findByText("History answer 27");
  // The 6000px viewport spans fifteen turns. Its middle and oldest visible
  // answers arrive in successive renders before the final tail alignment.
  await screen.findByText("History answer 20");
  await screen.findByText("History answer 13");
  await waitFor(() => {
    const before = container.querySelector<HTMLElement>(
      '[data-transcript-spacer="before"]',
    );
    expect(before?.getBoundingClientRect().bottom).toBeLessThanOrEqual(0);
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
  });
});

test("Drag into unmounted history, retain the message through new output, and return to the latest reply", async () => {
  const id = THREAD_IDS.incomingHistory;
  const diagramImage = "https://example.com/skipped-history.png";
  const decoded: string[] = [];
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    decoded.push(this.src);
    return Promise.resolve();
  });
  const history = completedHistoryEvents(26).map((event) => {
    if (event.id !== "scroll-assistant-13") {
      return event;
    }
    return {
      ...event,
      content: [
        "```mermaid",
        "flowchart TD",
        `  Skipped@{ img: "${diagramImage}", h: 80 }`,
        "```",
      ].join("\n"),
    };
  });
  const conversation = mockMutableConversation(id, history);
  const container = await openConversation(id, "History answer 26");
  const geometry = installChatScrollGeometry(container);
  expect(screen.queryByText("History question 1")).toBeNull();
  const beforeSpacer = container.querySelector<HTMLElement>(
    '[data-transcript-spacer="before"]',
  )!;
  const estimatedHistoryHeight = beforeSpacer.getBoundingClientRect().height;
  scrollFromUser(container, 48);
  await screen.findByText("History question 1");
  await waitFor(() => {
    expect(screen.queryByText("History answer 26")).toBeNull();
    expect(geometry.firstVisibleAnchor()).toHaveTextContent(
      "History question 1",
    );
  });
  await conversation.publish(completedTurn(27));
  await waitFor(() => {
    expect(
      document.querySelector('[data-locator-tick][data-turn-index="26"]'),
    ).toBeInTheDocument();
  });
  expect(screen.queryByText("History answer 27")).toBeNull();
  expect(geometry.firstVisibleAnchor()).toHaveTextContent("History question 1");
  click(buttonByLabel("Scroll to bottom"));
  await screen.findByText("History answer 27");
  await waitFor(() => {
    expect(container.scrollTop).toBe(geometry.bottomScrollTop());
    // The history rows were taller than their initial estimates. Leaving
    // history must preserve their measured height in the leading spacer.
    expect(beforeSpacer.getBoundingClientRect().height).toBeGreaterThan(
      estimatedHistoryHeight,
    );
  });
  expect(decoded).not.toContain(diagramImage);
});

test("A reader who scrolls between paints keeps their new position", async () => {
  const id = THREAD_IDS.incomingLatest;
  const conversation = mockMutableConversation(id, completedHistoryEvents(7));
  const container = await openConversation(id, "History answer 7");
  const geometry = installChatScrollGeometry(container);
  scrollFromUser(container, geometry.bottomScrollTop());
  const frames = controlRevealFrames();
  await conversation.publish(completedTurn(8));
  await screen.findByText("History answer 8");
  // The browser has not painted yet, but incoming batches must keep flowing.
  await conversation.publish(completedTurn(9));
  await screen.findByText("History answer 9");
  await frames.paint();
  scrollFromUser(container, 275);
  const anchor = geometry.firstVisibleAnchor();
  const offset = anchor.getBoundingClientRect().top;
  await frames.paint();
  await expectHistoryPositionHeld();
  expect(anchor.getBoundingClientRect().top).toBe(offset);
});
