import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const thread = "a0000000-0000-4000-a000-000000000470";
async function focusConversation() {
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
  );
  createMessageExperienceHelpers(context).installMessageExperienceChat({
    threadId: thread,
    threadTitle: "Client workshop",
  });
  await setupPage({
    context,
    path: "/chats/" + thread,
    host: "app.okou.ai",
    sharedWorkerTestTransport: "message-port",
  });
  const message = await screen.findByRole("textbox", { name: "Message" });
  await userEvent.click(message);
  expect(message).toHaveFocus();
  return message;
}
test("keyboard-shortcut-hints-001 Command Shift O starts a fresh My Okou chat from the focused message", async () => {
  const message = await focusConversation();
  await userEvent.type(message, "Draft in the workshop");
  await userEvent.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await waitFor(() => {
    expect(location.pathname).toBe("/");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      /^$/,
    );
  });
});
test("keyboard-shortcut-hints-005 Command Shift F moves editing focus into workspace search", async () => {
  await focusConversation();
  await userEvent.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  await waitFor(() => {
    expect(within(dialog).getByRole("combobox")).toHaveFocus();
  });
});
