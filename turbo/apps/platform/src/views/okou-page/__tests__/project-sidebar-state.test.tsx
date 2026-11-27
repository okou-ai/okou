import {
  projectsContract,
  type Project,
} from "@okouai/api-contracts/contracts/projects";
import {
  chatThreadsContract,
  chatThreadPinOrderContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  cleanup,
  screen,
  within,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { test, expect, vi } from "vitest";
import {
  setupPage,
  startPage,
  type SetupPageAuth,
  click,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
  mockChatThreadSnapshotResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  chatListAuth,
  chatListThread,
  cachedChatListEvents,
  installActiveChatBoundaries,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();

const time = "2026-08-03T12:00:00Z";
function project(name: string): Project {
  return { id: crypto.randomUUID(), name, createdAt: time, updatedAt: time };
}
function title(name: string) {
  return findFastControl("button", "Show or hide chats in " + name);
}
function snapshot(item: Project, seq: number, reply?: () => Promise<void>) {
  const eventId = crypto.randomUUID();
  context.mocks.api(projectsContract.snapshot, async ({ respond }) => {
    await reply?.();
    return respond(200, {
      projects: [item],
      latestSeqId: seq,
      latestEventId: eventId,
    });
  });
}
test("project-cache-002 a thread list notification discovers a chat after an empty snapshot", async () => {
  const auth = chatListAuth(902),
    chat = chatListThread(22, "Planning conversation");
  let published = false;
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: published ? [chat] : [],
        latestEventId: published ? chat.id : null,
        latestSeqId: published ? 1 : null,
      }),
    );
  });
  snapshot(project("Launch"), 1);
  await setupPage({
    context,
    path: "/",
    auth,
    cachedChatThreadEvents: { snapshot: null, events: [] },
  });
  await title("Launch");
  expect(screen.queryByText("Planning conversation")).toBeNull();
  published = true;
  changeChatThreadList();
  await findFastControl("link", /Planning conversation/);
});
test("project-cache-006 an expired persisted project cursor rebuilds the visible project from a new snapshot", async () => {
  const first = createTestRuntime(context),
    second = createTestRuntime(context),
    auth = chatListAuth(906),
    launch = project("Launch"),
    event = {
      id: crypto.randomUUID(),
      seqId: 2,
      projectId: launch.id,
      kind: "renamed" as const,
      name: "Launch ready",
      createdAt: time,
    };
  snapshot(launch, 1);
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: query.sinceSeqId < 2 ? [event] : [],
      hasMore: false,
    });
  });
  await setupPage({
    context: first,
    path: "/",
    auth,
  });
  await title("Launch ready");
  cleanup();
  const gate = context.mocks.deferred<void>(),
    waiting = context.mocks.deferred<void>();
  snapshot({ ...launch, name: "Launch restored" }, 5);
  context.mocks.api(projectsContract.events, async ({ query, respond }) => {
    if (query.sinceSeqId === 2) {
      if (!waiting.settled()) {
        waiting.resolve();
      }
      await gate.promise;
      return respond(410, {
        error: { code: "CURSOR_EXPIRED", message: "Expired sequence" },
      });
    }
    return respond(200, { events: [], hasMore: false });
  });
  const page = await startPage({
    context: second,
    path: "/",
    auth,
  });
  await waiting.promise;
  await title("Launch ready");
  expect(screen.queryByText("Launch restored")).toBeNull();
  gate.resolve();
  await page.ready;
  await title("Launch restored");
  expect(screen.queryByText("Launch ready")).toBeNull();
});
test.each(["projects", "chats"] as const)(
  "switching workspace cancels the old %s read even when both snapshots have the same cursor",
  async (dataset) => {
    const first = createTestRuntime(context);
    const second = createTestRuntime(context);
    const auth = chatListAuth(dataset === "projects" ? 981 : 982);
    const nextOrg = { id: "org_next", name: "Next workspace" };
    const nextAuth = {
      ...auth,
      organization: { activeOrg: nextOrg, memberships: [nextOrg] },
    };
    const started = context.mocks.deferred<AbortSignal>();
    const release = context.mocks.deferred<void>();
    const replied = context.mocks.deferred<void>();
    const oldProject = project("Original project");
    const newProject = project("Next project");
    const oldChat = chatListThread(41, "Original conversation");
    const newChat = chatListThread(42, "Next conversation");
    let nextWorkspace = false;
    context.mocks.api(projectsContract.snapshot, ({ respond }) => {
      return respond(200, {
        projects: [nextWorkspace ? newProject : oldProject],
        latestSeqId: 1,
        latestEventId: null,
      });
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      const chat = nextWorkspace ? newChat : oldChat;
      return respond(
        200,
        mockChatThreadSnapshotResponse(context, {
          chatThreads: [chat],
          latestSeqId: 1,
          latestEventId: chat.id,
        }),
      );
    });
    async function holdOldRead(
      name: typeof dataset,
      request: Request,
      cursor?: number,
    ) {
      if (!nextWorkspace && dataset === name && cursor === 1) {
        if (!started.settled()) {
          started.resolve(request.signal);
        }
        await release.promise;
        if (!replied.settled()) {
          replied.resolve();
        }
      }
    }
    context.mocks.api(
      projectsContract.events,
      async ({ request, query, respond }) => {
        await holdOldRead("projects", request, query.sinceSeqId);
        return respond(200, { events: [], hasMore: false });
      },
    );
    context.mocks.api(
      chatThreadsContract.events,
      async ({ request, query, respond }) => {
        await holdOldRead("chats", request, query.sinceSeqId);
        return respond(200, { events: [], hasMore: false });
      },
    );
    const options = {
      path: "/",
    } as const;
    const page = await startPage({ ...options, context: first, auth });
    await page.content;
    const pending = await started.promise;
    const clerk = context.mocks.clerk();
    nextWorkspace = true;
    clerk.organization(nextAuth.organization);
    clerk.stateChanged();
    await waitFor(() => {
      expect(pending.aborted).toBeTruthy();
    });
    cleanup();

    await setupPage({ ...options, context: second, auth: nextAuth });
    await title(newProject.name);
    await findFastControl("link", /Next conversation/);
    expect(screen.queryByText(oldProject.name)).toBeNull();
    expect(screen.queryByText("Original conversation")).toBeNull();

    release.resolve();
    await replied.promise;
    first.dispose();
    second.dispose();
    cleanup();
    // A cancelled cold read must fetch a snapshot again when its member returns.
    // A late commit would instead resume its old, still-valid cursor.
    snapshot(project("Reopened project"), 1);
    installChatListStream(context, {
      caseId: 983,
      snapshot: [chatListThread(43, "Reopened conversation")],
    });
    await setupPage({ ...options, context: createTestRuntime(context), auth });
    if (dataset === "projects") {
      await title("Reopened project");
    } else {
      await findFastControl("link", /Reopened conversation/);
    }
  },
);
test.each([
  ["007", "account"],
  ["008", "workspace"],
] as const)(
  "project-cache-%s a different %s cannot inherit the previous owner's cached project",
  async (_id, kind) => {
    const first = createTestRuntime(context),
      second = createTestRuntime(context),
      firstAuth = chatListAuth(907);
    snapshot(project("Launch"), 1);
    await setupPage({
      context: first,
      path: "/",
      auth: firstAuth,
    });
    await title("Launch");
    cleanup();
    const auth: SetupPageAuth =
      kind === "account"
        ? {
            ...firstAuth,
            user: { id: "user_other_harbor", fullName: "New reader" },
          }
        : {
            ...firstAuth,
            organization: {
              activeOrg: { id: "org_other_harbor", name: "Other workspace" },
              memberships: [{ id: "org_other_harbor" }],
            },
          };
    const gate = context.mocks.deferred<void>(),
      waiting = context.mocks.deferred<void>();
    snapshot(project("Other owner's Project"), 1, async () => {
      if (!waiting.settled()) {
        waiting.resolve();
      }
      await gate.promise;
    });
    const next = await startPage({
      context: second,
      path: "/",
      auth,
    });
    await waiting.promise;
    await next.content;
    expect(
      queryFastControl("button", "Show or hide chats in Launch"),
    ).toBeNull();
    gate.resolve();
    await next.ready;
    await title("Other owner's Project");
    expect(
      queryFastControl("button", "Show or hide chats in Launch"),
    ).toBeNull();
  },
);

const canon = Object.freeze(["Launch", "Research", "Campaign"]),
  reordered = Object.freeze(["Research", "Launch", "Campaign"]),
  now = "2026-08-01T09:00:00Z";
async function start(at: "pin" | "project" | "home") {
  const projects: Project[] = canon.map((name, index) => {
    return {
      id: crypto.randomUUID(),
      name,
      sortOrder: "a" + index,
      createdAt: now,
      updatedAt: now,
    };
  });
  const research = projects[1]!;
  const first = chatListThread(31, "First pin", {
      pinnedAt: now,
      pinOrder: "a0",
    }),
    second = chatListThread(32, "Current pin", {
      pinnedAt: now,
      pinOrder: "a1",
    }),
    inside = chatListThread(33, "Unread Research", { projectId: research.id });
  const threads = [first, second, inside];
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects,
      latestSeqId: 1,
      latestEventId: crypto.randomUUID(),
    });
  });
  context.mocks.api(projectsContract.reorder, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(
    chatThreadPinOrderContract.reorder,
    ({ body, params, respond }) => {
      const pin = threads.find((item) => {
        return item.id === params.id;
      });
      if (!pin) {
        throw new Error("Unknown pin");
      }
      pin.pinOrder = body.pinOrder;
      return respond(204);
    },
  );
  context.mocks.api(projectsContract.threads, ({ params, respond }) => {
    return respond(200, {
      threads: threads.filter((chat) => {
        return chat.projectId === params.id;
      }),
      nextAfter: null,
    });
  });
  installChatListStream(context, { caseId: 859, snapshot: threads });
  installActiveChatBoundaries(context, { metadata: second });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: { [inside.id]: "unread" },
      unreadAt: { [inside.id]: now },
    });
  });
  const path =
    at === "pin"
      ? "/chats/" + second.id
      : at === "project"
        ? "/projects/" + research.id
        : "/";
  await setupPage({
    context,
    path,
    auth: chatListAuth(859),
    cachedChatThreadEvents: cachedChatListEvents(859, threads),
  });
  await check(canon);
  return path;
}
function check(names: readonly string[]) {
  return waitFor(() => {
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-project-trigger]"),
      ).map((row) => {
        return row
          .getAttribute("aria-label")
          ?.replace("Show or hide chats in ", "");
      }),
    ).toStrictEqual(names);
  });
}
function orderedProject() {
  return findFastControl("button", "Show or hide chats in Research");
}
function menu() {
  return findFastControl("button", "Options for Research");
}
async function filter(text: string) {
  click(await findFastControl("button", "Open chat list menu"));
  const panel = await screen.findByRole("menu");
  click(await within(panel).findByText(text));
}
function shortcut(
  target: HTMLElement,
  key: string,
  extra: KeyboardEventInit = {},
) {
  return fireEvent.keyDown(target, {
    key,
    altKey: true,
    shiftKey: true,
    ...extra,
  });
}
test("project-order-003 the project shortcut ignores composition, repeat and Meta, keeping the edited draft focused", async () => {
  const path = await start("project"),
    editor = await findComposerEditor();
  await fill(editor, "Unsent project request");
  editor.focus();
  for (const modifiers of [
    { isComposing: true },
    { repeat: true },
    { metaKey: true },
  ]) {
    expect(shortcut(editor, "ArrowUp", modifiers)).toBeTruthy();
    await check(canon);
  }
  shortcut(editor, "ArrowUp");
  await check(reordered);
  expect(editor).toHaveFocus();
  expect(editor.textContent).toBe("Unsent project request");
  expect(location.pathname).toBe(path);
  click(await findFastControl("button", "Open chat list menu"));
  const panel = await screen.findByRole("menu");
  fireEvent.keyDown(panel, { key: "ArrowUp" });
  fireEvent.keyDown(panel, { key: "ArrowDown" });
  await check(reordered);
});
test("project-order-006 filtering to Unread prevents Research from moving out of its canonical Inbox position", async () => {
  await start("home");
  await filter("Unread");
  await check(["Research"]);
  click(await menu());
  const panel = await screen.findByRole("menu");
  expect(within(panel).getByText("Rename")).toBeInTheDocument();
  expect(within(panel).queryByText("Move up")).toBeNull();
  fireEvent.keyDown(panel, { key: "Escape" });
  const trigger = await orderedProject();
  trigger.focus();
  shortcut(trigger, "ArrowUp");
  await filter("Inbox");
  await check(canon);
  click(await menu());
  const item = await within(await screen.findByRole("menu")).findByText(
    "Move up",
  );
  expect(item.closest('[role="menuitem"]')).toHaveAttribute(
    "aria-keyshortcuts",
    "Alt+Shift+ArrowUp",
  );
});

test("project-order-002 project and pin shortcuts keep their own ordering and keyboard focus", async () => {
  const chat = await start("pin");
  const pin = (name: string) => {
    return waitFor(() => {
      const link = Array.from(
        document.querySelectorAll<HTMLElement>("[data-sidebar-chat-thread-id]"),
      ).find((el) => {
        return el.textContent?.includes(name);
      });
      expect(link).toBeDefined();
      return link;
    });
  };
  const first = await pin("First pin");
  const current = await pin("Current pin");
  if (!first || !current) {
    throw new Error("Pinned navigation target missing");
  }
  function before(a: Element, b: Element) {
    return Boolean(
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }
  expect(before(first, current)).toBeTruthy();
  const target = await orderedProject();
  target.focus();
  shortcut(target, "ArrowUp");
  await check(reordered);
  expect(target).toHaveFocus();
  expect(location.pathname).toBe(chat);
  expect(before(first, current)).toBeTruthy();
  const trigger = await menu();
  click(trigger);
  const down = await within(await screen.findByRole("menu")).findByText(
    "Move down",
  );
  const item = down.closest<HTMLElement>('[role="menuitem"]');
  if (!item) {
    throw new Error("Move down item missing");
  }
  item.focus();
  shortcut(item, "ArrowDown");
  await check(canon);
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  await userEvent.keyboard("{Escape}");
  const pinnedLink = await findFastControl("link", /current pin/i);
  pinnedLink.focus();
  expect(pinnedLink).toHaveFocus();
  await userEvent.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
  await waitFor(() => {
    return expect(
      Array.from(
        document.querySelectorAll("[data-sidebar-chat-thread-id]"),
        (el) => {
          return el.textContent;
        },
      )
        .filter((txt) => {
          return txt?.includes("pin");
        })
        .slice(0, 2),
    ).toStrictEqual([
      expect.stringContaining("Current pin"),
      expect.stringContaining("First pin"),
    ]);
  });
  await check(canon);
  expect(location.pathname).toBe(chat);
});

test("worker-runtime-012 A project refreshed after cursor expiration is cached at the new sequence for its owner", async () => {
  const owner = chatListAuth(816);
  const item = {
    id: crypto.randomUUID(),
    name: "East access",
    createdAt: "2026-08-04T10:00:00Z",
    updatedAt: "2026-08-04T10:00:00Z",
  };
  const stamp = crypto.randomUUID(),
    next = crypto.randomUUID(),
    renamed = "Covered east entrance";
  let expired = false,
    offline = false;
  const denied = context.mocks.deferred<void>(),
    refresh = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>(),
    network = context.mocks.deferred<void>();
  context.mocks.api(projectsContract.snapshot, async ({ respond }) => {
    if (offline) {
      await network.promise;
    }
    if (expired) {
      if (!refresh.settled()) {
        refresh.resolve();
      }
      await release.promise;
    }
    return respond(200, {
      projects: [{ ...item, name: expired ? renamed : item.name }],
      latestSeqId: expired ? 5 : 1,
      latestEventId: expired ? next : stamp,
    });
  });
  context.mocks.api(projectsContract.events, async ({ query, respond }) => {
    if (offline) {
      await network.promise;
    }
    if (expired && query.sinceSeqId === 1) {
      if (!denied.settled()) {
        denied.resolve();
      }
      return respond(410, {
        error: { code: "CURSOR_EXPIRED", message: "Reload the project list" },
      });
    }
    return respond(200, { events: [], hasMore: false });
  });
  const start = (auth: typeof owner, runtime = createTestRuntime(context)) => {
    return startPage({
      context: runtime,
      path: "/",
      auth,
    });
  };
  const title = (name: string) => {
    return findFastControl("button", "Show or hide chats in " + name);
  };
  function unmount() {
    cleanup();
    if (vi.isMockFunction(history.replaceState)) {
      vi.mocked(history.replaceState).mockRestore();
    }
  }
  const first = await start(owner);
  await first.ready;
  await expect(title(item.name)).resolves.toBeVisible();
  expired = true;
  context.mocks.ably.triggerOnChannel(
    "user-org:" + owner.user.id + ":" + owner.organization!.activeOrg!.id,
    "threadListChanged",
  );
  await denied.promise;
  await refresh.promise;
  expect(
    queryFastControl("button", "Show or hide chats in " + renamed),
  ).toBeNull();
  release.resolve();
  await expect(title(renamed)).resolves.toBeVisible();
  unmount();
  offline = true;
  const checked = context.mocks.deferred<number>();
  context.mocks.api(projectsContract.events, async ({ query, respond }) => {
    if (!checked.settled()) {
      checked.resolve(query.sinceSeqId);
    }
    await network.promise;
    return respond(200, { events: [], hasMore: false });
  });
  const offlineRuntime = createTestRuntime(context);
  const reopened = await start(owner, offlineRuntime);
  await reopened.content;
  await expect(title(renamed)).resolves.toBeVisible();
  await expect(checked.promise).resolves.toBe(5);
  offlineRuntime.dispose();
  await expect(reopened.ready).rejects.toMatchObject({ name: "AbortError" });
  unmount();
  const visitorSeen = context.mocks.deferred<void>();
  context.mocks.api(projectsContract.snapshot, async ({ respond }) => {
    if (!visitorSeen.settled()) {
      visitorSeen.resolve();
    }
    await network.promise;
    return respond(200, { projects: [], latestSeqId: 0, latestEventId: null });
  });
  const visitor = await start({
    ...owner,
    user: { ...owner.user, id: "separate-project-reader" },
  });
  await visitor.content;
  await visitorSeen.promise;
  expect(
    queryFastControl("button", "Show or hide chats in " + renamed),
  ).toBeNull();
  network.resolve();
  await visitor.ready;
  expect(
    queryFastControl("button", "Show or hide chats in " + renamed),
  ).toBeNull();
});
