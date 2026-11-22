import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  publishRunUpdate,
  RUN_THREAD_ID,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  conversationEvents,
  mockChatGeometry,
  requiredElement,
  messageOffset,
} from "./chat-conversation-locator-test-helpers.ts";
// Render real diagrams so a skipped page cannot silently decode the test image.
vi.mock("@okouai/mermaid-lite", async () => {
  return await import("mermaid-lite-real");
});

const context = testContext();
async function transcript() {
  context.mocks.browser.standaloneDisplayMode(true);
  mockChatGeometry();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return Object.hasOwn(this.dataset, "scrollContainer") ? 390 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return Object.hasOwn(this.dataset, "scrollContainer")
        ? this.querySelectorAll("[data-chat-scroll-anchor-event-id]").length *
            240
        : 0;
    },
  );
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: conversationEvents(6),
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Locator answer 6");
  const pane = requiredElement("[data-scroll-container]");
  await waitFor(() => {
    expect(pane.scrollTop).toBe(pane.scrollHeight - pane.clientHeight);
  });
  return pane;
}
test("chat-scroll-002 revealing the transcript restores the visible tail message with a single adjustment", async () => {
  const pane = await transcript(),
    last = "Locator answer 6",
    position = messageOffset(last, pane);
  expect(position).toBeGreaterThanOrEqual(0);
  expect(position).toBeLessThan(pane.clientHeight);
  click(await findFastControl("button", "More actions"));
  click(
    await within(await screen.findByRole("menu")).findByText("Automations"),
  );
  const close = await findFastControl("button", "Close automations"),
    writes = vi.spyOn(HTMLElement.prototype, "scrollTop", "set");
  click(close);
  await waitFor(() => {
    expect(close).not.toBeInTheDocument();
    expect(messageOffset(last, pane)).toBe(position);
  });
  expect(
    writes.mock.contexts.filter((target) => {
      return target === pane;
    }),
  ).toHaveLength(1);
});
test("chat-scroll-016 the focused multiline draft and transcript tail survive three keyboard viewport cycles and layout resize", async () => {
  const viewport = Object.assign(new EventTarget(), {
      height: 600,
      width: 390,
      offsetTop: 0,
    }),
    previous = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (previous) {
        Object.defineProperty(window, "visualViewport", previous);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    },
    { once: true },
  );
  const pane = await transcript();
  let height = 600;
  Object.defineProperty(pane, "clientHeight", {
    configurable: true,
    get() {
      return height;
    },
  });
  const editor = await findComposerEditor(),
    lines = ["Harbor plan", "Retain this next line"];
  await fill(editor, lines.join("\n"));
  editor.focus();
  async function read() {
    await waitFor(() => {
      expect(pane.scrollTop).toBe(pane.scrollHeight - pane.clientHeight);
      expect(editor).toHaveFocus();
      expect(
        Array.from(editor.querySelectorAll("p")).map((line) => {
          return line.textContent;
        }),
      ).toStrictEqual(lines);
    });
  }
  for (const reduction of [145, 175, 160]) {
    height = 600 - reduction;
    viewport.height = height;
    viewport.dispatchEvent(new Event("resize"));
    await read();
    viewport.offsetTop = 50;
    viewport.dispatchEvent(new Event("scroll"));
    await read();
    height = 600;
    viewport.height = height;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    await read();
  }
  height = 550;
  fireEvent.resize(window);
  await read();
  expect(viewport.offsetTop).toBe(0);
});

function pagedTurn(turn: number, answer = "Locator answer " + turn) {
  const runId = "ae000000-0000-4000-a000-" + String(turn).padStart(12, "0");
  const seqId = 3 * turn - 2;
  const event = (seq: number) => {
    return {
      id: "af000000-0000-4000-a000-" + String(seq).padStart(12, "0"),
      seqId: seq,
      runId,
      createdAt: new Date(Date.UTC(2026, 9, 1, 11, 0, seq)).toISOString(),
    };
  };
  return [
    {
      ...event(seqId),
      role: "user" as const,
      content: "Locator question " + turn,
    },
    {
      ...event(seqId + 1),
      role: "assistant" as const,
      content: answer,
    },
    {
      ...event(seqId + 2),
      role: "assistant" as const,
      content: null,
      runLifecycleEvent: "completed" as const,
    },
  ];
}

function pagedTurns(
  turns: number,
  diagram?: { turn: number; markdown: string },
) {
  return Array.from({ length: turns }, (_, i) => {
    return pagedTurn(
      i + 1,
      diagram?.turn === i + 1 ? diagram.markdown : undefined,
    );
  }).flat();
}

async function openPagedHistory(
  events: ReturnType<typeof pagedTurns>,
  height = () => {
    return 600;
  },
) {
  mockChatGeometry(height, 100);
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    const rows = mockChatEventRows(
      normalizeMockChatEvents(events, RUN_THREAD_ID),
    );
    return respond(200, {
      events: Object.fromEntries(
        body.map(([thread, after]) => {
          return [
            thread,
            thread === RUN_THREAD_ID
              ? rows.filter((row) => {
                  return row.seqId > after;
                })
              : [],
          ];
        }),
      ),
      notFoundThreads: [],
    });
  });
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID, chatEvents: events });
  await setupPage({ context, path: RUN_PATH });
  return requiredElement("[data-scroll-container]");
}

function expectTail(pane: HTMLElement) {
  return waitFor(() => {
    expect(pane.scrollTop).toBe(pane.scrollHeight - pane.clientHeight);
  });
}

test.each([19, 20])(
  "Opening a %i-group transcript pins its latest answer",
  async (groups) => {
    const records = pagedTurns(10);
    const pane = await openPagedHistory(records.slice(20 - groups));
    await within(pane).findByText("Locator answer 10");
    expect(Boolean(within(pane).queryByText("Locator question 6"))).toBe(
      groups === 20,
    );
    await expectTail(pane);
  },
);

test("A tall transcript fills its visible history and remains pinned when a new reply arrives", async () => {
  const events = pagedTurns(26);
  let height = 600;
  const pane = await openPagedHistory(events, () => {
    return height;
  });
  await within(pane).findByText("Locator answer 26");
  await expectTail(pane);
  await waitFor(() => {
    expect(context.mocks.ably.hasSharedDatabaseSubscription()).toBeTruthy();
  });
  height = 7200;
  fireEvent.resize(window);
  events.push(...pagedTurn(27));
  publishRunUpdate();
  await within(pane).findByText("Locator answer 27");
  await within(pane).findByText("Locator answer 20");
  await within(pane).findByText("Locator answer 13");
  await waitFor(() => {
    expect(
      requiredElement(
        '[data-transcript-spacer="before"]',
        pane,
      ).getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(0);
  });
  await expectTail(pane);
});

test("Scrolling back to the beginning keeps that turn mounted until the reader returns to the new reply", async () => {
  const image = "https://diagram.example.test/freight.png";
  const decodedImages: string[] = [];
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    decodedImages.push(this.src);
    return Promise.resolve();
  });
  const events = pagedTurns(26, {
    turn: 13,
    markdown:
      '```mermaid\nflowchart LR\n  Port@{ img: "' + image + '", h: 80 }\n```',
  });
  const pane = await openPagedHistory(events);
  await within(pane).findByText("Locator answer 26");
  await expectTail(pane);
  const leading = requiredElement('[data-transcript-spacer="before"]', pane);
  const estimated = leading.getBoundingClientRect().height;
  expect(
    within(pane).queryByText("Locator question 1"),
  ).not.toBeInTheDocument();
  fireEvent.scroll(pane);
  fireEvent.wheel(pane, { deltaY: 48 - pane.scrollTop });
  pane.scrollTop = 48;
  fireEvent.scroll(pane);
  fireEvent(pane, new Event("scrollend"));
  await within(pane).findByText("Locator question 1");
  await waitFor(() => {
    expect(
      within(pane).queryByText("Locator answer 26"),
    ).not.toBeInTheDocument();
    expect(messageOffset("Locator question 1", pane)).toBeGreaterThan(-80);
    expect(messageOffset("Locator question 1", pane)).toBeLessThanOrEqual(0);
  });
  events.push(...pagedTurn(27));
  publishRunUpdate();
  await waitFor(() => {
    expect(
      document.querySelector('[data-locator-tick][data-turn-index="26"]'),
    ).toBeInTheDocument();
  });
  expect(within(pane).queryByText("Locator answer 27")).not.toBeInTheDocument();
  expect(messageOffset("Locator question 1", pane)).toBeGreaterThan(-80);
  expect(messageOffset("Locator question 1", pane)).toBeLessThanOrEqual(0);
  click(await findFastControl("button", "Scroll to bottom"));
  await within(pane).findByText("Locator answer 27");
  await expectTail(pane);
  expect(leading.getBoundingClientRect().height).toBeGreaterThan(estimated);
  expect(decodedImages).not.toContain(image);
});
