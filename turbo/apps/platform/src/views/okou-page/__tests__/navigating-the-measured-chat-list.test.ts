import { HttpResponse } from "msw";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import {
  chatThreadsContract,
  chatThreadPinContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
function layout(height: number, notice?: string) {
  let pixels = height;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute("aria-label") === "Chat threads"
        ? notice && document.body.textContent?.includes(notice)
          ? 300
          : pixels
        : 0;
    },
  );
  return (next: number) => {
    pixels = next;
    fireEvent(window, new Event("resize"));
  };
}
function list() {
  return screen.getByTestId("sidebar-chat-threads-virtual-list");
}
function viewport() {
  return screen.getByLabelText("Chat threads");
}
function scrollTo(top: number) {
  const node = viewport();
  node.scrollTop = top;
  fireEvent.scroll(node);
}
function row(title: string) {
  return within(list()).getByText(title);
}
async function current(name: string) {
  await waitFor(() => {
    return expect(document.title).toBe(name + " | Okou");
  });
}
interface Scene {
  count?: number;
  projects?: number;
  children?: number;
  open?: boolean;
  height?: number;
  mobile?: boolean;
  filter?: "Archived" | "Unread";
  overflow?: boolean;
  notice?: string;
  phases?: boolean;
}
async function openHistory({
  count = 26,
  projects = 0,
  children = 2,
  open = false,
  height = 180,
  mobile = false,
  filter,
  overflow = false,
  notice,
  phases,
}: Scene = {}) {
  if (mobile) {
    context.mocks.browser.matchMedia(false);
  }
  const resize = layout(height, notice);
  const groups = Array.from({ length: projects }, (_, i) => {
    return {
      id: "f1500000-0000-4000-a000-" + String(i + 1).padStart(12, "0"),
      name: "Project " + (i + 1),
      createdAt: "2026-08-01T01:00:00Z",
      updatedAt: "2026-08-01T01:00:00Z",
    };
  });
  const group = groups.at(-1);
  const threads = Array.from({ length: count }, (_, i) => {
    const stamp = new Date(Date.UTC(2026, 7, 1) - i * 1000).toISOString();
    return chatListThread(
      i + 1,
      overflow
        ? i === 0
          ? "Release plan"
          : i === count - 1
            ? "Archived context"
            : "Earlier conversation " + i
        : "History " + (i + 1),
      {
        createdAt: stamp,
        updatedAt: stamp,
        sortAt: stamp,
        projectId: group && i < children ? group.id : null,
        archived: filter === "Archived" && i < children + 2,
      },
    );
  });
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 915,
    threads,
  });
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: groups,
      latestEventId: null,
      latestSeqId: 0,
    });
  });
  context.mocks.api(projectsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  if (filter === "Unread") {
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        threads: Object.fromEntries(
          threads.slice(0, children + 2).map((t) => {
            return [t.id, "unread" as const];
          }),
        ),
        unreadAt: Object.fromEntries(
          threads.slice(0, children + 2).map((t) => {
            return [t.id, t.updatedAt];
          }),
        ),
      });
    });
  }
  if (phases) {
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        threads: Object.fromEntries(
          threads
            .filter((_, i) => {
              return i !== 1;
            })
            .map((t) => {
              return [t.id, "active" as const];
            }),
        ),
        unreadAt: { [threads[1]!.id]: threads[1]!.updatedAt },
      });
    });
    context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
      return respond(204);
    });
  }
  await setupPage({
    context,
    ...pageOptions,
    host: notice ? "app.okou.ai" : undefined,
    path: open ? "/chats/" + threads[0]!.id : "/",
  });
  if (filter === "Unread") {
    await within(
      await screen.findByTestId("sidebar-chat-threads-virtual-list"),
    ).findAllByText("Unread");
  }
  if (filter) {
    click(await findFastControl("button", "Open chat list menu"));
    click(
      await within(await screen.findByRole("menu")).findByText(filter, {
        exact: true,
      }),
    );
  }
  await screen.findByTestId("sidebar-chat-threads-virtual-list");
  return { resize, threads };
}
async function shown(title: string) {
  return await waitFor(() => {
    return row(title);
  });
}
async function toggle(title = "Project 1") {
  click(await findFastControl("button", "Show or hide chats in " + title));
}
async function stableHeight(rows: number, height = 36) {
  await waitFor(() => {
    return expect(list()).toHaveStyle({ height: rows * height + "px" });
  });
}
test("sidebar-virtualization-001 Opening a conversation adds keyboard focus to its viewport and starting a new chat removes it", async () => {
  await openHistory({ count: 32 });
  await shown("History 1");
  expect(viewport()).not.toHaveAttribute("tabindex", "0");
  click(row("History 1"));
  await current("History 1");
  expect(viewport()).toHaveAttribute("tabindex", "0");
  click(await findFastControl("link", /^New chat/));
  await waitFor(() => {
    return expect(viewport()).not.toHaveAttribute("tabindex", "0");
  });
});
test("sidebar-virtualization-002 Adjacent-chat navigation scrolls the focused viewport back from History 17 to History 2", async () => {
  await openHistory({ count: 32, open: true });
  await current("History 1");
  viewport().focus();
  scrollTo(16 * 36);
  await shown("History 17");
  fireEvent.keyDown(viewport(), {
    key: "ArrowDown",
    code: "ArrowDown",
    ctrlKey: true,
    shiftKey: true,
  });
  await current("History 2");
  await waitFor(() => {
    return expect(viewport().scrollTop).toBe(36);
  });
  expect(viewport()).toHaveAttribute("tabindex", "0");
});
test("sidebar-chat-history-001 Scrolling the overflow reveals Archived context and moves Release plan out of the chat list", async () => {
  await openHistory({ count: 32, overflow: true });
  await shown("Release plan");
  scrollTo(27 * 36);
  await shown("Archived context");
  expect(within(list()).queryByText("Release plan")).toBeNull();
  expect(screen.queryByText("Load more")).toBeNull();
});
test("sidebar-virtualization-024 A resized 6406-chat viewport redraws its visible range and keeps that range while opening History 2", async () => {
  const { resize } = await openHistory({
    count: 6406,
    open: true,
    height: 612,
  });
  await current("History 1");
  const rows = () => {
    return within(list()).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    return expect(rows()).toHaveLength(25);
  });
  resize(900);
  await waitFor(() => {
    return expect(rows()).toHaveLength(33);
  });
  resize(360);
  await waitFor(() => {
    return expect(rows()).toHaveLength(18);
  });
  click(row("History 2"));
  await current("History 2");
  expect(rows()).toHaveLength(18);
  expect(row("History 2").closest("a")).toHaveAttribute("aria-current", "page");
});
test("sidebar-virtualization-003 Expanding the last Project reveals both chats and the list remains navigable after collapsing", async () => {
  await openHistory({ count: 32, projects: 17 });
  scrollTo(16 * 36);
  await toggle("Project 17");
  await shown("History 2");
  expect(row("History 1")).toBeVisible();
  await toggle("Project 17");
  await waitFor(() => {
    return expect(within(list()).queryByText("History 1")).toBeNull();
  });
  expect(within(list()).queryByText("History 2")).toBeNull();
  expect(row("History 3")).toBeVisible();
  await toggle("Project 17");
  click(await shown("History 1"));
  await current("History 1");
});
test("sidebar-virtualization-004 A two-chat Project adds exactly two row heights and its neighbor remains navigable during collapse", async () => {
  await openHistory({ projects: 1 });
  await stableHeight(25);
  await toggle();
  await stableHeight(27);
  await shown("History 2");
  await toggle();
  await waitFor(() => {
    return expect(list()).toHaveAttribute(
      "data-project-fold-state",
      "prepared",
    );
  });
  click(row("History 3"));
  await current("History 3");
  await stableHeight(25);
  expect(within(list()).queryByText("History 1")).toBeNull();
});
test("sidebar-virtualization-006 Reopening before the first collapse frame keeps both children usable", async () => {
  await openHistory({ projects: 1 });
  await toggle();
  await stableHeight(27);
  await toggle();
  await waitFor(() => {
    return expect(list()).toHaveAttribute(
      "data-project-fold-state",
      "prepared",
    );
  });
  await toggle();
  click(await shown("History 1"));
  await current("History 1");
});
test("sidebar-virtualization-011 A touch movement before the reveal frame ends mobile motion at the full height", async () => {
  await openHistory({ projects: 1, mobile: true });
  await stableHeight(25, 60);
  await toggle();
  await waitFor(() => {
    return expect(list()).toHaveAttribute(
      "data-project-fold-state",
      "prepared",
    );
  });
  fireEvent.touchMove(viewport());
  await stableHeight(27, 60);
  expect(list()).not.toHaveAttribute("data-project-fold-state");
  click(await shown("History 1"));
  await current("History 1");
});
test("sidebar-virtualization-019 Returning from a conversation during mobile expansion restores the expanded Project without motion", async () => {
  await openHistory({ projects: 1, mobile: true });
  await toggle();
  await waitFor(() => {
    return expect(list()).toHaveAttribute(
      "data-project-fold-state",
      "prepared",
    );
  });
  click(row("History 3"));
  await current("History 3");
  expect(screen.queryByTestId("sidebar-chat-threads-virtual-list")).toBeNull();
  window.history.back();
  await screen.findByTestId("sidebar-chat-threads-virtual-list");
  await shown("History 1");
  await stableHeight(27, 60);
  expect(list()).not.toHaveAttribute("data-project-fold-state");
});
test("sidebar-virtualization-023 Collapsing at the expanded bottom immediately returns the 19-row list and keeps the next chat visible", async () => {
  await openHistory({ count: 4, projects: 17, height: 5 * 36 });
  scrollTo(14 * 36);
  await toggle("Project 17");
  await stableHeight(21);
  scrollTo(16 * 36);
  await shown("History 1");
  await toggle("Project 17");
  await stableHeight(19);
  expect(within(list()).queryByText("History 1")).toBeNull();
  expect(row("History 3")).toBeVisible();
});
test("sidebar-virtualization-018 A ten-thousand-chat Project keeps a bounded set of rows mounted across both ends and collapse", async () => {
  await openHistory({
    projects: 1,
    count: 10_024,
    children: 10_000,
    height: 180,
  });
  await stableHeight(25);
  const observed: number[] = [];
  const record = () => {
    return observed.push(
      list().querySelectorAll('[data-testid="sidebar-chat-thread-virtual-row"]')
        .length,
    );
  };
  const changes = new MutationObserver(record);
  changes.observe(list(), { subtree: true, childList: true });
  try {
    record();
    await toggle();
    await shown("History 1");
    fireEvent.wheel(viewport(), { deltaY: 40 });
    await stableHeight(10_025);
    scrollTo(9999 * 36);
    await shown("History 10000");
    record();
    scrollTo(0);
    await shown("History 1");
    await toggle();
    await stableHeight(25);
    expect(within(list()).queryByText("History 1")).toBeNull();
    record();
    expect(Math.max(...observed)).toBeLessThanOrEqual(68);
  } finally {
    changes.disconnect();
  }
});
test("sidebar-virtualization-020 The archived footer stays outside the desktop list through expansion and wheel cancellation", async () => {
  await openHistory({ projects: 1, filter: "Archived", count: 5 });
  await stableHeight(3);
  const show = await findFastControl("button", "Show all chats");
  expect(list()).not.toContainElement(show);
  await toggle();
  await stableHeight(5);
  await toggle();
  fireEvent.wheel(viewport(), { deltaY: 24 });
  await stableHeight(3);
  click(show);
  await waitFor(() => {
    return expect(screen.queryByText("Show all chats")).toBeNull();
  });
});
test("sidebar-virtualization-022 The mobile unread footer occupies one row throughout touch cancellation and disappears when all chats are shown", async () => {
  await openHistory({ projects: 1, filter: "Unread", count: 5, mobile: true });
  await stableHeight(4, 60);
  const show = await findFastControl("button", "Show all chats");
  expect(list()).toContainElement(show);
  await toggle();
  await shown("History 1");
  fireEvent.touchMove(viewport());
  await stableHeight(6, 60);
  await toggle();
  fireEvent.touchMove(viewport());
  await stableHeight(4, 60);
  click(show);
  await shown("History 3");
  expect(screen.queryByText("Show all chats")).toBeNull();
});
test("sidebar-virtualization-031 A delayed service incident shrinks the mobile chat viewport and dismissing it restores twenty rows", async () => {
  const notice = "Limited chat service",
    release = context.mocks.deferred<void>(),
    reading = context.mocks.deferred<void>();
  context.mocks.http.get("https://api.instatus.com/issues", async () => {
    reading.resolve();
    await release.promise;
    return HttpResponse.json({
      activeIncidents: [
        { id: "test-interruption", name: notice, status: "INVESTIGATING" },
      ],
    });
  });
  try {
    await openHistory({ count: 120, mobile: true, height: 720, notice });
    await reading.promise;
    const count = () => {
      return within(list()).getAllByTestId("sidebar-chat-thread-virtual-row")
        .length;
    };
    await waitFor(() => {
      return expect(count()).toBe(20);
    });
    release.resolve();
    await screen.findByText(notice);
    await waitFor(() => {
      return expect(count()).toBe(13);
    });
    click(await findFastControl("button", /Dismiss/));
    await waitFor(() => {
      return expect(count()).toBe(20);
    });
    expect(screen.queryByText(notice)).toBeNull();
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
});
test("sidebar-virtualization-026 Running waves use the full row index after scrolling and follow the new order after pinning", async () => {
  await openHistory({ count: 120, phases: true });
  const phase = (title: string) => {
    const box = row(title).closest(
      '[data-testid="sidebar-chat-thread-virtual-row"]',
    )!;
    const indicator = box.querySelector<HTMLElement>(
      '[style*="--running-indicator-phase"]',
    );
    if (!indicator) {
      throw new Error("Missing running indicator for " + title);
    }
    return Number(
      indicator.style.getPropertyValue("--running-indicator-phase"),
    );
  };
  await waitFor(() => {
    return expect(phase("History 3")).toBeCloseTo(-10 / 12);
  });
  expect(row("History 2").closest("a")).toHaveAccessibleName(/Unread/);
  scrollTo(40 * 36);
  await shown("History 41");
  expect(phase("History 41")).toBeCloseTo(-8 / 12);
  scrollTo(0);
  await shown("History 3");
  expect(phase("History 3")).toBeCloseTo(-10 / 12);
  const item = row("History 3").closest(
    '[data-testid="sidebar-chat-thread-virtual-row"]',
  )!;
  click(within(item as HTMLElement).getByTestId("chat-thread-menu-trigger"));
  click(await screen.findByText("Pin chat"));
  await waitFor(() => {
    return expect(phase("History 3")).toBe(0);
  });
  expect(phase("History 1")).toBeCloseTo(-11 / 12);
});
test("sidebar-virtualization-008 Reversing a running fold begins at its measured child height and leaves the restored conversation usable", async () => {
  await openHistory({ projects: 1 });
  await toggle();
  await stableHeight(27);
  const node = list();
  const finish = context.mocks.deferred<void>();
  const previous = node.getAnimations;
  try {
    Object.defineProperty(node, "getAnimations", {
      configurable: true,
      value: () => {
        return [
          {
            transitionProperty: "--okou-project-fold-height",
            finished: finish.promise,
          },
        ];
      },
    });
    await toggle();
    await waitFor(() => {
      return expect(node).toHaveAttribute("data-project-fold-state", "running");
    });
    const content = node.querySelector<HTMLElement>(
      "[data-project-children-id]",
    )!;
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 200, 28),
    );
    await toggle();
    await waitFor(() => {
      return expect(
        node.style.getPropertyValue("--okou-project-fold-height"),
      ).toBe("28px");
    });
    expect(row("History 1")).toBeVisible();
    finish.resolve();
    await stableHeight(27);
    click(row("History 1"));
    await current("History 1");
  } finally {
    if (!finish.settled()) {
      finish.resolve();
    }
    Object.defineProperty(node, "getAnimations", {
      configurable: true,
      value: previous,
    });
  }
});
