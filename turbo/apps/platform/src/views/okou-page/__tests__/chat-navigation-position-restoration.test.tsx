import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
import {
  context,
  mockChatLifecycleWithoutBrowserSession,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";

const APP_HOST = "app.okou.ai";
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const VIEWPORT_TOP = 100;
const VIEWPORT_HEIGHT = 360;
const ANCHOR_HEIGHT = 80;
const ANCHOR_STEP = 160;
const TAIL_SPACE = 40;
const READING_OFFSET = 64;
const LINUX_CHROME_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const KEYBOARD_PREVIOUS_THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const KEYBOARD_CURRENT_THREAD_ID = "b0000000-0000-4000-a000-000000000802";
const SIDEBAR_OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000804";
const SIDEBAR_CURRENT_THREAD_ID = "b0000000-0000-4000-a000-000000000805";
const DEEP_LINK_THREAD_ID = "b0000000-0000-4000-a000-000000000806";
const MISSING_LINK_THREAD_ID = "b0000000-0000-4000-a000-000000000807";
const SEND_FROM_HISTORY_THREAD_ID = "b0000000-0000-4000-a000-000000000808";
const SHARING_THREAD_ID = "b0000000-0000-4000-a000-000000000809";

interface ThreadStory {
  readonly id: string;
  readonly title: string;
  readonly events: MockChatEventInput[];
}

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

function mockThreadStories(
  currentThreadId: string,
  stories: readonly ThreadStory[],
): ReturnType<typeof mockChatLifecycleWithoutBrowserSession> {
  const current = stories.find((story) => {
    return story.id === currentThreadId;
  });
  if (!current) {
    throw new Error("Current thread story not found");
  }
  const control = mockChatLifecycleWithoutBrowserSession({
    threadId: current.id,
    threadTitle: current.title,
    chatEvents: current.events,
  });
  control.setThreadList(
    stories.map((story, index) => {
      const sortSecond = (stories.length - index).toString().padStart(2, "0");
      return {
        id: story.id,
        title: story.title,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-07-01T10:00:00Z",
        updatedAt: `2026-07-01T10:10:${sortSecond}Z`,
        pinnedAt: null,
      };
    }),
  );
  const storiesById = new Map(
    stories.map((story) => {
      return [story.id, story];
    }),
  );
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      const story = storiesById.get(params.threadId);
      const rows = mockChatEventRows(
        normalizeMockChatEvents(story?.events ?? [], params.threadId),
      ).filter((row) => {
        return row.seqId > query.sinceSeqId;
      });
      return respond(200, chatEventRowsResponse(rows, query));
    },
  );
  return control;
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

function sidebarThreadLink(threadId: string, name: string): HTMLElement {
  const sidebar = screen.getByTestId("chat-list-column");
  const link = queryAllByRoleFast("link", sidebar).find((candidate) => {
    return (
      candidate.dataset.sidebarChatThreadId === threadId &&
      normalizedText(candidate) === name
    );
  });
  if (!link) {
    throw new Error(`${name} sidebar thread link not found`);
  }
  return link;
}

async function waitForThreadMessage(
  threadId: string,
  text: string,
): Promise<void> {
  await waitFor(() => {
    expect(threadContainer(threadId)).toHaveTextContent(text);
  });
}

async function waitForInteractiveThread(
  threadId: string,
  title: string,
  text: string,
): Promise<void> {
  await waitFor(() => {
    const section = threadSection(threadId);
    const link = sidebarThreadLink(threadId, title);
    expect(section).toBeVisible();
    expect(section).toHaveTextContent(text);
    expect(section.querySelector('[role="textbox"]')).toHaveAccessibleName(
      "Message",
    );
    expect(link).toBeVisible();
    expect(link).toHaveAttribute("aria-current", "page");
  });
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

async function expectReadingPosition(
  geometry: ChatScrollGeometry,
  text: string,
  viewportOffsetTop = READING_OFFSET,
): Promise<void> {
  await waitFor(() => {
    expect(geometry.viewportOffsetFor(text)).toBe(viewportOffsetTop);
  });
}

async function expectLatestActivity(
  geometry: ChatScrollGeometry,
  latestText: string,
): Promise<void> {
  await waitFor(() => {
    const latestOffset = geometry.viewportOffsetFor(latestText);
    expect(geometry.atBottom()).toBeTruthy();
    expect(latestOffset).toBeGreaterThanOrEqual(0);
    expect(latestOffset).toBeLessThan(geometry.viewportHeight());
    expect(
      queryAllByRoleFast("button").find((candidate) => {
        return candidate.getAttribute("aria-label") === "Scroll to bottom";
      }),
    ).toBeUndefined();
  });
}

async function expectAtLatestActivity(
  geometry: ChatScrollGeometry,
): Promise<void> {
  await waitFor(() => {
    expect(geometry.atBottom()).toBeTruthy();
    expect(
      queryAllByRoleFast("button").find((candidate) => {
        return candidate.getAttribute("aria-label") === "Scroll to bottom";
      }),
    ).toBeUndefined();
  });
}

test("Restore the reading position during keyboard thread navigation", async () => {
  context.mocks.browser.userAgent(LINUX_CHROME_USER_AGENT);
  const user = userEvent.setup({ delay: null });
  // Four message anchors in a shorter viewport keep message 2 away from both
  // scroll boundaries without rendering an unrelated third exchange.
  const viewportHeight = 240;
  const currentEvents = conversationEvents("keyboard-current", "Current", 2);
  mockThreadStories(KEYBOARD_CURRENT_THREAD_ID, [
    {
      id: KEYBOARD_PREVIOUS_THREAD_ID,
      title: "Previous keyboard thread",
      events: conversationEvents("keyboard-previous", "Previous", 1),
    },
    {
      id: KEYBOARD_CURRENT_THREAD_ID,
      title: "Current keyboard thread",
      events: currentEvents,
    },
  ]);

  await setupPage({
    context,
    host: APP_HOST,
    path: `/chats/${KEYBOARD_CURRENT_THREAD_ID}`,
  });

  const targetText = "Current message 2";
  await waitForInteractiveThread(
    KEYBOARD_CURRENT_THREAD_ID,
    "Current keyboard thread",
    targetText,
  );
  const initialGeometry = installChatScrollGeometry(
    threadContainer(KEYBOARD_CURRENT_THREAD_ID),
  );
  initialGeometry.setViewportHeight(viewportHeight);
  fireEvent.resize(window);
  await waitFor(() => {
    expect(initialGeometry.atBottom()).toBeTruthy();
  });
  await chooseReadingPosition(initialGeometry, targetText);
  expect(initialGeometry.atBottom()).toBeFalsy();

  threadSection(KEYBOARD_CURRENT_THREAD_ID).focus();
  expect(threadSection(KEYBOARD_CURRENT_THREAD_ID)).toHaveFocus();
  await user.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");
  await waitForInteractiveThread(
    KEYBOARD_PREVIOUS_THREAD_ID,
    "Previous keyboard thread",
    "Previous message 1",
  );

  threadSection(KEYBOARD_PREVIOUS_THREAD_ID).focus();
  expect(threadSection(KEYBOARD_PREVIOUS_THREAD_ID)).toHaveFocus();
  await user.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}");
  await waitForInteractiveThread(
    KEYBOARD_CURRENT_THREAD_ID,
    "Current keyboard thread",
    targetText,
  );
  const returnedGeometry = installChatScrollGeometry(
    threadContainer(KEYBOARD_CURRENT_THREAD_ID),
  );
  returnedGeometry.setViewportHeight(viewportHeight);
  fireEvent.resize(window);

  await expectReadingPosition(returnedGeometry, targetText);
  expect(returnedGeometry.atBottom()).toBeFalsy();
});

test("Restore the reading position after switching threads from the sidebar", async () => {
  // The current thread needs a middle anchor; the neighboring thread only
  // needs enough content to prove that sidebar navigation completed.
  mockThreadStories(SIDEBAR_CURRENT_THREAD_ID, [
    {
      id: SIDEBAR_OTHER_THREAD_ID,
      title: "Planning notes",
      events: conversationEvents("sidebar-other", "Planning", 1),
    },
    {
      id: SIDEBAR_CURRENT_THREAD_ID,
      title: "Research notes",
      events: conversationEvents("sidebar-current", "Research", 3),
    },
  ]);

  await setupPage({
    context,
    host: APP_HOST,
    path: `/chats/${SIDEBAR_CURRENT_THREAD_ID}`,
  });

  const targetText = "Research message 2";
  await waitForThreadMessage(SIDEBAR_CURRENT_THREAD_ID, targetText);
  const initialGeometry = installChatScrollGeometry(
    threadContainer(SIDEBAR_CURRENT_THREAD_ID),
  );
  fireEvent.resize(window);
  await waitFor(() => {
    expect(initialGeometry.atBottom()).toBeTruthy();
  });
  await chooseReadingPosition(initialGeometry, targetText);

  await waitForInteractiveThread(
    SIDEBAR_CURRENT_THREAD_ID,
    "Research notes",
    targetText,
  );
  const planningLink = sidebarThreadLink(
    SIDEBAR_OTHER_THREAD_ID,
    "Planning notes",
  );
  expect(planningLink).toHaveAttribute(
    "href",
    `/chats/${SIDEBAR_OTHER_THREAD_ID}`,
  );
  click(planningLink);
  await waitForInteractiveThread(
    SIDEBAR_OTHER_THREAD_ID,
    "Planning notes",
    "Planning message 1",
  );

  const researchLink = sidebarThreadLink(
    SIDEBAR_CURRENT_THREAD_ID,
    "Research notes",
  );
  expect(researchLink).toHaveAttribute(
    "href",
    `/chats/${SIDEBAR_CURRENT_THREAD_ID}`,
  );
  click(researchLink);
  await waitForInteractiveThread(
    SIDEBAR_CURRENT_THREAD_ID,
    "Research notes",
    targetText,
  );
  const returnedGeometry = installChatScrollGeometry(
    threadContainer(SIDEBAR_CURRENT_THREAD_ID),
  );
  fireEvent.resize(window);

  await expectReadingPosition(returnedGeometry, targetText);
});

test("Open a conversation at a linked message", async () => {
  const events = conversationEvents("deep-link", "Linked");
  mockChatLifecycleWithoutBrowserSession({
    threadId: DEEP_LINK_THREAD_ID,
    threadTitle: "Linked conversation",
    chatEvents: events,
  });
  const linkedEventId = "deep-link-user-3";

  await setupPage({
    context,
    host: APP_HOST,
    path: `/chats/${DEEP_LINK_THREAD_ID}#event-${linkedEventId}`,
  });

  const linkedText = "Linked message 3";
  await waitForThreadMessage(DEEP_LINK_THREAD_ID, linkedText);
  const geometry = installChatScrollGeometry(
    threadContainer(DEEP_LINK_THREAD_ID),
  );
  fireEvent.resize(window);

  await expectReadingPosition(geometry, linkedText, 0);
  expect(geometry.viewportOffsetFor("Linked message 6")).toBeGreaterThan(
    geometry.viewportHeight(),
  );
  expect(buttonNamed("Scroll to bottom")).toBeInTheDocument();
});

test("Expand folded work when opening a linked message", async () => {
  const linkedEventId = "folded-link-work-3";
  const linkedText = "Linked work detail";
  const events = conversationEvents("folded-link", "Linked")
    .flatMap((event) => {
      return event.id === "folded-link-assistant-3"
        ? [{ ...event, id: linkedEventId, content: linkedText }, event]
        : [event];
    })
    .map((event, index) => {
      return {
        ...event,
        seqId: index + 1,
        runGroupId:
          event.runId === "folded-link-run-3" ||
          event.runId === "folded-link-run-4"
            ? "folded-link-group"
            : undefined,
      };
    });
  mockChatLifecycleWithoutBrowserSession({
    threadId: DEEP_LINK_THREAD_ID,
    threadTitle: "Linked folded conversation",
    chatEvents: events,
  });

  await setupPage({
    context,
    host: APP_HOST,
    path: `/chats/${DEEP_LINK_THREAD_ID}#event-${linkedEventId}`,
  });

  await waitForThreadMessage(DEEP_LINK_THREAD_ID, linkedText);
  const geometry = installChatScrollGeometry(
    threadContainer(DEEP_LINK_THREAD_ID),
  );
  fireEvent.resize(window);

  await expectReadingPosition(geometry, linkedText, 0);
  expect(buttonNamed("Scroll to bottom")).toBeInTheDocument();
});

test("Open a conversation safely when a linked message is unavailable", async () => {
  mockChatLifecycleWithoutBrowserSession({
    threadId: MISSING_LINK_THREAD_ID,
    threadTitle: "Available conversation",
    chatEvents: conversationEvents("missing-link", "Available"),
  });

  await setupPage({
    context,
    host: APP_HOST,
    path: `/chats/${MISSING_LINK_THREAD_ID}#event-no-longer-available`,
  });

  const latestText = "Available reply 6";
  await waitForThreadMessage(MISSING_LINK_THREAD_ID, latestText);
  const geometry = installChatScrollGeometry(
    threadContainer(MISSING_LINK_THREAD_ID),
  );
  fireEvent.resize(window);

  await expectLatestActivity(geometry, latestText);
  expect(
    screen.queryByText("Send a message to start the conversation"),
  ).toBeNull();
});

test("Return to the latest message after sending from history", async () => {
  const user = userEvent.setup();
  const events = conversationEvents("send-history", "History");
  events.push({
    id: "send-history-active-user",
    role: "user",
    content: "Continue the active investigation",
    runId: "send-history-active-run",
    seqId: 19,
    createdAt: "2026-07-01T10:03:19Z",
  });
  mockChatLifecycleWithoutBrowserSession({
    threadId: SEND_FROM_HISTORY_THREAD_ID,
    threadTitle: "Active investigation",
    chatEvents: events,
    activeRunIds: ["send-history-active-run"],
  });

  await setupPage({
    context,
    host: APP_HOST,
    path: `/chats/${SEND_FROM_HISTORY_THREAD_ID}`,
  });

  const targetText = "History message 3";
  await waitForThreadMessage(SEND_FROM_HISTORY_THREAD_ID, targetText);
  const geometry = installChatScrollGeometry(
    threadContainer(SEND_FROM_HISTORY_THREAD_ID),
  );
  fireEvent.resize(window);
  await waitFor(() => {
    expect(geometry.atBottom()).toBeTruthy();
  });
  await chooseReadingPosition(geometry, targetText);

  const composer = await waitFor(() => {
    return screen.getByRole("textbox", { name: "Message" });
  });
  const sentText = "Add the latest deployment result";
  await fillComposer(composer, sentText);
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(composer).toHaveTextContent("");
    expect(screen.getByText(sentText)).toBeVisible();
  });
  geometry.refresh();
  fireEvent.resize(window);

  await expectAtLatestActivity(geometry);
});

test("Preserve the reading position while entering and leaving sharing mode", async () => {
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
  await waitForThreadMessage(SHARING_THREAD_ID, targetText);
  const geometry = installChatScrollGeometry(
    threadContainer(SHARING_THREAD_ID),
  );
  fireEvent.resize(window);
  await waitFor(() => {
    expect(geometry.atBottom()).toBeTruthy();
  });
  await chooseReadingPosition(geometry, targetText);

  click(buttonNamed("Share messages"));
  await waitFor(() => {
    expect(buttonNamed("Cancel")).toBeInTheDocument();
    expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);
  });
  geometry.setViewportHeight(VIEWPORT_HEIGHT - 80);
  geometry.refresh();
  fireEvent.resize(window);

  await expectReadingPosition(geometry, targetText);

  click(buttonNamed("Cancel"));
  await waitFor(() => {
    expect(buttonNamed("Share messages")).toBeInTheDocument();
    expect(screen.queryAllByText("0 selected")).toHaveLength(0);
  });
  geometry.setViewportHeight(VIEWPORT_HEIGHT);
  geometry.refresh();
  fireEvent.resize(window);

  await expectReadingPosition(geometry, targetText);
});
