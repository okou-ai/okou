import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  SECOND_ATTACHMENT_THREAD_ID,
  mockSplitAttachmentChats,
} from "./chat-attachment-test-helpers.ts";
import { findComposer } from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

test.each([
  ["005", "keyboard"],
  ["007", "title"],
])(
  "chat-rename-focus-%s dismissing Rename from the main conversation returns focus to the document",
  async (_id, entry) => {
    context.mocks.browser.matchMedia((q) => {
      return q.includes("min-width");
    });
    mockChatLifecycle(context, {
      threadId: RUN_THREAD_ID,
      threadTitle: "Field notes",
    });
    await setupPage({ context, path: RUN_PATH });
    const user = userEvent.setup({ delay: null });
    const title = await screen.findByTestId("chat-thread-header-title");
    if (entry === "title") {
      await user.dblClick(title);
    } else {
      await user.click(await findComposer());
      await user.keyboard("{F2}");
    }
    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
      expect(document.body).toHaveFocus();
    });
  },
);

test.each([
  ["001", "Enter"],
  ["002", "Escape"],
])(
  "chat-rename-focus-%s closing side-pane Rename leaves the body focused",
  async (_id, key) => {
    context.mocks.browser.matchMedia((q) => {
      return q.includes("min-width");
    });
    mockSplitAttachmentChats(
      context,
      { threadId: RUN_THREAD_ID, title: "Main planning", events: [] },
      {
        threadId: SECOND_ATTACHMENT_THREAD_ID,
        title: "Side notes",
        events: [],
      },
    );
    await setupPage({
      context,
      path: RUN_PATH + "?sidebar=" + SECOND_ATTACHMENT_THREAD_ID,
    });
    const title = await screen.findByText("Side notes", {
      selector: '[data-testid="chat-thread-header-title"]',
    });
    const pane = title.closest(
      "[data-chat-thread-container-id]",
    )! as HTMLElement;
    click(within(pane).getByRole("textbox", { name: "Message" }));
    await userEvent.keyboard("{F2}");
    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    if (key === "Enter") {
      const name = within(dialog).getByRole("textbox");
      await fill(name, "Revised side notes");
    }
    await userEvent.keyboard("{" + key + "}");
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
      expect(document.body).toHaveFocus();
    });
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByPlaceholderText("Search emoji")).toBeNull();
  },
);
