import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { RUN_THREAD_ID, RUN_PATH } from "./chat-run-test-fixtures.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  conversationEvents,
  mockChatGeometry,
  requiredElement,
  messageOffset,
} from "./chat-conversation-locator-test-helpers.ts";
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
