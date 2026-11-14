import {
  chatThreadByIdContract,
  chatThreadPinContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { pathname } from "../../../signals/location.ts";
import { buttonByText } from "./sidebar-test-helpers.tsx";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const ROW_HEIGHT = 36;

function threadId(index: number): string {
  return `b3200000-0000-4000-a000-${String(index).padStart(12, "0")}`;
}

function mockThreads(
  count: number,
  projectId?: string,
  projectMemberCount = 2,
  archived = false,
): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: Array.from({ length: count }, (_, index) => {
          return {
            id: threadId(index),
            agentId: AGENT_ID,
            title: `History ${index + 1}`,
            sortAt: new Date(
              Date.parse("2026-03-10T00:00:00Z") + (count - index) * 1000,
            ).toISOString(),
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            pinnedAt: null,
            archived,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
            ...(projectId && index < projectMemberCount ? { projectId } : {}),
          };
        }),
        latestEventId: null,
        latestSeqId: null,
      }),
    );
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {}, unreadAt: {} });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [] });
  });
}

function mockViewportHeight(height: () => number, threadCount = 120): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "sidebar-scroll-area" ? height() : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "sidebar-scroll-area"
        ? threadCount * ROW_HEIGHT
        : 0;
    },
  );
}

const PWA_ROW_HEIGHT = 60;

function mockPwaViewportHeight(
  height: () => number,
  threadCount: number,
): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.slot === "scroll-area-viewport" ? height() : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.slot === "scroll-area-viewport"
        ? threadCount * PWA_ROW_HEIGHT
        : 0;
    },
  );
}

function resizeWindow(): void {
  fireEvent(window, new Event("resize"));
}

function selectChatListFilter(
  sidebar: HTMLElement,
  filter: "Unread" | "Archived",
): void {
  click(within(sidebar).getByLabelText("Open chat list menu"));
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim().startsWith(filter);
  });
  if (!item) {
    throw new Error(`${filter} menu item is missing`);
  }
  click(item);
}

test("Keep the chat viewport keyboard-focusable only while a conversation is open", async () => {
  const threadCount = 32;
  mockThreads(threadCount);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  }, threadCount);
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const sidebar = await screen.findByTestId("chat-list-column");
  const viewport = await within(sidebar).findByTestId("sidebar-scroll-area");
  const first = await within(viewport).findByText("History 1");
  expect(viewport).toHaveAttribute("tabindex", "-1");

  click(first);
  await waitFor(() => {
    expect(viewport).toHaveAttribute("tabindex", "0");
  });
  viewport.focus();
  expect(viewport).toHaveFocus();

  click(
    within(sidebar).getByLabelText("New chat", {
      selector: "button[aria-keyshortcuts]",
    }),
  );
  await waitFor(() => {
    expect(viewport).toHaveAttribute("tabindex", "-1");
  });
});

test("Keyboard navigation reveals an adjacent conversation outside the virtual window", async () => {
  const threadCount = 32;
  mockThreads(threadCount);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  }, threadCount);
  await setupPage({ context, path: `/chats/${threadId(0)}` });
  const sidebar = await screen.findByTestId("chat-list-column");
  const viewport = await within(sidebar).findByTestId("sidebar-scroll-area");
  const first = await within(viewport).findByText("History 1");
  await waitFor(() => {
    expect(first.closest("a")).toHaveAttribute("aria-current", "page");
  });
  expect(viewport).toHaveAttribute("tabindex", "0");
  viewport.focus();
  expect(viewport).toHaveFocus();
  // The next conversation lies outside the scrolled window. Keyboard
  // navigation must bring it back into view without losing the viewport.
  fireEvent.scroll(viewport, { target: { scrollTop: 16 * ROW_HEIGHT } });
  await within(viewport).findByText("History 17");
  fireEvent.keyDown(viewport, {
    key: "ArrowDown",
    ctrlKey: true,
    shiftKey: true,
  });
  const next = await within(viewport).findByText("History 2");
  await waitFor(() => {
    expect(next.closest("a")).toHaveAttribute("aria-current", "page");
    expect(viewport.scrollTop).toBe(ROW_HEIGHT);
  });
  expect(viewport).toHaveAttribute("tabindex", "0");
});

test("Collapse and expand a Project inside a scrolled virtual window", async () => {
  const projects = Array.from({ length: 17 }, (_, index) => {
    return {
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `Project ${String(index + 1).padStart(2, "0")}`,
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    };
  });
  mockThreads(32, projects[16].id);
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects,
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  }, projects.length + 32);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const sidebar = await screen.findByTestId("chat-list-column");
  const viewport = await within(sidebar).findByTestId("sidebar-scroll-area");
  await within(viewport).findByText("Project 01");

  fireEvent.scroll(viewport, { target: { scrollTop: 16 * ROW_HEIGHT } });
  const toggle = await within(viewport).findByLabelText(
    "Show or hide chats in Project 17",
  );
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(within(viewport).queryByText("Project 01")).not.toBeInTheDocument();
  click(toggle);
  await within(viewport).findByText("History 1");
  expect(within(viewport).getByText("History 2")).toBeInTheDocument();
  expect(within(viewport).getByText("History 3")).toBeInTheDocument();

  click(within(viewport).getByLabelText("Show or hide chats in Project 17"));
  await waitFor(() => {
    expect(
      within(viewport).getByLabelText("Show or hide chats in Project 17"),
    ).toHaveAttribute("aria-expanded", "false");
  });
  expect(within(viewport).queryByText("History 1")).not.toBeInTheDocument();
  expect(within(viewport).queryByText("History 2")).not.toBeInTheDocument();
  expect(within(viewport).getByText("History 3")).toBeInTheDocument();

  click(within(viewport).getByLabelText("Show or hide chats in Project 17"));
  const member = await within(viewport).findByText("History 1");
  click(member);
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${threadId(0)}`);
  });
  await screen.findByRole("textbox", { name: "Message" });
});

const FOLD_PROJECT_ID = "30000000-0000-4000-8000-000000000101";

function mockFoldProjects(count = 1): void {
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: Array.from({ length: count }, (_, index) => {
        return {
          id:
            index === count - 1
              ? FOLD_PROJECT_ID
              : `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          name: index === count - 1 ? "Motion project" : `Earlier ${index + 1}`,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        };
      }),
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
}

async function openFoldList({
  mobile,
  members = 2,
  outside = 24,
  projects = 1,
  reducedMotion = false,
  unread = false,
  activeChat = false,
  archived = false,
}: {
  mobile: boolean;
  members?: number;
  outside?: number;
  projects?: number;
  reducedMotion?: boolean;
  unread?: boolean;
  activeChat?: boolean;
  archived?: boolean;
}) {
  context.mocks.browser.matchMedia((query) => {
    return (
      (query === "(min-width: 48rem)" && !mobile) ||
      (query === "(prefers-reduced-motion: reduce)" && reducedMotion)
    );
  });
  mockThreads(members + outside, FOLD_PROJECT_ID, members, archived);
  if (unread) {
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        agents: { [AGENT_ID]: "unread" },
        threads: Object.fromEntries(
          Array.from({ length: members + outside }, (_, index) => {
            return [threadId(index), "unread" as const];
          }),
        ),
        unreadAt: {},
      });
    });
  }
  mockFoldProjects(projects);
  const rowHeight = mobile ? PWA_ROW_HEIGHT : ROW_HEIGHT;
  const mockHeight = mobile ? mockPwaViewportHeight : mockViewportHeight;
  mockHeight(
    () => {
      return 5 * rowHeight;
    },
    members + outside + projects,
  );
  await setupPage({
    context,
    path: activeChat ? `/chats/${threadId(0)}` : `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  if (unread || archived) {
    await screen.findByLabelText("Open chat list menu");
    selectChatListFilter(document.body, archived ? "Archived" : "Unread");
    await screen.findByText("Show all chats");
  }
  const viewport = mobile
    ? await screen.findByRole("region", { name: "Chat threads" })
    : await screen.findByTestId("sidebar-scroll-area");
  await within(viewport).findByLabelText(
    projects === 1
      ? "Show or hide chats in Motion project"
      : "Show or hide chats in Earlier 1",
  );
  return {
    viewport,
    rowHeight,
    toggle: () => {
      return within(viewport).getByLabelText(
        "Show or hide chats in Motion project",
      );
    },
    children: () => {
      const block = viewport.querySelector<HTMLElement>(
        `[data-project-children-id="${FOLD_PROJECT_ID}"]`,
      );
      if (!block) {
        throw new Error("Expected the rendered Project children");
      }
      return block;
    },
    list: within(viewport).getByTestId("sidebar-chat-threads-virtual-list"),
  };
}

/** Deliver one browser frame without replaying cancelled callbacks. */
function holdFoldFrame() {
  let frames = new Map<number, FrameRequestCallback>();
  let nextId = 1_000_000;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  return async () => {
    // Let the command consume its explicit prepared-DOM acknowledgement.
    await act(async () => {
      await Promise.resolve();
    });
    const pending = [...frames.values()];
    frames = new Map();
    await act(() => {
      for (const callback of pending) {
        callback(0);
      }
      return Promise.resolve();
    });
  };
}

function holdFoldReceipts() {
  const blockFinished = context.mocks.deferred<Animation>();
  const listFinished = context.mocks.deferred<Animation>();
  const blockAnimation = {
    transitionProperty: "height",
    finished: blockFinished.promise,
  } as CSSTransition;
  const listAnimation = {
    transitionProperty: "height",
    finished: listFinished.promise,
  } as CSSTransition;
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getAnimations",
  );
  if (!original) {
    throw new Error("Expected the shared Web Animations boundary");
  }
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.dataset.projectChildrenId === FOLD_PROJECT_ID) {
        return () => {
          return [blockAnimation];
        };
      }
      if (this.dataset.testid === "sidebar-chat-threads-virtual-list") {
        return () => {
          return [listAnimation];
        };
      }
      return original.get?.call(this);
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      Object.defineProperty(HTMLElement.prototype, "getAnimations", original);
    },
    { once: true },
  );
  return {
    finishBlock: async () => {
      await act(() => {
        blockFinished.resolve(blockAnimation);
        return Promise.resolve();
      });
    },
    finishList: async () => {
      await act(() => {
        listFinished.resolve(listAnimation);
        return Promise.resolve();
      });
    },
  };
}

test.each([false, true])(
  "Project fold commits intent immediately and awaits both height owners (mobile: %s)",
  async (mobile) => {
    const { viewport, toggle, children, list, rowHeight } = await openFoldList({
      mobile,
    });
    const receipts = holdFoldReceipts();
    const expandFrame = holdFoldFrame();
    click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(children()).toHaveAttribute("data-project-fold-state", "prepared");
    expect(children().style.height).toBe("0px");
    expect(list.style.height).toBe(`${25 * rowHeight}px`);
    await expandFrame();
    expect(children()).toHaveAttribute("data-project-fold-state", "running");
    expect(children().style.height).toBe(`${2 * rowHeight}px`);
    expect(list.style.height).toBe(`${27 * rowHeight}px`);
    await receipts.finishBlock();
    expect(children()).toHaveAttribute("data-project-fold-state", "running");
    await receipts.finishList();
    await waitFor(() => {
      return expect(children()).not.toHaveAttribute("data-project-fold-state");
    });

    const block = children();
    const member = within(block).getByText("History 1").closest("a");
    const collapseFrame = holdFoldFrame();
    click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(children()).toBe(block);
    expect(within(block).getByText("History 1").closest("a")).toBe(member);
    expect(block).toHaveAttribute("inert");
    expect(block).toHaveAttribute("aria-hidden", "true");
    expect(block.style.height).toBe(`${2 * rowHeight}px`);
    expect(list.style.height).toBe(`${27 * rowHeight}px`);
    expect(within(viewport).getByText("History 3")).toBeInTheDocument();
    await collapseFrame();
    await waitFor(() => {
      return expect(
        within(viewport).queryByText("History 1"),
      ).not.toBeInTheDocument();
    });
    expect(list.style.height).toBe(`${25 * rowHeight}px`);
    click(within(viewport).getByText("History 3"));
    await screen.findByRole("textbox", { name: "Message" });
    expect(pathname()).toBe(`/chats/${threadId(2)}`);
  },
);

test.each([false, true])(
  "A pointer reversal before the fold frame keeps children usable (mobile: %s)",
  async (mobile) => {
    const { toggle, children, viewport } = await openFoldList({ mobile });
    click(toggle());
    await waitFor(() => {
      return expect(children()).not.toHaveAttribute("data-project-fold-state");
    });
    const block = children();
    const member = within(block).getByText("History 1").closest("a");
    const reverseFrame = holdFoldFrame();
    click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(block).toHaveAttribute("inert");
    click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(children()).toBe(block);
    expect(within(block).getByText("History 1").closest("a")).toBe(member);
    expect(block).not.toHaveAttribute("inert");
    expect(block).not.toHaveAttribute("aria-hidden");
    expect(block).toHaveAttribute("data-project-fold-state", "prepared");
    await reverseFrame();
    await waitFor(() => {
      return expect(children()).not.toHaveAttribute("data-project-fold-state");
    });
    click(within(viewport).getByText("History 1"));
    await screen.findByRole("textbox", { name: "Message" });
    expect(pathname()).toBe(`/chats/${threadId(0)}`);
  },
);

test.each([
  { mobile: false, event: "wheel" },
  { mobile: true, event: "touchmove" },
  { mobile: false, event: "scroll" },
])(
  "List $event cancels Project motion without undoing the click (mobile: $mobile)",
  async ({ mobile, event }) => {
    const { toggle, children, viewport, list, rowHeight } = await openFoldList({
      mobile,
    });
    const frame = holdFoldFrame();
    click(toggle());
    expect(children()).toHaveAttribute("data-project-fold-state", "prepared");
    if (event === "scroll") {
      fireEvent.scroll(viewport, { target: { scrollTop: rowHeight } });
    } else {
      fireEvent(viewport, new Event(event, { bubbles: true }));
    }
    await waitFor(() => {
      return expect(children()).not.toHaveAttribute("data-project-fold-state");
    });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(list.style.height).toBe(`${27 * rowHeight}px`);
    await frame();
    expect(children()).not.toHaveAttribute("data-project-fold-state");
    click(within(viewport).getByText("History 1"));
    await screen.findByRole("textbox", { name: "Message" });
    expect(pathname()).toBe(`/chats/${threadId(0)}`);
  },
);

test.each([false, true])(
  "Reduced motion folds immediately without retaining hidden children (mobile: %s)",
  async (mobile) => {
    const { toggle, children, viewport, list, rowHeight } = await openFoldList({
      mobile,
      reducedMotion: true,
    });
    click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(children()).not.toHaveAttribute("data-project-fold-state");
    expect(within(viewport).getByText("History 1")).toBeInTheDocument();
    expect(list.style.height).toBe(`${27 * rowHeight}px`);
    click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(within(viewport).queryByText("History 1")).not.toBeInTheDocument();
    expect(list.style.height).toBe(`${25 * rowHeight}px`);
    expect(within(viewport).getByText("History 3")).toBeInTheDocument();
  },
);

test("A 10,000-chat Project stays bounded while opening and cancelling its reveal", async () => {
  const { toggle, viewport, children, list } = await openFoldList({
    mobile: false,
    members: 10_000,
  });
  const frame = holdFoldFrame();
  click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
  expect(children()).toHaveAttribute("data-project-fold-state", "prepared");
  expect(
    within(viewport).getAllByTestId("sidebar-chat-thread-virtual-row").length,
  ).toBeLessThanOrEqual(68);
  expect(list.style.height).toBe(`${25 * ROW_HEIGHT}px`);
  fireEvent.wheel(viewport);
  await waitFor(() => {
    return expect(children()).not.toHaveAttribute("data-project-fold-state");
  });
  expect(list.style.height).toBe(`${10_025 * ROW_HEIGHT}px`);
  expect(
    within(viewport).getAllByTestId("sidebar-chat-thread-virtual-row").length,
  ).toBeLessThanOrEqual(68);
  await frame();
  fireEvent.scroll(viewport, { target: { scrollTop: 9998 * ROW_HEIGHT } });
  await within(viewport).findByText("History 10000");
  fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
  await within(viewport).findByLabelText(
    "Show or hide chats in Motion project",
  );
  click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "false");
  expect(children()).toHaveAttribute("inert");
  expect(
    within(viewport).getAllByTestId("sidebar-chat-thread-virtual-row").length,
  ).toBeLessThanOrEqual(68);
  fireEvent.wheel(viewport);
  await waitFor(() => {
    expect(within(viewport).queryByText("History 1")).not.toBeInTheDocument();
  });
});

test("Navigating away from a mobile reveal cancels its viewport lifetime", async () => {
  const { toggle, viewport, children } = await openFoldList({ mobile: true });
  const frame = holdFoldFrame();
  click(toggle());
  expect(children()).toHaveAttribute("data-project-fold-state", "prepared");
  click(within(viewport).getByText("History 3"));
  await screen.findByRole("textbox", { name: "Message" });
  expect(viewport).not.toBeInTheDocument();
  await frame();
  click(screen.getByLabelText("Back to chats"));
  const restored = await screen.findByRole("region", { name: "Chat threads" });
  expect(
    within(restored).getByLabelText("Show or hide chats in Motion project"),
  ).toHaveAttribute("aria-expanded", "true");
  const block = restored.querySelector(
    `[data-project-children-id="${FOLD_PROJECT_ID}"]`,
  );
  expect(block).toBeInTheDocument();
  expect(block).not.toHaveAttribute("data-project-fold-state");
});

test("A filtered desktop list excludes its external footer from the reveal height", async () => {
  const { toggle, viewport, children, list, rowHeight } = await openFoldList({
    mobile: false,
    outside: 2,
    archived: true,
  });
  expect(list.style.height).toBe(`${3 * rowHeight}px`);
  const footer = within(viewport).getByText("Show all chats");
  expect(list).not.toContainElement(footer);
  const frame = holdFoldFrame();
  click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
  expect(children()).toHaveAttribute("data-project-fold-state", "prepared");
  expect(list.style.height).toBe(`${3 * rowHeight}px`);
  await frame();
  await waitFor(() => {
    expect(children()).not.toHaveAttribute("data-project-fold-state");
  });
  expect(list.style.height).toBe(`${5 * rowHeight}px`);
  expect(footer).toBeInTheDocument();
  click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "false");
  expect(children()).toHaveAttribute("inert");
  expect(list.style.height).toBe(`${5 * rowHeight}px`);
  fireEvent.wheel(viewport);
  await waitFor(() => {
    expect(list.style.height).toBe(`${3 * rowHeight}px`);
  });
  click(buttonByText("Show all chats", viewport));
  await waitFor(() => {
    expect(footer).not.toBeInTheDocument();
  });
});

test("Expanding an already-visible current conversation does not cancel its reveal", async () => {
  const { toggle, viewport, children } = await openFoldList({
    mobile: false,
    activeChat: true,
  });
  await screen.findByRole("textbox", { name: "Message" });
  if (toggle().getAttribute("aria-expanded") === "true") {
    click(toggle());
    fireEvent.wheel(viewport);
  }
  await waitFor(() => {
    expect(within(viewport).queryByText("History 1")).not.toBeInTheDocument();
  });
  fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
  const frame = holdFoldFrame();
  click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
  expect(children()).toHaveAttribute("data-project-fold-state", "prepared");
  const current = within(children()).getByText("History 1").closest("a");
  expect(current).toHaveAttribute("aria-current", "page");
  expect(viewport.scrollTop).toBe(0);
  await frame();
  await waitFor(() => {
    expect(children()).not.toHaveAttribute("data-project-fold-state");
  });
  expect(current).toHaveAttribute("aria-current", "page");
  expect(viewport.scrollTop).toBe(0);
});

test("The mobile unread footer shares the Project reveal's list height", async () => {
  const { toggle, viewport, children, list, rowHeight } = await openFoldList({
    mobile: true,
    outside: 2,
    unread: true,
  });
  expect(list.style.height).toBe(`${4 * rowHeight}px`);
  const frame = holdFoldFrame();
  click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
  expect(children()).toHaveAttribute("data-project-fold-state", "prepared");
  expect(list.style.height).toBe(`${4 * rowHeight}px`);
  expect(within(list).getByText("Show all chats")).toBeInTheDocument();
  fireEvent.touchMove(viewport);
  await waitFor(() => {
    return expect(children()).not.toHaveAttribute("data-project-fold-state");
  });
  expect(list.style.height).toBe(`${6 * rowHeight}px`);
  await frame();
  click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "false");
  fireEvent.touchMove(viewport);
  await waitFor(() => {
    return expect(list.style.height).toBe(`${4 * rowHeight}px`);
  });
  click(buttonByText("Show all chats", list));
  await within(viewport).findByText("History 3");
  expect(
    within(viewport).queryByText("Show all chats"),
  ).not.toBeInTheDocument();
});

test("A bottom-clamping Project collapse commits its smaller list immediately", async () => {
  const { toggle, viewport, list } = await openFoldList({
    mobile: false,
    projects: 17,
    outside: 2,
  });
  // Expand while the Project is in the overscan, then place its header at the
  // bottom scroll position of the expanded list. The smaller list cannot keep it.
  fireEvent.scroll(viewport, { target: { scrollTop: 12 * ROW_HEIGHT } });
  await within(viewport).findByLabelText(
    "Show or hide chats in Motion project",
  );
  click(toggle());
  await within(viewport).findByText("History 1");
  fireEvent.scroll(viewport, { target: { scrollTop: 16 * ROW_HEIGHT } });
  await within(viewport).findByText("History 4");
  click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "false");
  expect(within(viewport).queryByText("History 1")).not.toBeInTheDocument();
  expect(list.style.height).toBe(`${19 * ROW_HEIGHT}px`);
  expect(within(viewport).getByText("History 3")).toBeInTheDocument();
});

test("Resize and navigate a loaded virtual viewport", async () => {
  const threadCount = 6406;
  mockThreads(threadCount);
  let viewportHeight = 612;
  mockViewportHeight(() => {
    return viewportHeight;
  }, threadCount);

  await setupPage({ context, path: `/chats/${threadId(0)}` });
  const sidebar = await screen.findByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    expect(rows()).toHaveLength(25);
  });
  expect(within(sidebar).getByText("History 25")).toBeInTheDocument();
  expect(within(sidebar).queryByText("History 26")).not.toBeInTheDocument();

  viewportHeight = 900;
  resizeWindow();
  await waitFor(() => {
    expect(rows()).toHaveLength(33);
  });
  viewportHeight = 360;
  resizeWindow();
  await waitFor(() => {
    expect(rows()).toHaveLength(18);
  });

  const nextThread = queryAllByRoleFast("link", sidebar).find((link) => {
    return link.getAttribute("href") === `/chats/${threadId(1)}`;
  });
  if (!nextThread) {
    throw new Error("Second sidebar thread is not mounted");
  }
  click(nextThread);
  await waitFor(() => {
    expect(nextThread).toHaveAttribute("aria-current", "page");
  });
  expect(rows()).toHaveLength(18);
});

async function setupUnreadHistoryBeyondCurrentWindow() {
  mockThreads(120);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  });
  const indicators = context.mocks.deferred<void>();
  const unreadIndexes = Array.from({ length: 30 }, (_, index) => {
    return index + 40;
  });
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    await indicators.promise;
    return respond(200, {
      agents: { [AGENT_ID]: "unread" },
      threads: {
        ...Object.fromEntries(
          unreadIndexes.map((index) => {
            return [threadId(index), "unread" as const];
          }),
        ),
        [threadId(100)]: "active",
      },
      unreadAt: {},
    });
  });
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const sidebar = screen.getByTestId("chat-list-column");
  await within(sidebar).findByText("History 1");
  expect(within(sidebar).queryByText("History 41")).not.toBeInTheDocument();
  selectChatListFilter(sidebar, "Unread");
  await within(sidebar).findAllByTestId("sidebar-skeleton");
  expect(within(sidebar).queryByText("History 1")).not.toBeInTheDocument();
  expect(
    within(sidebar).queryByText("No unread chats"),
  ).not.toBeInTheDocument();
  indicators.resolve();
  await within(sidebar).findByText("History 70");
  return { sidebar, unreadIndexes };
}

test("Show every unread conversation beyond the current history window", async () => {
  const { sidebar, unreadIndexes } =
    await setupUnreadHistoryBeyondCurrentWindow();
  for (const index of unreadIndexes) {
    expect(
      within(sidebar).getByText(`History ${index + 1}`),
    ).toBeInTheDocument();
  }
  expect(within(sidebar).queryByText("History 1")).not.toBeInTheDocument();
  expect(within(sidebar).queryByText("History 101")).not.toBeInTheDocument();
});

function runningIndicatorPhase(row: HTMLElement): number {
  const indicator = within(row).getByTestId(
    "chat-thread-state-indicator",
  ).firstElementChild;
  if (!(indicator instanceof HTMLElement)) {
    throw new Error("Running indicator is missing");
  }
  const phase = indicator.style.getPropertyValue("--running-indicator-phase");
  expect(phase).not.toBe("");
  return Number(phase);
}

test("Follow full-list wave positions across scrolling and pinning", async () => {
  mockThreads(120);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  });
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [AGENT_ID]: "active" },
      threads: Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => {
          return [threadId(index), index === 1 ? "unread" : "active"] as const;
        }),
      ),
      unreadAt: { [threadId(1)]: "2026-03-10T00:05:00Z" },
    });
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  const sidebar = screen.getByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    expect(rows()).toHaveLength(13);
    expect(runningIndicatorPhase(rows()[2])).toBeCloseTo(-10 / 12, 10);
  });
  await within(rows()[1]).findByText("Unread");
  expect(within(rows()[2]).getByText("Running")).toBeInTheDocument();

  const scrollArea = within(sidebar).getByTestId("sidebar-scroll-area");
  scrollArea.scrollTop = 40 * ROW_HEIGHT;
  fireEvent.scroll(scrollArea);
  await within(sidebar).findByText("History 41");
  expect(within(sidebar).queryByText("History 1")).not.toBeInTheDocument();
  expect(Number(rows()[0].dataset.index)).toBeGreaterThan(0);
  await waitFor(() => {
    for (const row of rows()) {
      const index = Number(row.dataset.index);
      const expectedPhase = index % 12 === 0 ? 0 : (index % 12) / 12 - 1;
      expect(runningIndicatorPhase(row)).toBeCloseTo(expectedPhase, 10);
    }
  });

  scrollArea.scrollTop = 0;
  fireEvent.scroll(scrollArea);
  await within(sidebar).findByText("History 1");
  await waitFor(() => {
    expect(runningIndicatorPhase(rows()[0])).toBe(0);
    expect(runningIndicatorPhase(rows()[2])).toBeCloseTo(-10 / 12, 10);
  });

  click(within(rows()[2]).getByLabelText("Open chat menu"));
  await screen.findByRole("menu");
  const pin = queryAllByRoleFast("menuitem").find((item) => {
    return item.getAttribute("aria-label") === "Pin chat";
  });
  if (!pin) {
    throw new Error("Pin menu item is missing");
  }
  click(pin);
  await waitFor(() => {
    expect(within(rows()[0]).getByText("History 3")).toBeInTheDocument();
    expect(runningIndicatorPhase(rows()[0])).toBe(0);
    expect(runningIndicatorPhase(rows()[1])).toBeCloseTo(-11 / 12, 10);
  });
  expect(within(rows()[0]).getByText("Running")).toBeInTheDocument();
  expect(queryAllByRoleFast("link", rows()[0])[0]).toHaveAttribute(
    "href",
    `/chats/${threadId(2)}`,
  );
});

function mockPinnedGrid(): string {
  const agents = Array.from({ length: 5 }, (_, index) => {
    return {
      agentId: `c0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
      ownerId: "test-user-123",
      displayName: index === 0 ? "Nova" : `Agent ${index + 1}`,
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public" as const,
    };
  });
  context.mocks.data.agents(agents);
  context.mocks.data.userPreferences({
    pinnedAgentIds: agents.slice(1, 4).map((agent) => {
      return agent.agentId;
    }),
  });
  return "c0000000-0000-4000-a000-000000000005";
}

function pinToggle(container: HTMLElement, name: "Pin" | "Unpin"): HTMLElement {
  return within(container).getByRole("option", { name: `Agent 5 ${name}` });
}

test("Refresh virtualization after pinning adds a grid row and unpinning removes it", async () => {
  mockThreads(120);
  mockPinnedGrid();
  mockViewportHeight(() => {
    const cards = document.querySelectorAll(
      '[data-testid="pinned-agent-card"]',
    );
    return cards.length > 4 ? 360 : 612;
  });
  await setupPage({ context, path: `/chats/${threadId(0)}` });
  const sidebar = screen.getByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    return expect(rows()).toHaveLength(25);
  });

  click(screen.getByLabelText("Pin an agent"));
  const dialog = await screen.findByTestId("pin-agent-dialog-list");
  click(pinToggle(dialog, "Pin"));
  await waitFor(() => {
    expect(within(sidebar).getAllByTestId("pinned-agent-card")).toHaveLength(5);
    expect(rows()).toHaveLength(18);
  });
  await waitFor(() => {
    return expect(pinToggle(dialog, "Unpin")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(pinToggle(dialog, "Unpin"));
  await waitFor(() => {
    expect(within(sidebar).getAllByTestId("pinned-agent-card")).toHaveLength(4);
    expect(rows()).toHaveLength(25);
  });
});

test("Measure the mobile chat list only after the main stylesheet bounds it", async () => {
  const pwaRowHeight = 60;
  const threadCount = 120;
  const stylesheet = createDeferredPromise<"loaded">(context.signal);
  const originalStylesheetLoaded = window.__mainStylesheetLoaded;
  window.__mainStylesheetLoaded = stylesheet.promise;
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalStylesheetLoaded) {
        window.__mainStylesheetLoaded = originalStylesheetLoaded;
      } else {
        delete window.__mainStylesheetLoaded;
      }
    },
    { once: true },
  );
  context.mocks.browser.matchMedia((query) => {
    return query === "(display-mode: standalone)";
  });
  mockThreads(threadCount);
  let stylesheetActive = false;
  // Without the stylesheet the viewport grows to the whole list.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.slot !== "scroll-area-viewport") {
        return 0;
      }
      return stylesheetActive ? 5 * pwaRowHeight : threadCount * pwaRowHeight;
    },
  );

  const page = await startPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await screen.findByRole("navigation", { name: "Main navigation" });
  // Workspace search lists the same chats outside the chat list, so finding
  // one proves the rows are ready; only the stylesheet holds the list back.
  click(await screen.findByLabelText("Search workspace"));
  const search = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  await within(search).findAllByText("History 1");
  expect(
    screen.queryAllByTestId("sidebar-chat-thread-virtual-row"),
  ).toHaveLength(0);
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => {
    expect(search).not.toBeInTheDocument();
  });

  stylesheetActive = true;
  stylesheet.resolve("loaded");
  await page.ready;
  await screen.findByText("History 1");
  await waitFor(() => {
    expect(
      screen.getAllByTestId("sidebar-chat-thread-virtual-row"),
    ).toHaveLength(13);
  });
});

test("Show all chats from the tail of a scrolled mobile unread list", async () => {
  const unreadIndexes = Array.from({ length: 24 }, (_, index) => {
    return index + 8;
  });
  context.mocks.browser.matchMedia(false);
  mockThreads(40);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [AGENT_ID]: "unread" },
      threads: Object.fromEntries(
        unreadIndexes.map((index) => {
          return [threadId(index), "unread" as const];
        }),
      ),
      unreadAt: {},
    });
  });
  mockPwaViewportHeight(() => {
    return 5 * PWA_ROW_HEIGHT;
  }, unreadIndexes.length + 1);
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const list = await screen.findByRole("region", { name: "Chat threads" });
  await within(list).findByText("History 1");

  selectChatListFilter(document.body, "Unread");
  await waitFor(() => {
    const filtered = screen.getByRole("region", { name: "Chat threads" });
    expect(within(filtered).getByText("History 9")).toBeInTheDocument();
    expect(within(filtered).queryByText("History 1")).not.toBeInTheDocument();
  });
  const unreadList = screen.getByRole("region", { name: "Chat threads" });
  expect(
    within(unreadList).queryByText("Show all chats"),
  ).not.toBeInTheDocument();

  fireEvent.scroll(unreadList, {
    target: { scrollTop: (unreadIndexes.length + 1 - 5) * PWA_ROW_HEIGHT },
  });
  await within(unreadList).findByText("History 32");
  await within(unreadList).findByText("Show all chats");
  click(buttonByText("Show all chats", unreadList));
  const restored = await screen.findByText("History 1");
  click(restored);
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${threadId(0)}`);
  });
  await screen.findByRole("textbox", { name: "Message" });
});

test("Restore the mobile chat-list scroll position after returning from a conversation", async () => {
  const threadCount = 32;
  context.mocks.browser.matchMedia(false);
  mockThreads(threadCount);
  mockPwaViewportHeight(() => {
    return 5 * PWA_ROW_HEIGHT;
  }, threadCount);
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const list = await screen.findByRole("region", { name: "Chat threads" });
  await within(list).findByText("History 1");
  fireEvent.scroll(list, { target: { scrollTop: 16 * PWA_ROW_HEIGHT } });
  click(await within(list).findByText("History 17"));
  await screen.findByRole("textbox", { name: "Message" });

  click(screen.getByLabelText("Back to chats"));
  const restored = await screen.findByRole("region", { name: "Chat threads" });
  await within(restored).findByText("History 17");
  expect(restored.scrollTop).toBe(16 * PWA_ROW_HEIGHT);
});

test("Remeasure the mobile chat list when a service notice arrives and is dismissed", async () => {
  const threadCount = 120;
  context.mocks.browser.matchMedia(false);
  mockThreads(threadCount);
  const incident = createDeferredPromise<void>(context.signal);
  context.mocks.http.get("https://api.instatus.com/issues", async () => {
    await incident.promise;
    return HttpResponse.json({
      activeIncidents: [
        {
          id: "incident-api-latency",
          name: "API requests are delayed",
          status: "INVESTIGATING",
        },
      ],
    });
  });
  mockPwaViewportHeight(() => {
    const notice = document.querySelector(
      '[role="region"][aria-label="Service status updates"]',
    );
    return notice ? 5 * PWA_ROW_HEIGHT : 12 * PWA_ROW_HEIGHT;
  }, threadCount);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
  });
  const list = await screen.findByRole("region", { name: "Chat threads" });
  const rows = () => {
    return within(list).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    expect(rows()).toHaveLength(20);
  });

  incident.resolve();
  await screen.findByRole("region", { name: "Service status updates" });
  await waitFor(() => {
    expect(rows()).toHaveLength(13);
  });

  click(screen.getByLabelText("Dismiss service update"));
  await waitFor(() => {
    expect(rows()).toHaveLength(20);
  });
});
