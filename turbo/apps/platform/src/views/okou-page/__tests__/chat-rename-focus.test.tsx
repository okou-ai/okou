import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatThreadRenameContract } from "@okouai/api-contracts/contracts/chat-threads";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

function threadContainer(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!container) {
    throw new Error(`Expected chat pane ${threadId}`);
  }
  return container;
}

async function setupRenamePage() {
  context.mocks.browser.matchMedia(true);
  const main = continuityThread(81, 1, "Main focus chat");
  const side = continuityThread(81, 2, "Side focus chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 81,
    threads: [main, side],
  });
  context.mocks.api(chatThreadRenameContract.rename, ({ respond }) => {
    return respond(204);
  });
  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    for (const thread of [main, side]) {
      expect(
        within(threadContainer(thread.id)).getByRole("textbox", {
          name: "Message",
        }),
      ).toBeInTheDocument();
    }
  });
  return { main, side };
}

async function renameDialog(): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  await waitFor(() => {
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveFocus();
  });
  return dialog;
}

test.each(["Enter", "Escape", "Cancel", "Close"])(
  "Do not focus the emoji button after Rename closes with %s",
  async (dismissal) => {
    const { side } = await setupRenamePage();
    const user = userEvent.setup({ delay: null });
    const container = threadContainer(side.id);
    container.focus();
    await user.keyboard("{F2}");
    const dialog = await renameDialog();

    if (dismissal === "Enter") {
      await fill(
        within(dialog).getByPlaceholderText("Chat title"),
        "Renamed side focus chat",
      );
      await user.keyboard("{Enter}");
    } else if (dismissal === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      const button = queryAllByRoleFast("button", dialog).find((candidate) => {
        return (
          candidate.getAttribute("aria-label") === dismissal ||
          candidate.textContent?.trim() === dismissal
        );
      });
      if (!button) {
        throw new Error(`Expected Rename ${dismissal} button`);
      }
      click(button);
    }
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(document.body).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.queryByLabelText("Search emoji")).not.toBeInTheDocument();
  },
);

test.each(["main", "side"] as const)(
  "Leave focus unforced after Rename opens from the %s composer",
  async (pane) => {
    const threads = await setupRenamePage();
    const user = userEvent.setup({ delay: null });
    const composer = within(threadContainer(threads[pane].id)).getByRole(
      "textbox",
      { name: "Message" },
    );
    await user.click(composer);
    await user.keyboard("{F2}");
    const dialog = await renameDialog();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(document.body).toHaveFocus();
  },
);

test("Do not focus the emoji button after title double-click Rename", async () => {
  const { main } = await setupRenamePage();
  const user = userEvent.setup({ delay: null });
  const title = within(threadContainer(main.id)).getByTestId(
    "chat-thread-header-title",
  );
  await user.dblClick(title);
  const dialog = await renameDialog();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(document.body).toHaveFocus();
});
