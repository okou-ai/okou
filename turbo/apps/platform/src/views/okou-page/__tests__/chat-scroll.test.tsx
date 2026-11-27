import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
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

function controlRevealFrames() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
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

test("A tall transcript fills its visible history and remains pinned when a new reply arrives", async () => {
  const events = pagedTurns(26);
  let height = 600;
  const pane = await openPagedHistory(events, () => {
    return height;
  });
  const transcript = within(pane);
  await transcript.findByText("Locator answer 26");
  expect(transcript.queryByText("Locator answer 20")).toBeNull();
  expect(transcript.queryByText("Locator answer 13")).toBeNull();
  await expectTail(pane);
  await waitFor(() => {
    expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
  });
  const frames = controlRevealFrames();
  height = 7200;
  fireEvent.resize(window);
  events.push(...pagedTurn(27));
  publishRunUpdate();
  await transcript.findByText("Locator answer 27");
  for (const turn of [20, 13]) {
    await frames.paint();
    await frames.paint();
    expect(transcript.getByText("Locator answer " + turn)).toBeVisible();
  }
  await frames.paint();
  await frames.paint();
  const leading = requiredElement('[data-transcript-spacer="before"]', pane);
  expect(leading.getBoundingClientRect().bottom).toBeLessThanOrEqual(0);
  expect(pane.scrollTop).toBe(pane.scrollHeight - pane.clientHeight);
  expect(transcript.queryByText("Locator answer 1")).toBeNull();
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
  const animatedReplies = () => {
    return Array.from(
      pane.querySelectorAll("picture > img[data-okou-avatar]"),
      (avatar) => {
        return avatar.closest('[data-role="assistant"]')?.textContent;
      },
    );
  };
  expect(animatedReplies()).toStrictEqual([
    expect.stringContaining("Locator answer 26"),
  ]);
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
  expect(animatedReplies()).toHaveLength(0);
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
  expect(animatedReplies()).toStrictEqual([
    expect.stringContaining("Locator answer 27"),
  ]);
  expect(decodedImages).not.toContain(image);
});

test("Closing Automations preserves a history reader's visible answer and distance from the bottom", async () => {
  const pane = await transcript();
  const answer = "Locator answer 5";
  await within(pane).findByText(answer);
  pane.scrollTop += messageOffset(answer, pane) - 73;
  fireEvent.scroll(pane);
  const at = messageOffset(answer, pane);
  const tail = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
  expect(at).toBeGreaterThanOrEqual(0);
  expect(at).toBeLessThan(pane.clientHeight);
  expect(tail).toBeGreaterThan(0);
  click(await findFastControl("button", "More actions"));
  click(
    await within(await screen.findByRole("menu")).findByText("Automations"),
  );
  const close = await findFastControl("button", "Close automations");
  click(close);
  await waitFor(() => {
    expect(close).not.toBeInTheDocument();
    expect(messageOffset(answer, pane)).toBe(at);
    expect(pane.scrollHeight - pane.scrollTop - pane.clientHeight).toBe(tail);
  });
});

test.each(["layout change", "tap"])(
  "The transcript shows the incoming reply at the bottom after a %s without a reading gesture",
  async (cause) => {
    const history = pagedTurns(10);
    const pane = await openPagedHistory(history);
    const messages = within(pane);
    await messages.findByText("Locator answer 10");
    await expectTail(pane);
    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    if (cause === "tap") {
      fireEvent.pointerDown(pane);
      fireEvent.pointerUp(pane);
    }
    const before = pane.scrollTop;
    pane.scrollTop = before - 80;
    fireEvent.scroll(pane);
    expect(queryFastControl("button", "Scroll to bottom")).toBeNull();
    const incoming = messages.findByText("The dispatch ledger is ready");
    history.push(...pagedTurn(11, "The dispatch ledger is ready"));
    publishRunUpdate();
    await expect(incoming).resolves.toBeVisible();
    await waitFor(
      () => {
        expect(pane.scrollTop).toBe(pane.scrollHeight - pane.clientHeight);
        expect(queryFastControl("button", "Scroll to bottom")).toBeNull();
      },
      { container: pane },
    );
  },
);

test("A completed turn delivered behind Automations stays accessible after the reader returns to history", async () => {
  context.mocks.browser.standaloneDisplayMode(true);
  const records = pagedTurns(26);
  const pane = await openPagedHistory(records);
  await within(pane).findByText("Locator answer 26");
  await expectTail(pane);
  fireEvent.scroll(pane);
  fireEvent.wheel(pane, { deltaY: 32 - pane.scrollTop });
  pane.scrollTop = 32;
  fireEvent.scroll(pane);
  fireEvent(pane, new Event("scrollend"));
  const anchor = "Locator question 1";
  await within(pane).findByText(anchor);
  const y = messageOffset(anchor, pane);
  click(await findFastControl("button", "More actions"));
  click(
    await within(await screen.findByRole("menu")).findByText("Automations"),
  );
  const close = await findFastControl("button", "Close automations");
  records.push(...pagedTurn(27, "Harbor inspection completed"));
  publishRunUpdate();
  await waitFor(() => {
    expect(
      document.querySelector('[data-locator-tick][data-turn-index="26"]'),
    ).toBeInTheDocument();
  });
  click(close);
  await waitFor(() => {
    expect(close).not.toBeInTheDocument();
    expect(messageOffset(anchor, pane)).toBe(y);
  });
  click(await findFastControl("button", "Scroll to bottom"));
  await expect(
    within(pane).findByText("Harbor inspection completed"),
  ).resolves.toBeVisible();
});

test("Avatar loading preserves a wheel movement before scroll delivery", async () => {
  const pane = await transcript();
  const reading = pane.scrollTop - 320;
  fireEvent.wheel(pane, { deltaY: -320 });
  pane.scrollTop = reading;
  fireEvent.scroll(pane);
  const avatar = requiredElement("img[data-okou-avatar]", pane);
  fireEvent.wheel(pane, { deltaY: 60 });
  pane.scrollTop = reading + 60;
  fireEvent.load(avatar);
  expect(pane.scrollTop).toBe(reading + 60);
});

test("A browser without overflow anchoring keeps its reading offset when the preceding page mounts", async () => {
  const css = CSS;
  vi.stubGlobal("CSS", css);
  const supported = css.supports.bind(css);
  vi.spyOn(css, "supports").mockImplementation((property, value?: string) => {
    if (property === "overflow-anchor") {
      return false;
    }
    return value === undefined
      ? supported(property)
      : supported(property, value);
  });
  const pane = await openPagedHistory(pagedTurns(26));
  await within(pane).findByText("Locator answer 26");
  await expectTail(pane);
  const selector = "[data-chat-scroll-anchor-event-id]";
  const first = requiredElement(selector, pane);
  const delta =
    first.getBoundingClientRect().top - pane.getBoundingClientRect().top + 30;
  fireEvent.scroll(pane);
  fireEvent.wheel(pane, { deltaY: delta });
  pane.scrollTop += delta;
  fireEvent.scroll(pane);
  fireEvent(pane, new Event("scrollend"));
  await waitFor(() => {
    expect(pane.querySelector(selector)).not.toBe(first);
    expect(first).toBeInTheDocument();
    expect(
      first.getBoundingClientRect().top - pane.getBoundingClientRect().top,
    ).toBe(-30);
  });
});
