import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

test("chat-composer-keyboard-002 Shift Enter keeps both lines editable during an active run", async () => {
  const sent = context.mocks.deferred<void>();
  context.mocks.data.userPreferences({ sendMode: "enter" });
  mockChatLifecycle(context, {
    onQueuedEventAppend: () => {
      return sent.resolve();
    },
    onSendRequest: () => {
      return sent.resolve();
    },
    threadId: RUN_THREAD_ID,
    activeRunIds: ["pending-review"],
    chatEvents: [
      {
        createdAt: "2026-08-01T10:00:00Z",
        role: "user",
        content: "Review is underway",
        runId: "pending-review",
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Review is underway");
  const editor = await findComposer();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  await user.keyboard("Keep this draft{Shift>}{Enter}{/Shift}on two lines");
  expect(editor).toHaveFocus();
  expect(sent.settled()).toBeFalsy();
  expect(editor.innerHTML).toMatch(
    /Keep this draft(?:<br[^>]*>|<\/p><p>)on two lines/u,
  );
  expect(
    document.querySelector('[data-role="user"]')?.textContent,
  ).not.toContain("Keep this draft");
});

test("chat-composer-keyboard-003 Control Enter sends the complete Linux draft after plain Enter added a line", async () => {
  context.mocks.browser.userAgent("Mozilla/5.0 (X11; Linux x86_64)");
  context.mocks.data.userPreferences({ sendMode: "cmd-enter" });
  const sent = context.mocks.deferred<string>();
  mockChatLifecycle(context, {
    onSendRequest: (b) => {
      return sent.resolve(b.prompt);
    },
  });
  await setupPage({ context, path: "/" });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await userEvent.click(editor);
  await userEvent.keyboard("Review the campaign{Enter}before publishing");
  expect(editor).toHaveFocus();
  expect(sent.settled()).toBeFalsy();
  expect(editor).toHaveTextContent("before publishing");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await expect(sent.promise).resolves.toBe(
    "Review the campaign\nbefore publishing",
  );
  await screen.findByText(/Review the campaign.*before publishing/s, {
    selector: "[data-role=user] *",
  });
  await findFastControl("button", /Stop/i);
});

test("chat-composer-keyboard-005 Android keyboard height and Control distinguish newline from sending", async () => {
  const viewport = Object.assign(new EventTarget(), {
    height: innerHeight,
    width: 390,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
  });
  vi.stubGlobal("visualViewport", viewport);
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
  );
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)" || query === "(any-pointer: fine)";
  });
  context.mocks.data.userPreferences({ sendMode: "enter" });
  const sent: string[] = [];
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    onSendRequest(body) {
      sent.push(body.prompt);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  const user = userEvent.setup({ delay: null });
  async function keyboard(open: boolean) {
    viewport.height = innerHeight - (open ? 320 : 0);
    viewport.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      expect(document.documentElement.dataset.keyboardOpen === "true").toBe(
        open,
      );
    });
  }
  const editor = await findComposer();
  await user.click(editor);
  await keyboard(true);
  await user.paste("Draft from the on-screen keyboard");
  await user.keyboard("{Enter}");
  await user.paste("with a second line");
  expect(sent).toStrictEqual([]);
  expect(editor.innerHTML).toMatch(
    /keyboard(?:<br[^>]*>|<\/p><p>)with a second line/,
  );
  await keyboard(false);
  await user.keyboard("{Enter}");
  const combined = "Draft from the on-screen keyboard\nwith a second line";
  await waitFor(() => {
    expect(sent).toContain(combined);
  });
  await screen.findByText(
    /Draft from the on-screen keyboard.*with a second line/s,
    { selector: "[data-role=user] *" },
  );
  await findFastControl("button", /Stop/i);
  await user.click(await findComposer());
  await keyboard(true);
  await user.paste("Send with the hardware shortcut");
  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => {
    expect(sent).toStrictEqual([combined, "Send with the hardware shortcut"]);
  });
});
