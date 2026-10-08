import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadMarkReadContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
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

const THREAD_ID = "b0000000-0000-4000-a000-000000000941";
const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 300;
const MARKER_LABEL = "You last read up to here";

function history(turnCount = 15): MockChatEventInput[] {
  return Array.from({ length: turnCount }, (_, index) => {
    const turn = index + 1;
    const minute = turn.toString().padStart(2, "0");
    const runId = `read-marker-run-${turn.toString()}`;
    return [
      {
        id: `read-marker-user-${turn.toString()}`,
        role: "user" as const,
        content: `Read marker question ${turn.toString()}`,
        runId,
        seqId: index * 3 + 1,
        createdAt: `2026-08-20T12:${minute}:00.000Z`,
      },
      {
        id: `read-marker-answer-${turn.toString()}`,
        role: "assistant" as const,
        content: `Read marker answer ${turn.toString()}`,
        runId,
        seqId: index * 3 + 2,
        createdAt: `2026-08-20T12:${minute}:01.000Z`,
      },
      {
        id: `read-marker-completed-${turn.toString()}`,
        role: "assistant" as const,
        content: null,
        runId,
        runLifecycleEvent: "completed" as const,
        seqId: index * 3 + 3,
        createdAt: `2026-08-20T12:${minute}:02.000Z`,
      },
    ];
  }).flat();
}

function lateFollowups(turn: number): MockChatEventInput {
  return {
    id: `read-marker-followups-${turn.toString()}`,
    role: "assistant",
    content: null,
    runId: `read-marker-run-${turn.toString()}`,
    seqId: 46,
    createdAt: "2026-08-20T12:16:03.000Z",
    followups: [{ prompt: "Review the next steps.", kind: "talk" }],
  };
}

function mockConversation(lastReadAt: string | null, events = history()) {
  mockChatLifecycleWithoutBrowserSession({
    threadId: THREAD_ID,
    chatEvents: events,
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, { lastReadAt, cancellationRecoveryPending: false });
  });
  context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
    lastReadAt =
      events
        .filter((event) => {
          return event.runLifecycleEvent !== undefined;
        })
        .at(-1)?.createdAt ?? null;
    return respond(200, { lastReadAt });
  });
  const rowsSince = (seqId: number) => {
    return mockChatEventRows(normalizeMockChatEvents(events, THREAD_ID)).filter(
      (row) => {
        return row.seqId > seqId;
      },
    );
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
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    return respond(200, {
      events: Object.fromEntries(
        body.map(([id, seqId]) => {
          return [id, id === THREAD_ID ? rowsSince(seqId) : []];
        }),
      ),
      notFoundThreads: [],
    });
  });
  let turnCount = events.filter((event) => {
    return event.runLifecycleEvent !== undefined;
  }).length;
  return {
    appendTurn() {
      turnCount++;
      const lastSeqId = events.at(-1)?.seqId ?? 0;
      events.push(
        ...history(turnCount)
          .slice(-3)
          .map((event, index) => {
            return { ...event, seqId: lastSeqId + index + 1 };
          }),
      );
      createChatEvent(THREAD_ID);
    },
    appendFollowups(turn: number) {
      events.push({
        ...lateFollowups(turn),
        seqId: (events.at(-1)?.seqId ?? 0) + 1,
      });
      createChatEvent(THREAD_ID);
    },
  };
}

/** Layout is the external browser boundary missing from happy-dom. */
function mockTranscriptGeometry() {
  const scrollTops = new WeakMap<HTMLElement, number>();
  const rows = (container: HTMLElement) => {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        "[data-chat-scroll-anchor-event-id], [data-chat-last-read-marker-event-id]",
      ),
    );
  };
  const height = (container: HTMLElement) => {
    return rows(container).length * ROW_HEIGHT + 100;
  };
  const isContainer = (element: HTMLElement) => {
    return Object.hasOwn(element.dataset, "scrollContainer");
  };
  for (const property of [
    "clientHeight",
    "scrollHeight",
    "scrollTop",
    "getBoundingClientRect",
  ]) {
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      property,
    );
    const getValue = (element: HTMLElement) => {
      return Reflect.get(
        Reflect.getPrototypeOf(HTMLElement.prototype) as object,
        property,
        element,
      ) as number;
    };
    const descriptor: PropertyDescriptor =
      property === "getBoundingClientRect"
        ? {
            value(this: HTMLElement): DOMRect {
              const container = isContainer(this)
                ? this
                : this.closest<HTMLElement>("[data-scroll-container]");
              const index = container ? rows(container).indexOf(this) : -1;
              const top =
                container && index >= 0
                  ? index * ROW_HEIGHT - (scrollTops.get(container) ?? 0)
                  : 0;
              const rowHeight = isContainer(this)
                ? VIEWPORT_HEIGHT
                : ROW_HEIGHT;
              return {
                top,
                bottom: top + rowHeight,
                left: 0,
                right: 800,
                width: 800,
                height: rowHeight,
                x: 0,
                y: top,
                toJSON: () => {
                  return {};
                },
              } as DOMRect;
            },
          }
        : {
            get(this: HTMLElement): number {
              if (!isContainer(this)) {
                return original?.get?.call(this) ?? getValue(this);
              }
              if (property === "clientHeight") {
                return VIEWPORT_HEIGHT;
              }
              return property === "scrollHeight"
                ? height(this)
                : (scrollTops.get(this) ?? 0);
            },
            ...(property === "scrollTop"
              ? {
                  set(this: HTMLElement, top: number) {
                    if (isContainer(this)) {
                      scrollTops.set(
                        this,
                        Math.max(
                          0,
                          Math.min(top, height(this) - VIEWPORT_HEIGHT),
                        ),
                      );
                    } else {
                      Reflect.set(
                        Reflect.getPrototypeOf(HTMLElement.prototype) as object,
                        property,
                        top,
                        this,
                      );
                    }
                  },
                }
              : {}),
          };
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      ...descriptor,
    });
    context.signal.addEventListener(
      "abort",
      () => {
        if (original) {
          Object.defineProperty(HTMLElement.prototype, property, original);
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, property);
        }
      },
      { once: true },
    );
  }
}

async function openThread(enabled = true, suffix = "", lastTurn = 15) {
  mockTranscriptGeometry();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/chats/${THREAD_ID}${suffix}`,
    featureSwitches: { [FeatureSwitchKey.ChatLastReadMarker]: enabled },
  });
  await expect(
    screen.findByText(`Read marker answer ${lastTurn.toString()}`),
  ).resolves.toBeInTheDocument();
  return chatScrollContainer();
}

function expectAtBottom(container: HTMLElement) {
  expect(container.scrollTop).toBe(
    container.scrollHeight - container.clientHeight,
  );
}

test("The disabled switch preserves tail scrolling and hides the read divider", async () => {
  mockConversation("2026-08-20T12:02:02.000Z");
  const container = await openThread(false);
  await waitFor(() => {
    expectAtBottom(container);
  });
  expect(
    screen.queryByRole("separator", { name: MARKER_LABEL }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Read marker question 3")).not.toBeInTheDocument();
});

test("Open at the read boundary even when it is outside the default render window", async () => {
  const conversation = mockConversation("2026-08-20T12:02:02.000Z");
  await openThread();
  const marker = await screen.findByRole("separator", { name: MARKER_LABEL });
  const firstUnread = screen.getByText("Read marker question 3");
  expect(
    marker.compareDocumentPosition(firstUnread) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await waitFor(() => {
    // The render window begins at the divider, so its requested inset is
    // clamped at the start of the available history.
    expect(marker.getBoundingClientRect().top).toBe(0);
  });

  // Also preserve the expanded boundary as the render window grows.
  act(() => {
    conversation.appendTurn();
  });
  await expect(
    screen.findByText("Read marker answer 16"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByRole("separator", { name: MARKER_LABEL })).toHaveLength(
    1,
  );
  expect(
    marker.compareDocumentPosition(firstUnread) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(marker.getBoundingClientRect().top).toBe(0);
});

test("Keep the entry divider and reader position when messages and read state advance", async () => {
  // Render-window expansion is covered independently above. A short history
  // isolates the two live updates without re-rendering 15 unrelated Runs.
  const conversation = mockConversation("2026-08-20T12:01:02.000Z", history(3));
  const container = await openThread(true, "", 3);
  const marker = await screen.findByRole("separator", { name: MARKER_LABEL });
  const firstUnread = screen.getByText("Read marker question 2");
  await waitFor(() => {
    expect(marker.getBoundingClientRect().top).toBe(16);
  });

  act(() => {
    conversation.appendTurn();
  });
  await expect(
    screen.findByText("Read marker answer 4"),
  ).resolves.toBeInTheDocument();
  // The server has already advanced its read cursor; the entry divider and
  // the reader's held viewport still belong to the old boundary.
  expect(screen.getAllByRole("separator", { name: MARKER_LABEL })).toHaveLength(
    1,
  );
  expect(
    marker.compareDocumentPosition(firstUnread) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(marker.getBoundingClientRect().top).toBe(16);

  container.scrollTop += ROW_HEIGHT;
  fireEvent.scroll(container);
  const readingAnchor = firstUnread.closest<HTMLElement>(
    "[data-chat-scroll-anchor-event-id]",
  );
  if (!readingAnchor) {
    throw new Error("Reading message has no scroll anchor");
  }
  const readingOffset = readingAnchor.getBoundingClientRect().top;
  act(() => {
    context.mocks.ably.trigger(`chatThreadDetailChanged:${THREAD_ID}`);
    conversation.appendTurn();
  });
  await expect(
    screen.findByText("Read marker answer 5"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("separator", { name: MARKER_LABEL }),
  ).toBeInTheDocument();
  expect(readingAnchor.getBoundingClientRect().top).toBe(readingOffset);
});

test("A null watermark starts at the first available message with an unread label", async () => {
  mockConversation(null);
  const container = await openThread();
  const marker = await screen.findByRole("separator", {
    name: "Unread messages",
  });
  expect(screen.getByText("Read marker question 1")).toBeInTheDocument();
  expect(
    marker.compareDocumentPosition(screen.getByText("Read marker question 1")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(container.scrollTop).toBe(0);
});

test("An already-read thread stays at the tail when a new result arrives", async () => {
  const conversation = mockConversation("2026-08-20T12:15:02.000Z");
  const container = await openThread();
  await waitFor(() => {
    expectAtBottom(container);
  });
  expect(
    screen.queryByRole("separator", { name: MARKER_LABEL }),
  ).not.toBeInTheDocument();
  act(() => {
    conversation.appendTurn();
  });
  await expect(
    screen.findByText("Read marker answer 16"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expectAtBottom(container);
  });
});

test.each(["completed", "failed", "cancelled"] as const)(
  "Late follow-ups on a read %s run do not move the unread boundary backward",
  async (terminal) => {
    const events = history().map((event) => {
      return event.runLifecycleEvent !== undefined &&
        event.runId === "read-marker-run-2"
        ? { ...event, runLifecycleEvent: terminal }
        : event;
    });
    events.push(lateFollowups(2));
    mockConversation("2026-08-20T12:02:02.000Z", events);
    await openThread();
    const marker = await screen.findByRole("separator", { name: MARKER_LABEL });
    expect(marker).toHaveAttribute(
      "data-chat-last-read-marker-event-id",
      "read-marker-user-3",
    );
    await waitFor(() => {
      expect(marker.getBoundingClientRect().top).toBe(0);
    });
  },
);

test.each(["completed", "failed", "cancelled"] as const)(
  "A read %s run with late follow-ups does not create a divider on entry",
  async (terminal) => {
    const events = history().map((event) => {
      return event.runLifecycleEvent !== undefined &&
        event.runId === "read-marker-run-15"
        ? { ...event, runLifecycleEvent: terminal }
        : event;
    });
    events.push(lateFollowups(15));
    mockConversation("2026-08-20T12:15:02.000Z", events);
    const container = await openThread();
    await waitFor(() => {
      expectAtBottom(container);
    });
    expect(
      screen.queryByRole("separator", { name: MARKER_LABEL }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Review the next steps.")).toBeInTheDocument();
  },
);

test("A late follow-up received while reading does not move the entry divider or viewport", async () => {
  const conversation = mockConversation("2026-08-20T12:02:02.000Z");
  const container = await openThread();
  const marker = await screen.findByRole("separator", { name: MARKER_LABEL });
  await waitFor(() => {
    expect(marker.getBoundingClientRect().top).toBe(0);
  });
  container.scrollTop += ROW_HEIGHT;
  fireEvent.scroll(container);
  const offset = marker.getBoundingClientRect().top;
  act(() => {
    conversation.appendFollowups(2);
    conversation.appendFollowups(15);
  });
  await expect(
    screen.findByText("Review the next steps."),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("separator", { name: MARKER_LABEL })).toHaveAttribute(
    "data-chat-last-read-marker-event-id",
    "read-marker-user-3",
  );
  expect(marker.getBoundingClientRect().top).toBe(offset);
});

test("A divider in the current render window gets a top inset", async () => {
  mockConversation("2026-08-20T12:12:02.000Z");
  await openThread();
  const marker = await screen.findByRole("separator", { name: MARKER_LABEL });
  expect(
    marker.compareDocumentPosition(
      screen.getByText("Read marker question 13"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await waitFor(() => {
    expect(marker.getBoundingClientRect().top).toBe(16);
  });
});

test("An explicit message link takes precedence over the unread boundary", async () => {
  mockConversation("2026-08-20T12:02:02.000Z");
  await openThread(true, "#event-read-marker-answer-12");
  const answer = await screen.findByText("Read marker answer 12");
  const anchor = answer.closest<HTMLElement>(
    "[data-chat-scroll-anchor-event-id]",
  );
  if (!anchor) {
    throw new Error("Linked message has no scroll anchor");
  }
  await waitFor(() => {
    expect(anchor.getBoundingClientRect().top).toBe(0);
  });
});
