import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  context,
  mockChatLifecycleWithoutBrowserSession,
  mockResizeObserver,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";

const THREAD_IDS = {
  overview: "b0000000-0000-4000-a000-000000000821",
  disabled: "b0000000-0000-4000-a000-000000000822",
  highlight: "b0000000-0000-4000-a000-000000000824",
  jump: "b0000000-0000-4000-a000-000000000825",
  page: "b0000000-0000-4000-a000-000000000826",
  activation: "b0000000-0000-4000-a000-000000000827",
  runWork: "b0000000-0000-4000-a000-000000000828",
} as const;

const TURN_STEP_PX = 100;
const TURN_HEIGHT_PX = 72;
const DEFAULT_VIEWPORT_HEIGHT_PX = 600;
const DEFAULT_RAIL_HEIGHT_PX = 320;

function conversationPairs(
  pairCount: number,
  fixtureKey: string,
): MockChatEventInput[] {
  return Array.from({ length: pairCount }, (_, index) => {
    const number = index + 1;
    const runId = `${fixtureKey}-run-${number.toString()}`;
    const minute = index.toString().padStart(2, "0");
    return [
      {
        id: `${fixtureKey}-question-${number.toString()}`,
        role: "user" as const,
        content: `Locator question ${number.toString()}`,
        runId,
        createdAt: `2026-08-01T10:${minute}:00.000Z`,
      },
      {
        id: `${fixtureKey}-answer-${number.toString()}`,
        role: "assistant" as const,
        content: `Locator answer ${number.toString()}`,
        runId,
        runLifecycleEvent: "completed" as const,
        createdAt: `2026-08-01T10:${minute}:30.000Z`,
      },
    ];
  }).flat();
}

function foldedRunWorkConversation(): MockChatEventInput[] {
  const triggerRunId = "locator-run-work-trigger";
  const goalRunId = "locator-run-work-goal";
  const goalGroupId = "locator-run-work-goal-group";
  return [
    ...conversationPairs(6, "locator-work-filler"),
    {
      id: "locator-work-question",
      role: "user",
      content: "Review the deployment",
      runId: triggerRunId,
      createdAt: "2026-08-01T12:00:00.000Z",
    },
    {
      id: "locator-work-early",
      role: "assistant",
      content: "Checked the first deployment region",
      runId: triggerRunId,
      createdAt: "2026-08-01T12:00:20.000Z",
    },
    {
      id: "locator-work-middle",
      role: "assistant",
      content: "Checked the second deployment region",
      runId: triggerRunId,
      createdAt: "2026-08-01T12:00:40.000Z",
    },
    {
      id: "locator-work-trigger-complete",
      role: "assistant",
      content: null,
      runId: triggerRunId,
      runLifecycleEvent: "completed",
      createdAt: "2026-08-01T12:00:41.000Z",
    },
    {
      id: "locator-work-goal-continuation",
      role: "user",
      eventType: "input.prompt",
      content: null,
      runId: goalRunId,
      runGroupId: goalGroupId,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "goal",
            goalBrief: "Keep checking the deployment regions",
          },
        ],
      },
      createdAt: "2026-08-01T12:00:50.000Z",
    },
    {
      id: "locator-work-final",
      role: "assistant",
      content: "All deployment regions are healthy",
      runId: goalRunId,
      runGroupId: goalGroupId,
      createdAt: "2026-08-01T12:01:00.000Z",
    },
    {
      id: "locator-work-complete",
      role: "assistant",
      content: null,
      runId: goalRunId,
      runGroupId: goalGroupId,
      runLifecycleEvent: "completed",
      createdAt: "2026-08-01T12:01:01.000Z",
    },
  ];
}

function requiredElement(selector: string, root: ParentNode = document) {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Required element not found: ${selector}`);
  }
  return element;
}

function topLevelTurnElements(content: HTMLElement): HTMLElement[] {
  return Array.from(
    content.querySelectorAll('[data-role="user"], [data-role="assistant"]'),
  ).filter((element): element is HTMLElement => {
    return (
      element instanceof HTMLElement &&
      !element.parentElement?.closest(
        '[data-role="user"], [data-role="assistant"]',
      )
    );
  });
}

function defineRect(
  element: HTMLElement,
  top: () => number,
  height: number,
  width = 800,
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return new DOMRect(0, top(), width, height);
    },
  });
}

interface LocatorGeometry {
  readonly rail: HTMLElement;
  readonly container: HTMLElement;
  readonly scrollRequests: ScrollToOptions[];
  readonly readScrollTop: () => number;
  readonly setScrollHeight: (value: number) => void;
  readonly setScrollTop: (value: number) => void;
}

function installLocatorGeometry({
  clientHeight = DEFAULT_VIEWPORT_HEIGHT_PX,
  railHeight = DEFAULT_RAIL_HEIGHT_PX,
  scrollHeight: requestedScrollHeight,
  initialScrollTop,
}: {
  readonly clientHeight?: number;
  readonly railHeight?: number;
  readonly scrollHeight?: number;
  readonly initialScrollTop?: number;
} = {}): LocatorGeometry {
  const container = requiredElement("[data-scroll-container]");
  const content = requiredElement("[data-message-container]", container);
  const rail = requiredElement("[data-conversation-locator]");
  const turns = topLevelTurnElements(content);
  let scrollHeight =
    requestedScrollHeight ??
    Math.max(turns.length * TURN_STEP_PX, clientHeight * 4);
  let scrollTop = initialScrollTop ?? Math.max(0, scrollHeight - clientHeight);
  const scrollRequests: ScrollToOptions[] = [];

  Object.defineProperties(container, {
    clientHeight: {
      configurable: true,
      get: () => {
        return clientHeight;
      },
    },
    scrollHeight: {
      configurable: true,
      get: () => {
        return scrollHeight;
      },
    },
    scrollTop: {
      configurable: true,
      get: () => {
        return scrollTop;
      },
      set: (value: number) => {
        scrollTop = value;
      },
    },
    scrollTo: {
      configurable: true,
      value: (optionsOrX?: ScrollToOptions | number, y?: number): void => {
        const options: ScrollToOptions =
          typeof optionsOrX === "object"
            ? optionsOrX
            : { left: optionsOrX, top: y };
        scrollRequests.push(options);
        if (options.top !== undefined) {
          scrollTop = options.top;
        }
      },
    },
  });
  Object.defineProperty(rail, "clientHeight", {
    configurable: true,
    get: () => {
      return railHeight;
    },
  });

  defineRect(
    container,
    () => {
      return 0;
    },
    clientHeight,
  );
  defineRect(
    content,
    () => {
      return -scrollTop;
    },
    scrollHeight,
  );
  defineRect(
    rail,
    () => {
      return 0;
    },
    railHeight,
    56,
  );

  for (const [index, turn] of turns.entries()) {
    const logicalTop = index * TURN_STEP_PX;
    const readTop = () => {
      return logicalTop - scrollTop;
    };
    defineRect(turn, readTop, TURN_HEIGHT_PX);
    const anchor = turn.matches("[data-chat-scroll-anchor-event-id]")
      ? turn
      : turn.querySelector("[data-chat-scroll-anchor-event-id]");
    if (anchor instanceof HTMLElement && anchor !== turn) {
      defineRect(anchor, readTop, TURN_HEIGHT_PX);
    }
  }

  return {
    rail,
    container,
    scrollRequests,
    readScrollTop: () => {
      return scrollTop;
    },
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
    setScrollTop: (value) => {
      scrollTop = value;
    },
  };
}

function locatorTicks(): HTMLElement[] {
  return Array.from(document.querySelectorAll("[data-locator-tick]")).filter(
    (element): element is HTMLElement => {
      return element instanceof HTMLElement;
    },
  );
}

async function expectLocatorTickCount(count: number): Promise<HTMLElement[]> {
  return await waitFor(() => {
    const ticks = locatorTicks();
    expect(ticks).toHaveLength(count);
    return ticks;
  });
}

function requiredTick(turnIndex: number): HTMLElement {
  return requiredElement(
    `[data-locator-tick][data-turn-index="${turnIndex.toString()}"]`,
  );
}

function movePointerToTick(rail: HTMLElement, tick: HTMLElement): void {
  const y = Number.parseFloat(tick.style.top);
  fireEvent.pointerMove(rail, { clientX: 24, clientY: y });
}

async function expectHotTick(turnIndex: number): Promise<void> {
  await waitFor(() => {
    const hotTicks = Array.from(
      document.querySelectorAll("[data-locator-hot]"),
    );
    expect(hotTicks).toHaveLength(1);
    expect(hotTicks[0]).toHaveAttribute(
      "data-turn-index",
      turnIndex.toString(),
    );
  });
}

function locatorPreview(): HTMLElement {
  return requiredElement("[data-conversation-locator-preview]");
}

function turnForText(text: string): HTMLElement {
  const turn = queryTurnForText(text);
  if (!(turn instanceof HTMLElement)) {
    throw new Error(`Turn not found for text: ${text}`);
  }
  return turn;
}

function queryTurnForText(text: string): HTMLElement | null {
  const content = requiredElement("[data-message-container]");
  const match = screen.queryAllByText(text).find((candidate) => {
    return content.contains(candidate);
  });
  const turn = match?.closest('[data-role="user"], [data-role="assistant"]');
  return turn instanceof HTMLElement ? turn : null;
}

function textForTick(tick: HTMLElement): string {
  const turnIndex = Number(tick.dataset.turnIndex);
  const pairNumber = Math.floor(turnIndex / 2) + 1;
  return tick.dataset.locatorTick === "user"
    ? `Locator question ${pairNumber.toString()}`
    : `Locator answer ${pairNumber.toString()}`;
}

async function pointAndSelectTurn(
  rail: HTMLElement,
  turnIndex: number,
  previewText: string,
): Promise<void> {
  movePointerToTick(rail, requiredTick(turnIndex));
  await expectHotTick(turnIndex);
  await waitFor(() => {
    expect(locatorPreview()).toHaveTextContent(previewText);
  });
  fireEvent.click(rail);
}

test("A long conversation has a bounded, readable locator overview", async () => {
  const resize = mockResizeObserver();
  mockChatLifecycleWithoutBrowserSession({
    threadId: THREAD_IDS.overview,
    threadTitle: "Locator overview",
    chatEvents: conversationPairs(16, "locator-overview"),
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_IDS.overview}`,
    host: "app.okou.ai",
  });

  await screen.findByText("Locator answer 16");
  installLocatorGeometry();
  fireEvent.resize(window);
  resize.automationAll();

  const ticks = await expectLocatorTickCount(24);
  const tops = ticks.map((tick) => {
    return Number.parseFloat(tick.style.top);
  });
  const gaps = tops.slice(1).map((top, index) => {
    return top - tops[index]!;
  });
  expect(new Set(gaps).size).toBe(1);
  expect(gaps[0]).toBeGreaterThan(0);
  expect(ticks).toHaveLength(24);
});

test("The conversation locator follows folded goal continuation work", async () => {
  const resize = mockResizeObserver();
  mockChatLifecycleWithoutBrowserSession({
    threadId: THREAD_IDS.runWork,
    threadTitle: "Run work locator",
    chatEvents: foldedRunWorkConversation(),
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_IDS.runWork}`,
    host: "app.okou.ai",
  });

  await screen.findByText("All deployment regions are healthy");
  expect(screen.queryByText("Checked the first deployment region")).toBeNull();
  expect(
    screen.queryByText("Keep checking the deployment regions"),
  ).not.toBeInTheDocument();
  const collapsedGeometry = installLocatorGeometry({ clientHeight: 360 });
  fireEvent.resize(window);
  resize.automationAll();
  await expectLocatorTickCount(14);
  fireEvent.pointerEnter(collapsedGeometry.rail);

  await pointAndSelectTurn(
    collapsedGeometry.rail,
    13,
    "All deployment regions are healthy",
  );
  await waitFor(() => {
    expect(
      turnForText("All deployment regions are healthy").querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
  });

  expect(
    screen.queryByText("Keep checking the deployment regions"),
  ).not.toBeInTheDocument();
});

test("The conversation locator makes the pointed turn easy to identify", async () => {
  const resize = mockResizeObserver();
  mockChatLifecycleWithoutBrowserSession({
    threadId: THREAD_IDS.highlight,
    threadTitle: "Locator highlighting",
    chatEvents: conversationPairs(16, "locator-highlight"),
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_IDS.highlight}`,
    host: "app.okou.ai",
  });

  await screen.findByText("Locator answer 16");
  const geometry = installLocatorGeometry();
  fireEvent.resize(window);
  resize.automationAll();
  const ticks = await expectLocatorTickCount(24);
  const selected = ticks[12]!;
  const near = ticks[14]!;
  const farther = ticks[16]!;
  const selectedIndex = Number(selected.dataset.turnIndex);

  fireEvent.pointerEnter(geometry.rail);
  movePointerToTick(geometry.rail, selected);
  await expectHotTick(selectedIndex);

  const selectedWidth = Number.parseFloat(selected.style.width);
  const nearWidth = Number.parseFloat(near.style.width);
  const fartherWidth = Number.parseFloat(farther.style.width);
  expect(selectedWidth).toBeGreaterThan(nearWidth);
  expect(nearWidth).toBeGreaterThan(fartherWidth);
});

test("Selecting a locator marker jumps to that conversation turn", async () => {
  const resize = mockResizeObserver();
  mockChatLifecycleWithoutBrowserSession({
    threadId: THREAD_IDS.jump,
    threadTitle: "Locator jumping",
    chatEvents: conversationPairs(16, "locator-jump"),
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_IDS.jump}`,
    host: "app.okou.ai",
  });

  await screen.findByText("Locator answer 16");
  const geometry = installLocatorGeometry();
  fireEvent.resize(window);
  resize.automationAll();
  const initialTicks = await expectLocatorTickCount(24);
  const firstTarget = initialTicks.find((tick) => {
    return queryTurnForText(textForTick(tick)) !== null;
  });
  if (!firstTarget) {
    throw new Error("Rendered locator target not found");
  }
  const firstIndex = Number(firstTarget.dataset.turnIndex);
  const firstText = textForTick(firstTarget);
  const firstTurn = turnForText(firstText);

  fireEvent.pointerEnter(geometry.rail);
  await pointAndSelectTurn(geometry.rail, firstIndex, firstText);
  await waitFor(() => {
    expect(
      firstTurn.querySelector("[data-locator-landed]"),
    ).toBeInTheDocument();
    expect(geometry.scrollRequests.at(-1)).toMatchObject({
      behavior: "smooth",
    });
  });
  const firstLandingTop = geometry.scrollRequests.at(-1)?.top;
  const firstHighlight = requiredElement("[data-locator-landed]", firstTurn);

  // Selecting the same turn again starts a fresh CSS highlight without
  // replacing the message or interrupting its content.
  await pointAndSelectTurn(geometry.rail, firstIndex, firstText);
  await waitFor(() => {
    expect(firstHighlight).not.toBeInTheDocument();
    expect(
      firstTurn.querySelector("[data-locator-landed]"),
    ).toBeInTheDocument();
  });

  const secondGeometry = installLocatorGeometry({
    initialScrollTop: geometry.readScrollTop(),
  });
  fireEvent.resize(window);
  resize.automationAll();
  const currentTicks = await expectLocatorTickCount(24);
  const secondTarget = [...currentTicks].reverse().find((tick) => {
    return (
      Number(tick.dataset.turnIndex) !== firstIndex &&
      queryTurnForText(textForTick(tick)) !== null
    );
  });
  if (!secondTarget) {
    throw new Error("Second locator target not found");
  }
  const secondIndex = Number(secondTarget.dataset.turnIndex);
  const secondText = textForTick(secondTarget);
  const secondTurn = turnForText(secondText);

  await pointAndSelectTurn(secondGeometry.rail, secondIndex, secondText);
  await waitFor(() => {
    expect(
      secondTurn.querySelector("[data-locator-landed]"),
    ).toBeInTheDocument();
    expect(firstTurn.querySelector("[data-locator-landed]")).toBeNull();
    expect(secondGeometry.scrollRequests.length).toBeGreaterThan(0);
  });
  expect(secondGeometry.scrollRequests.at(-1)).toMatchObject({
    behavior: "smooth",
  });
  expect(secondGeometry.scrollRequests.at(-1)?.top).not.toBe(firstLandingTop);
});

test("The conversation locator can page through older turns", async () => {
  const resize = mockResizeObserver();
  mockChatLifecycleWithoutBrowserSession({
    threadId: THREAD_IDS.page,
    threadTitle: "Locator paging",
    chatEvents: conversationPairs(16, "locator-page"),
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_IDS.page}`,
    host: "app.okou.ai",
  });

  await screen.findByText("Locator answer 16");
  const geometry = installLocatorGeometry();
  fireEvent.resize(window);
  resize.automationAll();
  const initialTicks = await expectLocatorTickCount(24);
  const initialFirstIndex = Number(initialTicks[0]!.dataset.turnIndex);
  const originalScrollTop = geometry.readScrollTop();

  fireEvent.pointerEnter(geometry.rail);
  movePointerToTick(geometry.rail, initialTicks[12]!);
  await expectHotTick(Number(initialTicks[12]!.dataset.turnIndex));
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: -52,
  });
  geometry.rail.dispatchEvent(wheel);

  await waitFor(() => {
    expect(Number(locatorTicks()[0]?.dataset.turnIndex)).toBe(
      initialFirstIndex - 2,
    );
  });
  expect(wheel.defaultPrevented).toBeTruthy();
  expect(geometry.readScrollTop()).toBe(originalScrollTop);

  fireEvent.pointerLeave(geometry.rail);
  await waitFor(() => {
    expect(Number(locatorTicks()[0]?.dataset.turnIndex)).toBe(
      initialFirstIndex,
    );
  });
});
