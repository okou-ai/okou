import { fireEvent, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  chatScrollContainer,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  promptEvent,
  publishRunUpdate,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const ROW_HEIGHT = 240;
const MORE_ACTIONS = "More actions";
const VIEWPORT_HEIGHT = 600;
const ANCHOR_SELECTOR = "[data-chat-scroll-anchor-event-id]";

interface ChatLayout {
  /** Height added above the anchored rows, e.g. a late-loading image. */
  extraTop: number;
  /** Scroll offsets written to the transcript while it is displayed. */
  readonly writes: number[];
}

function anchors(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR));
}

function isScrollContainer(element: HTMLElement): boolean {
  return Object.hasOwn(element.dataset, "scrollContainer");
}

/** The narrow shell hides the transcript with `hidden xl:flex`. */
function isDisplayed(element: HTMLElement): boolean {
  return (
    element.closest(".hidden") === null ||
    window.matchMedia("(min-width: 80rem)").matches
  );
}

/** Happy DOM has no layout engine; rows stack at a fixed height. */
function mockChatLayout(): ChatLayout {
  const layout: ChatLayout = { extraTop: 0, writes: [] };
  const positions = new WeakMap<HTMLElement, number>();
  // A transcript that stops being displayed loses its scroll offset.
  const observer = new MutationObserver(() => {
    for (const container of document.querySelectorAll<HTMLElement>(
      "[data-scroll-container]",
    )) {
      if (!isDisplayed(container)) {
        positions.set(container, 0);
      }
    }
  });
  observer.observe(document.body, {
    attributeFilter: ["class"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  context.signal.addEventListener("abort", () => {
    observer.disconnect();
  });
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const contentHeight = (container: HTMLElement) => {
    return layout.extraTop + anchors(container).length * ROW_HEIGHT;
  };
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return isScrollContainer(this) && isDisplayed(this) ? VIEWPORT_HEIGHT : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return isScrollContainer(this) && isDisplayed(this) ? 800 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return isScrollContainer(this) && isDisplayed(this)
        ? Math.max(contentHeight(this), VIEWPORT_HEIGHT)
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
    function (this: HTMLElement) {
      return isScrollContainer(this) && !isDisplayed(this)
        ? 0
        : (positions.get(this) ?? 0);
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
    function (this: HTMLElement, value: number) {
      if (isScrollContainer(this) && isDisplayed(this)) {
        layout.writes.push(value);
      }
      positions.set(
        this,
        isScrollContainer(this)
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
    this.scrollTop =
      typeof options === "number" ? (y ?? 0) : (options?.top ?? this.scrollTop);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (isScrollContainer(this)) {
        return isDisplayed(this)
          ? new DOMRect(0, 0, 800, VIEWPORT_HEIGHT)
          : new DOMRect(0, 0, 0, 0);
      }
      const container = this.closest<HTMLElement>("[data-scroll-container]");
      if (
        container &&
        this.matches(ANCHOR_SELECTOR) &&
        isDisplayed(container)
      ) {
        return new DOMRect(
          0,
          layout.extraTop +
            anchors(container).indexOf(this) * ROW_HEIGHT -
            container.scrollTop,
          800,
          ROW_HEIGHT,
        );
      }
      return originalRect.call(this);
    },
  );
  return layout;
}

function turnEvents(first: number, last: number): MockChatEventInput[] {
  const events: MockChatEventInput[] = [];
  for (let n = first; n <= last; n += 1) {
    const runId = `a0000000-0000-4000-a000-0000000004${n.toString().padStart(2, "0")}`;
    events.push(
      promptEvent({
        id: `question-${n.toString()}`,
        runId,
        seqId: n * 3 - 2,
        text: `History question ${n.toString()}`,
      }),
      assistantEvent({
        id: `answer-${n.toString()}`,
        runId,
        seqId: n * 3 - 1,
        text: `History answer ${n.toString()}`,
      }),
      completedEvent({ id: `completed-${n.toString()}`, runId, seqId: n * 3 }),
    );
  }
  return events;
}

function anchorFor(text: string): HTMLElement {
  const anchor = within(chatScrollContainer())
    .getByText(text)
    .closest<HTMLElement>(ANCHOR_SELECTOR);
  if (!anchor) {
    throw new Error(`Expected a scroll anchor for ${text}`);
  }
  return anchor;
}

function screenOffset(text: string): number {
  return anchorFor(text).getBoundingClientRect().top;
}

async function openConversation(
  chatEvents: MockChatEventInput[],
): Promise<HTMLElement> {
  installRunChat({ chatEvents });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const container = chatScrollContainer();
  await waitFor(() => {
    expect(container.scrollTop).toBe(
      container.scrollHeight - container.clientHeight,
    );
  });
  return container;
}

/** The reader drags the transcript to an offset; scroll events are async. */
function readerScrollsTo(container: HTMLElement, scrollTop: number): void {
  container.scrollTop = scrollTop;
  fireEvent.scroll(container);
}

test("Preserve the visible message as content grows", async () => {
  const layout = mockChatLayout();
  const events = turnEvents(1, 12);
  const imageAnswer = events.findIndex((event) => {
    return event.id === "answer-10";
  });
  events[imageAnswer] = assistantEvent({
    id: "answer-10",
    runId: "a0000000-0000-4000-a000-000000000410",
    seqId: 29,
    text: "History answer 10 ![Rollout chart](https://images.example.com/rollout.png)",
  });
  const container = await openConversation(events);
  readerScrollsTo(container, 500);
  const anchorOffset = screenOffset("History question 11");
  const image = await within(container).findByRole("img", {
    name: "Rollout chart",
  });

  layout.extraTop += 75;
  fireEvent.load(image);

  await waitFor(() => {
    expect(screenOffset("History question 11")).toBe(anchorOffset);
  });
  expect(container.scrollTop).toBe(575);
});

test("Preserve the reading position when new messages are added", async () => {
  mockChatLayout();
  const events = turnEvents(1, 12);
  const container = await openConversation(events);
  readerScrollsTo(container, 500);
  const anchorOffset = screenOffset("History question 11");

  events.push(...turnEvents(13, 13));
  publishRunUpdate();
  await expect(
    within(container).findByText("History answer 13"),
  ).resolves.toBeVisible();
  expect(screenOffset("History question 11")).toBe(anchorOffset);

  events.push(...turnEvents(14, 14));
  publishRunUpdate();
  await expect(
    within(container).findByText("History answer 14"),
  ).resolves.toBeVisible();
  expect(within(container).getByText("History answer 13")).toBeVisible();
  expect(screenOffset("History question 11")).toBe(anchorOffset);
});

test("Loading older messages preserves the reading position", async () => {
  mockChatLayout();
  const container = await openConversation(turnEvents(1, 12));
  expect(
    within(container).queryByText("History question 6"),
  ).not.toBeInTheDocument();
  readerScrollsTo(container, 40);
  const anchorOffset = screenOffset("History question 10");

  await expect(
    within(container).findByText("History question 6"),
  ).resolves.toBeVisible();
  expect(screenOffset("History question 10")).toBe(anchorOffset);
});

test("Load earlier messages once scrolling stops near the top", async () => {
  mockChatLayout();
  const container = await openConversation(turnEvents(1, 12));
  readerScrollsTo(container, 40);
  const anchorOffset = screenOffset("History question 10");
  readerScrollsTo(container, 400);
  readerScrollsTo(container, 40);

  await expect(
    within(container).findByText("History question 6"),
  ).resolves.toBeVisible();
  expect(screenOffset("History question 10")).toBe(anchorOffset);
  expect(within(container).queryByText("History question 4")).toBeNull();
});

function controlNamed(
  role: "button" | "menuitem",
  name: string,
): HTMLElement | null {
  return (
    queryAllByRoleFast(role).find((element) => {
      return (
        element.getAttribute("aria-label") === name ||
        element.textContent?.replace(/\s+/gu, " ").trim() === name
      );
    }) ?? null
  );
}

function findControl(
  role: "button" | "menuitem",
  name: string,
): Promise<HTMLElement> {
  return waitFor(() => {
    const control = controlNamed(role, name);
    if (!control) {
      throw new Error(`Expected ${role} named ${name}`);
    }
    return control;
  });
}

async function openAutomations(): Promise<void> {
  const more = queryAllByRoleFast("button").filter((button) => {
    return button.getAttribute("aria-label") === MORE_ACTIONS;
  });
  const trigger = more.at(-1);
  if (!trigger) {
    throw new Error("Expected the chat More actions button");
  }
  click(trigger);
  click(await findControl("menuitem", "Automations"));
  await findControl("button", "Close automations");
  await waitFor(() => {
    expect(chatScrollContainer().clientHeight).toBe(0);
  });
}

async function closeAutomations(): Promise<void> {
  const close = controlNamed("button", "Close automations");
  if (!close) {
    throw new Error("Expected the Close automations button");
  }
  click(close);
  await waitFor(() => {
    expect(chatScrollContainer().clientHeight).toBe(VIEWPORT_HEIGHT);
  });
}

/**
 * Three turns fit one history window, so a scroll settling while the
 * transcript is hidden has no earlier history to load.
 */
test("Restore history once after a narrow automation sidebar reveals the transcript", async () => {
  const layout = mockChatLayout();
  context.mocks.browser.matchMedia(false);
  const container = await openConversation(turnEvents(1, 3));
  readerScrollsTo(container, 500);
  const anchorOffset = screenOffset("History question 2");

  await openAutomations();
  layout.writes.length = 0;
  await closeAutomations();

  await waitFor(() => {
    expect(screenOffset("History question 2")).toBe(anchorOffset);
  });
  expect(layout.writes).toStrictEqual([500]);
});

test("Restore tail once after a narrow automation sidebar reveals the transcript", async () => {
  const layout = mockChatLayout();
  context.mocks.browser.matchMedia(false);
  const container = await openConversation(turnEvents(1, 3));
  const anchorOffset = screenOffset("History answer 3");

  await openAutomations();
  layout.writes.length = 0;
  await closeAutomations();

  await waitFor(() => {
    expect(screenOffset("History answer 3")).toBe(anchorOffset);
  });
  expect(layout.writes).toHaveLength(1);
  expect(container.scrollTop).toBe(
    container.scrollHeight - container.clientHeight,
  );
});

test("Keep a fresh live history capture after tail when incoming messages arrive while hidden", async () => {
  mockChatLayout();
  context.mocks.browser.matchMedia(false);
  const events = turnEvents(1, 3);
  const container = await openConversation(events);
  readerScrollsTo(container, 275);
  const anchorOffset = screenOffset("History question 2");

  await openAutomations();
  events.push(...turnEvents(4, 4));
  publishRunUpdate();
  await expect(
    within(container).findByText("History answer 4"),
  ).resolves.toBeInTheDocument();
  await closeAutomations();

  await waitFor(() => {
    expect(container.scrollTop).toBe(275);
  });
  expect(screenOffset("History question 2")).toBe(anchorOffset);
});
