import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  chatThreadRenameContract,
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";

import {
  click,
  fill,
  holdElementAnimations,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { chatListEvent } from "./chat-list-test-helpers.ts";
import {
  continuitySidebarLink,
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

function controlNamed(
  role: "button" | "menuitem",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const control = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!control) {
    throw new Error(`Expected ${role} named ${name}`);
  }
  return control;
}

function sidebarMenuTrigger(threadId: string): HTMLElement {
  const trigger = continuitySidebarLink(
    threadId,
  ).parentElement?.querySelector<HTMLElement>(
    '[data-testid="chat-thread-menu-trigger"]',
  );
  if (!trigger) {
    throw new Error(`Expected sidebar menu for ${threadId}`);
  }
  return trigger;
}

async function setupRenamePage(desktop = true) {
  context.mocks.browser.matchMedia(desktop);
  const main = continuityThread(81, 1, "Main focus chat");
  const side = continuityThread(81, 2, "Side focus chat");
  const undisplayed = continuityThread(81, 3, "Undisplayed focus chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 81,
    threads: [main, side, undisplayed],
  });
  context.mocks.api(chatThreadRenameContract.rename, ({ respond }) => {
    return respond(204);
  });
  await setupPage({
    context,
    path: desktop
      ? `/chats/${main.id}?sidebar=${side.id}`
      : `/chats/${main.id}`,
    ...workspace.pageOptions,
  });
  const renderedThreads = desktop ? [main, side] : [main];
  await waitFor(() => {
    for (const thread of renderedThreads) {
      expect(
        threadContainer(thread.id).querySelector(
          '[role="textbox"][aria-label="Message"]',
        ),
      ).toBeInTheDocument();
    }
  });
  return { main, side, undisplayed };
}

async function renameDialog(): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  await waitFor(() => {
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveFocus();
  });
  return dialog;
}

test.each(["Enter", "Escape", "Cancel", "Close"])(
  "Restore the side chat keyboard root after Rename closes with %s",
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
      click(controlNamed("button", dismissal, dialog));
    }
    await waitFor(() => {
      expect(container).toHaveFocus();
    });
    expect(dialog).not.toBeInTheDocument();
    expect(container).toHaveTextContent(
      dismissal === "Enter" ? "Renamed side focus chat" : "Side focus chat",
    );

    await user.keyboard("{Enter}");
    expect(screen.queryByLabelText("Search emoji")).not.toBeInTheDocument();
    expect(container).toHaveFocus();
  },
);

test("Restore the main chat root after double-clicking its title", async () => {
  const { main } = await setupRenamePage();
  const user = userEvent.setup({ delay: null });
  const container = threadContainer(main.id);
  await user.dblClick(
    within(container).getByTestId("chat-thread-header-title"),
  );
  const dialog = await renameDialog();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(container).toHaveFocus();
  });
  expect(dialog).not.toBeInTheDocument();
});

test.each(["mouse", "keyboard", "F2"])(
  "Hand a sidebar menu's focus to Rename when opened by %s",
  async (entry) => {
    const { side } = await setupRenamePage();
    const user = userEvent.setup({ delay: null });
    const trigger = sidebarMenuTrigger(side.id);
    click(trigger);
    const menu = await screen.findByRole("menu");
    const rename = controlNamed("menuitem", "Rename chat", menu);
    if (entry === "mouse") {
      click(rename);
    } else {
      rename.focus();
      await user.keyboard(entry === "F2" ? "{F2}" : "{Enter}");
    }
    const dialog = await renameDialog();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(threadContainer(side.id)).toHaveFocus();
    });
    expect(dialog).not.toBeInTheDocument();

    click(trigger);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  },
);

test.each(["menu-first", "rename-first"])(
  "Keep the menu-to-Rename handoff when animations finish %s",
  async (order) => {
    const { side } = await setupRenamePage();
    const user = userEvent.setup({ delay: null });
    click(sidebarMenuTrigger(side.id));
    const menu = await screen.findByRole("menu");
    const finishMenuAnimation = holdElementAnimations(menu);
    click(controlNamed("menuitem", "Rename chat", menu));
    const dialog = await renameDialog();
    const finishDialogAnimation = holdElementAnimations(dialog);
    const viewport = dialog.closest<HTMLElement>(
      '[data-slot="dialog-viewport"]',
    );
    if (!viewport) {
      throw new Error("Expected the rename dialog viewport");
    }
    await user.click(viewport);
    await waitFor(() => {
      expect(menu).toHaveAttribute("data-closed");
      expect(dialog).toHaveAttribute("data-closed");
    });

    const [finishFirst, finishLast] =
      order === "menu-first"
        ? ([finishMenuAnimation, finishDialogAnimation] as const)
        : ([finishDialogAnimation, finishMenuAnimation] as const);
    const firstPopup = order === "menu-first" ? menu : dialog;
    await act(() => {
      finishFirst();
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(firstPopup).not.toBeInTheDocument();
    });
    await act(() => {
      finishLast();
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(threadContainer(side.id)).toHaveFocus();
    });
    expect(dialog).not.toBeInTheDocument();
    expect(menu).not.toBeInTheDocument();
  },
);

test("Use default focus return when renaming an undisplayed sidebar chat", async () => {
  const { undisplayed } = await setupRenamePage();
  const user = userEvent.setup({ delay: null });
  const trigger = sidebarMenuTrigger(undisplayed.id);
  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  await user.click(controlNamed("menuitem", "Rename chat", menu));
  const dialog = await renameDialog();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  expect(dialog).not.toBeInTheDocument();
});

test("Keep the mobile header menu's ordinary return after its Rename handoff", async () => {
  const { main } = await setupRenamePage(false);
  const user = userEvent.setup({ delay: null });
  const container = threadContainer(main.id);
  const trigger = controlNamed("button", "More actions");
  click(trigger);
  const menu = await screen.findByRole("menu");
  click(controlNamed("menuitem", "Rename chat", menu));
  const dialog = await renameDialog();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(container).toHaveFocus();
  });
  expect(dialog).not.toBeInTheDocument();

  click(trigger);
  await screen.findByRole("menu");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
});

test("Keep focus deliberately moved elsewhere while Rename is closing", async () => {
  const { main, side } = await setupRenamePage();
  const user = userEvent.setup({ delay: null });
  threadContainer(side.id).focus();
  await user.keyboard("{F2}");
  const dialog = await renameDialog();
  const finishAnimation = holdElementAnimations(dialog);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-closed");
  });
  const composer = within(threadContainer(main.id)).getByRole("textbox", {
    name: "Message",
  });
  composer.focus();
  expect(composer).toHaveFocus();

  await act(() => {
    finishAnimation();
    return Promise.resolve();
  });
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(composer).toHaveFocus();
});

test("Do not restore an old rename session after browser navigation", async () => {
  const { main, side, undisplayed } = await setupRenamePage();
  const user = userEvent.setup({ delay: null });
  click(continuitySidebarLink(undisplayed.id));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${undisplayed.id}`);
    expect(threadContainer(undisplayed.id)).toHaveTextContent(
      "Undisplayed focus chat",
    );
  });
  threadContainer(side.id).focus();
  await user.keyboard("{F2}");
  const dialog = await renameDialog();
  const finishAnimation = holdElementAnimations(dialog);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-closed");
  });

  act(() => {
    window.history.back();
  });
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${main.id}`);
    expect(threadContainer(main.id)).toHaveTextContent("Main focus chat");
  });
  await act(() => {
    finishAnimation();
    return Promise.resolve();
  });
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(threadContainer(side.id)).not.toHaveFocus();
});

test("Keep a reopened Rename input focused when an earlier save completes", async () => {
  const { side } = await setupRenamePage();
  const response = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  const events: ChatThreadEvent[] = [];
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  context.mocks.api(
    chatThreadRenameContract.rename,
    async ({ body, respond }) => {
      requested.resolve();
      await response.promise;
      events.push(
        chatListEvent(81, 2, "renamed", side.id, {
          id: body.eventId,
          agentId: side.agentId,
          title: "Server-confirmed side chat",
        }),
      );
      changeChatThreadList();
      return respond(204);
    },
  );
  const user = userEvent.setup({ delay: null });
  const container = threadContainer(side.id);
  container.focus();
  await user.keyboard("{F2}");
  const first = await renameDialog();
  await fill(
    within(first).getByPlaceholderText("Chat title"),
    "First side rename",
  );
  await user.keyboard("{Enter}");
  await requested.promise;
  await waitFor(() => {
    expect(container).toHaveFocus();
  });
  await user.keyboard("{F2}");
  const second = await renameDialog();
  const input = within(second).getByPlaceholderText("Chat title");
  await fill(input, "Keep this newer rename draft");

  response.resolve();
  await waitFor(() => {
    expect(container).toHaveTextContent("Server-confirmed side chat");
  });
  expect(input).toHaveFocus();
  expect(input).toHaveValue("Keep this newer rename draft");
  expect(second).toBeInTheDocument();
});
