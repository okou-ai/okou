import { fireEvent, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function sidebar(size: number, standalone: boolean) {
  context.mocks.browser.userAgent(
    standalone
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/135.0 Safari/537.36"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/135.0",
  );
  context.mocks.browser.platform(standalone ? "MacIntel" : "Win32");
  context.mocks.browser.matchMedia((q) => {
    return (
      q.includes("min-width") ||
      (standalone && q === "(display-mode: standalone)")
    );
  });
  const threads = Array.from({ length: size }, (_, i) => {
    return chatListThread(i + 1, "Chat " + (i + 1));
  });
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 800,
    threads,
  });
  await setupPage({
    context,
    ...pageOptions,
    path: "/chats/" + threads[0]!.id,
  });
  await findFastControl("link", "Chat 1");
  return threads;
}
test("thread-list-number-shortcuts-002 The standalone Mac shortcut opens the ninth visible chat and clears its hints", async () => {
  const threads = await sidebar(9, true);
  const user = userEvent.setup({ delay: null });
  // The chat list orders unpinned conversations newest first.
  const ninth = await findFastControl("link", "Chat 1");
  click(await findFastControl("link", "Chat 9"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + threads[8]!.id);
  });
  await user.keyboard("{Meta>}");
  await within(ninth).findByText("⌘9", { selector: "kbd" });
  await user.keyboard("9{/Meta}");
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + threads[0]!.id);
  });
  expect(screen.queryByText("⌘9", { selector: "kbd" })).toBeNull();
});
test("thread-list-number-shortcuts-003 The browser retains its Ctrl+1 shortcut while a chat is open", async () => {
  const threads = await sidebar(2, false);
  const event = new KeyboardEvent("keydown", {
    key: "1",
    code: "Digit1",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(document.body, event);
  expect(event.defaultPrevented).toBeFalsy();
  expect(location.pathname).toBe("/chats/" + threads[0]!.id);
  expect(screen.queryByText(/(?:Ctrl\+|⌘)1/, { selector: "kbd" })).toBeNull();
});
