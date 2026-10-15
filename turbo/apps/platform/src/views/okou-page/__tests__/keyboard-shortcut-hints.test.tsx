import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
} from "./chat-list-test-helpers.ts";

const context = testContext();
const SEARCH_LABEL = "Search workspace...";

const platforms = [
  {
    platform: "Mac",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36",
    modifier: "Meta",
    hints: ["⌘⇧F", "⌘⇧O", "⌘B"],
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    modifier: "Control",
    hints: ["Ctrl+Shift+F", "Ctrl+Shift+O", "Ctrl+B"],
  },
] as const;

async function prepareActionShortcuts({
  userAgent,
  modifier,
  hints,
}: (typeof platforms)[number]) {
  context.mocks.browser.userAgent(userAgent);
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  const thread = chatListThread(1, "Keyboard shortcuts");
  const workspace = installContinuityWorkspace(context, {
    caseId: 63,
    threads: [thread],
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  click(composer);
  const user = userEvent.setup({ delay: null });
  return { user, modifier, hints };
}

test.each(platforms)(
  "Keep the new chat shortcut usable in a $platform browser",
  async (platform) => {
    const { user, modifier } = await prepareActionShortcuts(platform);
    await user.keyboard(`{${modifier}>}{Shift>}o{/Shift}{/${modifier}}`);
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${CHAT_LIST_AGENT_ID}/chat`);
    });
  },
);

test.each(platforms)(
  "Keep the chat list shortcut usable in a $platform browser",
  async (platform) => {
    const { user, modifier, hints } = await prepareActionShortcuts(platform);
    await user.keyboard(`{${modifier}>}b{/${modifier}}`);
    const showChatList = await screen.findByLabelText("Show chat list");
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
    await user.hover(showChatList);
    await expect(
      screen.findByRole("tooltip", { name: `Show chat list ${hints[2]}` }),
    ).resolves.toBeVisible();
    await user.keyboard(`{${modifier}>}b{/${modifier}}`);
    await screen.findByTestId("chat-list-column");
  },
);

test.each(platforms)(
  "Keep the search shortcut usable in a $platform browser",
  async (platform) => {
    const { user, modifier } = await prepareActionShortcuts(platform);
    await user.keyboard(`{${modifier}>}{Shift>}f{/Shift}{/${modifier}}`);
    const searchDialog = await screen.findByRole("dialog", {
      name: SEARCH_LABEL,
    });
    expect(
      within(searchDialog).getByPlaceholderText(SEARCH_LABEL),
    ).toHaveFocus();
  },
);
