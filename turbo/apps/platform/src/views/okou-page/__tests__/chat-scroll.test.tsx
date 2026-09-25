import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
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

const ROW_HEIGHT_PX = 100;
const ROW_CONTENT_HEIGHT_PX = 80;
const CONTENT_BOTTOM_PADDING_PX = 100;
const INITIAL_VIEWPORT_HEIGHT_PX = 300;

const THREAD_IDS = {
  growingHistory: "b0000000-0000-4000-a000-000000000921",
  incomingLatest: "b0000000-0000-4000-a000-000000000922",
  incomingHistory: "b0000000-0000-4000-a000-000000000923",
  prependedHistory: "b0000000-0000-4000-a000-000000000929",
  expandedWork: "b0000000-0000-4000-a000-000000000932",
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

function installChatScrollGeometry(container: HTMLElement): ChatScrollGeometry {
  const prototypeRectDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  const clientHeight = INITIAL_VIEWPORT_HEIGHT_PX;
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
