import { chatThreadRenameContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

async function visitEmoji(desktop: boolean, save?: Promise<void>) {
  const media = context.mocks.browser.matchMedia((q) => {
    return desktop && q.includes("min-width");
  });
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    threadTitle: save ? "Emoji planning" : "😀 Emoji planning",
  });
  if (save) {
    context.mocks.api(chatThreadRenameContract.rename, async ({ respond }) => {
      await save;
      return respond(204);
    });
  }
  await setupPage({ context, path: RUN_PATH });
  const trigger = await findFastControl("button", "Change icon");
  return { media, trigger };
}
test("chat-emoji-003 moving to desktop keeps the chat emoji and a single page title", async () => {
  const { media, trigger } = await visitEmoji(false);
  expect(trigger).toHaveTextContent("😀");
  media.setMatches((q) => {
    return q.includes("min-width");
  });
  await findFastControl("button", "More actions");
  await expect(
    findFastControl("button", "Change icon"),
  ).resolves.toHaveTextContent("😀");
  expect(screen.getAllByTestId("chat-thread-header-title")).toHaveLength(1);
  expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
    "Emoji planning",
  );
});
test.each([
  ["006", false],
  ["007", true],
] as const)(
  "chat-emoji-%s changing the viewport preserves the active eye search",
  async (_id, desktop) => {
    const { trigger, media } = await visitEmoji(desktop);
    click(trigger);
    const search = await screen.findByPlaceholderText("Search emoji");
    await userEvent.type(search, "eye");
    media.setMatches((q) => {
      return !desktop && q.includes("min-width");
    });
    await waitFor(() => {
      const input = screen.getByPlaceholderText("Search emoji");
      expect(input).toHaveValue("eye");
      expect(input).toHaveFocus();
    });
    expect(screen.getAllByPlaceholderText("Search emoji")).toHaveLength(1);
    expect(screen.getAllByTestId("chat-thread-header-title")).toHaveLength(1);
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Emoji planning",
    );
    await expect(
      findFastControl("button", "eyes"),
    ).resolves.toBeInTheDocument();
    await expect(
      findFastControl("button", "face with rolling eyes"),
    ).resolves.toBeInTheDocument();
  },
);
test("chat-emoji-005 the chat takes focus after its change-icon button closes the picker", async () => {
  const { trigger } = await visitEmoji(false);
  click(trigger);
  await screen.findByPlaceholderText("Search emoji");
  click(trigger);
  await waitFor(() => {
    expect(screen.queryByPlaceholderText("Search emoji")).toBeNull();
    expect(
      document.activeElement?.closest("[data-chat-thread-container-id]"),
    ).toHaveAttribute("data-chat-thread-container-id", RUN_THREAD_ID);
  });
});
test("chat-emoji-010 moving between emoji categories retains search until the new category is selected", async () => {
  const { trigger } = await visitEmoji(true);
  click(trigger);
  const search = await screen.findByPlaceholderText("Search emoji");
  await userEvent.type(search, "watermelon");
  expect(screen.queryByText("Smileys & Emotion")).toBeNull();
  const old = await findFastControl("button", "Frequently used"),
    next = await findFastControl("button", "Smileys & Emotion");
  old.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(next).toHaveFocus();
  expect(old).toHaveAttribute("aria-current", "location");
  expect(search).toHaveValue("watermelon");
  await userEvent.keyboard("{Enter}");
  expect(search).toHaveValue("");
  expect(next).toHaveFocus();
  expect(next).toHaveAttribute("aria-current", "location");
  await expect(
    screen.findByText("Smileys & Emotion"),
  ).resolves.toBeInTheDocument();
});

test("chat-emoji-004 the selected icon appears before the held rename closes the picker", async () => {
  const gate = context.mocks.deferred<void>();
  const { trigger } = await visitEmoji(false, gate.promise);
  expect(trigger).not.toHaveTextContent("😀");
  click(trigger);
  const search = await screen.findByPlaceholderText("Search emoji");
  click(await findFastControl("button", "grinning face"));
  await waitFor(() => {
    return expect(trigger).toHaveTextContent("😀");
  });
  expect(search).toBeInTheDocument();
  gate.resolve();
  await waitFor(() => {
    return expect(search).not.toBeInTheDocument();
  });
});
