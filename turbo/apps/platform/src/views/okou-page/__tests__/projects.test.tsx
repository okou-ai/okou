import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import type { ProjectEvent } from "@okouai/api-contracts/validators/projects";
import {
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
  chatThreadMetadataContract,
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  click,
  fill,
  setupPage,
  startPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import {
  installContinuityWorkspace,
  continuityThread,
  continuityEventRow,
} from "./chat-continuity-test-helpers.ts";
import {
  createDataTransferStub,
  menuItemByText,
  openChatListMenu,
} from "./sidebar-test-helpers.tsx";

const context = testContext();
const reloadedContext = createTestRuntime(context);
const id = "30000000-0000-4000-8000-000000000071";
const campaignId = "30000000-0000-4000-8000-000000000171";
const at = "2026-11-02T00:00:00.000Z";
// A Project's rows are siblings in the virtual list, so its group is the
// ordered set of rows that carry its id.
function projectRows(projectId = id) {
  const rows = [
    ...document.querySelectorAll<HTMLElement>(
      `[data-project-row-id="${projectId}"]`,
    ),
  ];
  if (rows.length === 0) {
    throw new Error("Project not found");
  }
  return rows;
}
function projectRow(projectId = id) {
  return projectRows(projectId)[0]!;
}
type QueryScope = HTMLElement | Document | readonly HTMLElement[];
function queryAllInScope(
  role: Parameters<typeof queryAllByRoleFast>[0],
  scope: QueryScope,
) {
  return Array.isArray(scope)
    ? scope.flatMap((container: HTMLElement) => {
        return queryAllByRoleFast(role, container);
      })
    : queryAllByRoleFast(role, scope as HTMLElement | Document);
}
function button(name: string, container: QueryScope = document) {
  const found = queryAllInScope("button", container).find((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      item.textContent?.trim() === name
    );
  });
  if (!found) {
    throw new Error(`Button ${name} not found`);
  }
  return found;
}
// The folder icon folds a Project; its name links to the Project's page.
function projectToggle(name: string, projectId = id) {
  return button(`Show or hide chats in ${name}`, projectRows(projectId));
}
function projectLink(name: string, projectId = id) {
  const link = namedLink(projectRows(projectId), name);
  if (!link) {
    throw new Error(`Project link ${name} not found`);
  }
  return link;
}
function findMenuItem(name: string) {
  return waitFor(() => {
    const item = queryAllByRoleFast("menuitem").find((candidate) => {
      return (
        candidate.textContent?.trim() === name ||
        candidate.getAttribute("aria-label") === name
      );
    });
    if (!item) {
      throw new Error(`Menu item ${name} not found`);
    }
    return item;
  });
}
function namedLink(container: QueryScope, name: string) {
  return (
    queryAllInScope("link", container).find((link) => {
      return link.textContent?.trim() === name;
    }) ?? null
  );
}
function threadLink(threadId: string) {
  const link = document.querySelector<HTMLAnchorElement>(
    `[data-sidebar-chat-thread-id="${threadId}"]`,
  );
  if (!link) {
    throw new Error("Chat link not found");
  }
  return link;
}
function composerCard() {
  const card = document.querySelector<HTMLElement>(
    '[data-slot="chat-composer-card"]',
  );
  if (!card) {
    throw new Error("Composer not found");
  }
  return card;
}
// The chip names the Project and, like the task chip, removes it.
function projectChip(name: string) {
  return button(`Remove ${name}`, composerCard());
}
function queryProjectChip(name: string) {
  return (
    queryAllByRoleFast("button", composerCard()).find((item) => {
      return item.getAttribute("aria-label") === `Remove ${name}`;
    }) ?? null
  );
}
async function openComposerProjectMenu() {
  click(button("Add", composerCard()));
  const menu = await screen.findByRole("menu", { name: "Add" });
  return menu;
}
function menuLabels(menu: HTMLElement) {
  return queryAllByRoleFast("menuitem", menu).map((item) => {
    return item.textContent?.trim() ?? "";
  });
}
function mockThreadCreation(created: {
  threadId?: string;
  projectId?: string | null;
}) {
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    created.threadId = body.clientThreadId;
    created.projectId = body.projectId ?? null;
    return respond(201, {
      id: body.clientThreadId ?? crypto.randomUUID(),
      title: null,
      createdAt: at,
      selectedModel: body.model ?? null,
      serviceTier: null,
      projectId: body.projectId ?? null,
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    return respond(201, {
      threadId: body.threadId ?? crypto.randomUUID(),
      createdAt: at,
    });
  });
}
function metadata(extra: readonly { id: string; name: string }[] = []) {
  const p = { id, name: "Launch", createdAt: at, updatedAt: at };
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [
        p,
        ...extra.map((project) => {
          return {
            ...project,
            createdAt: at,
            updatedAt: at,
          };
        }),
      ],
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(agentDraftContract.patch, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadByIdContract.patch, ({ respond }) => {
    return respond(204);
  });
}

function releasePageDom() {
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

test("My Okou's Project rows carry only their menu, since New chat leads the list", async () => {
  const thread = continuityThread(222, 1, "Ordinary chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 222,
    threads: [thread],
  });
  metadata();
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
    featureSwitches: {
      [FeatureSwitchKey.SingleAgent]: true,
      [FeatureSwitchKey.Projects]: true,
    },
  });
  await waitFor(() => {
    expect(projectToggle("Launch")).toBeInTheDocument();
  });
  expect(
    queryAllByRoleFast("button", projectRow()).map((item) => {
      return item.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Show or hide chats in Launch", "Options for Launch"]);
});

test("Cached Projects appear before chat setup and remote synchronization finish", async () => {
  const thread = continuityThread(112, 1, "Cached conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 112,
    threads: [thread],
  });
  metadata();
  const resetPage$ = resetSignal();
  const signal = context.store.set(resetPage$, context.signal);
  const options = {
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
    sharedWorkerTestTransport: "message-port" as const,
  };
  await setupPage({ context: { ...context, signal }, ...options });
  expect(projectToggle("Launch")).toBeInTheDocument();

  context.store.set(resetPage$);
  releasePageDom();
  const chatSetupStarted = context.mocks.deferred<void>();
  const chatSetup = context.mocks.deferred<void>();
  const remote = context.mocks.deferred<void>();
  context.mocks.api(chatThreadDraftContract.get, async ({ respond }) => {
    if (!chatSetupStarted.settled()) {
      chatSetupStarted.resolve();
    }
    await chatSetup.promise;
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(projectsContract.events, async ({ respond }) => {
    await remote.promise;
    return respond(200, {
      events: [
        {
          id: "30000000-0000-4000-8000-000000000073",
          seqId: 2,
          projectId: id,
          kind: "renamed",
          name: "Launch updated",
          createdAt: at,
        },
      ],
      hasMore: false,
    });
  });

  const page = await startPage({ context: reloadedContext, ...options });
  try {
    await page.content;
    await chatSetupStarted.promise;
    await waitFor(() => {
      expect(projectToggle("Launch")).toBeInTheDocument();
    });
    expect(threadLink(thread.id)).toBeInTheDocument();
    expect(chatSetup.settled()).toBeFalsy();
    expect(remote.settled()).toBeFalsy();

    remote.resolve();
    await screen.findByText("Launch updated");
    expect(chatSetup.settled()).toBeFalsy();
  } finally {
    if (!remote.settled()) {
      remote.resolve();
    }
    chatSetup.resolve();
    await page.ready;
  }
});

test("Projects stay visible when returning from a chat to its pinned Agent", async () => {
  const ordinary = continuityThread(111, 1, "Ordinary chat");
  const member = {
    ...continuityThread(111, 2, "Launch planning"),
    projectId: id,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 111,
    threads: [ordinary, member],
  });
  context.mocks.data.userPreferences({ pinnedAgentIds: [ordinary.agentId] });
  metadata();
  const refreshStarted = context.mocks.deferred<void>();
  const releaseRefresh = context.mocks.deferred<void>();
  let refreshing = false;
  context.mocks.api(projectsContract.events, async ({ respond }) => {
    if (!refreshing) {
      return respond(200, { events: [], hasMore: false });
    }
    if (!refreshStarted.settled()) {
      refreshStarted.resolve();
    }
    await releaseRefresh.promise;
    return respond(200, {
      events: [
        {
          id: "30000000-0000-4000-8000-000000000073",
          seqId: 2,
          projectId: id,
          kind: "renamed",
          name: "Launch updated",
          createdAt: at,
        },
      ],
      hasMore: false,
    });
  });
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
    sharedWorkerTestTransport: "message-port",
  });
  click(projectToggle("Launch"));
  expect(namedLink(projectRows(), "Launch planning")).toBeInTheDocument();
  const agent = await waitFor(() => {
    const link = document.querySelector(
      `[data-testid="pinned-agent-card"][href="/agents/${ordinary.agentId}/chat"]`,
    );
    if (!link) {
      throw new Error("Pinned Agent not found");
    }
    return link;
  });
  let projectsDisappeared = false;
  const observer = new MutationObserver(() => {
    if (!document.querySelector(`[data-project-row-id="${id}"]`)) {
      projectsDisappeared = true;
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    refreshing = true;
    click(agent);
    await refreshStarted.promise;
    expect(location.pathname).toBe(`/agents/${ordinary.agentId}/chat`);
    expect(namedLink(projectRows(), "Launch planning")).toBeInTheDocument();
    expect(projectsDisappeared).toBeFalsy();

    releaseRefresh.resolve();
    await screen.findByText("Launch updated");
    expect(namedLink(projectRows(), "Launch planning")).toBeInTheDocument();
    expect(projectsDisappeared).toBeFalsy();
  } finally {
    if (!releaseRefresh.settled()) {
      releaseRefresh.resolve();
    }
    observer.disconnect();
  }
});

test.each(["account", "workspace"] as const)(
  "Projects are cleared when the authenticated %s changes",
  async (scope) => {
    const ordinary = continuityThread(112, 1, "Ordinary chat");
    const workspace = installContinuityWorkspace(context, {
      caseId: 112,
      threads: [ordinary],
    });
    metadata();
    await setupPage({
      context,
      path: `/chats/${ordinary.id}`,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.Projects]: true },
    });
    expect(projectToggle("Launch")).toBeInTheDocument();

    const clerk = context.mocks.clerk();
    act(() => {
      if (scope === "account") {
        clerk.user(
          { id: "other-project-user", fullName: "Other User" },
          { id: "other-project-session", token: "other-token" },
        );
      } else {
        clerk.organization({
          activeOrg: { id: "other-project-org", name: "Other Workspace" },
          memberships: [{ id: "other-project-org" }],
        });
      }
      clerk.stateChanged();
    });
    await waitFor(() => {
      expect(screen.queryByText("Launch")).not.toBeInTheDocument();
    });
  },
);

test("Projects remember open and collapsed states after a page reload", async () => {
  const otherId = "30000000-0000-4000-8000-000000000072";
  const member = {
    ...continuityThread(108, 1, "Launch planning"),
    projectId: id,
  };
  const other = {
    ...continuityThread(108, 2, "Research notes"),
    projectId: otherId,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 108,
    threads: [member, other],
  });
  metadata([{ id: otherId, name: "Research" }]);
  const resetPage$ = resetSignal();
  const signal = context.store.set(resetPage$, context.signal);
  const options = {
    path: `/chats/${member.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  };
  await setupPage({ context: { ...context, signal }, ...options });
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  expect(projectToggle("Research", otherId)).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  click(projectToggle("Launch"));
  click(projectToggle("Research", otherId));
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  expect(namedLink(projectRows(otherId), "Research notes")).toBeInTheDocument();

  context.store.set(resetPage$);
  releasePageDom();
  await setupPage({ context: reloadedContext, ...options });

  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  expect(namedLink(projectRows(), "Launch planning")).toBeNull();
  expect(projectToggle("Research", otherId)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(namedLink(projectRows(otherId), "Research notes")).toBeInTheDocument();
});

test.each(["account", "workspace"] as const)(
  "Project expansion preferences stay separate for each %s",
  async (scope) => {
    const ordinary = continuityThread(109, 1, "Ordinary chat");
    const workspace = installContinuityWorkspace(context, {
      caseId: 109,
      threads: [ordinary],
    });
    metadata();
    const resetPage$ = resetSignal();
    const signal = context.store.set(resetPage$, context.signal);
    const options = {
      path: `/chats/${ordinary.id}`,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.Projects]: true },
    };
    await setupPage({ context: { ...context, signal }, ...options });
    click(projectToggle("Launch"));
    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");

    context.store.set(resetPage$);
    releasePageDom();
    const auth = workspace.pageOptions.auth;
    await setupPage({
      context: reloadedContext,
      ...options,
      auth: {
        ...auth,
        ...(scope === "account"
          ? { user: { ...auth.user, id: "user_other" } }
          : {
              organization: {
                activeOrg: { id: "org_other", name: "Other workspace" },
                memberships: [{ id: "org_other" }],
              },
            }),
      },
    });

    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
    click(projectToggle("Launch"));
    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  },
);

test.each(["not json", '{"invalid":"true"}'])(
  "Projects remain usable with invalid cached preferences: %s",
  async (value) => {
    const ordinary = continuityThread(110, 1, "Ordinary chat");
    const workspace = installContinuityWorkspace(context, {
      caseId: 110,
      threads: [ordinary],
    });
    metadata();
    const { auth } = workspace.pageOptions;
    context.store.set(
      localStorageSignals(
        `project-folder-expansion:${auth.organization?.activeOrg?.id}:${auth.user.id}`,
      ).set$,
      value,
    );
    await setupPage({
      context,
      path: `/chats/${ordinary.id}`,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.Projects]: true },
    });

    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
    click(projectToggle("Launch"));
    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
    click(projectToggle("Launch"));
    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  },
);

test("Projects show cross-Agent chats inline and follow the list filter without leaving the current conversation", async () => {
  const ordinary = continuityThread(90, 1, "Ordinary chat");
  const member = {
    ...continuityThread(90, 2, "Launch planning"),
    projectId: id,
  };
  const other = {
    ...continuityThread(90, 3, "Other Agent research"),
    projectId: id,
    agentId: "c7000000-0000-4000-a000-000000000009",
  };
  const archived = {
    ...continuityThread(90, 4, "Archived research"),
    projectId: id,
    archived: true,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 90,
    threads: [ordinary, member, other, archived],
  });
  metadata();
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: {
      [FeatureSwitchKey.Projects]: true,
    },
  });
  const user = userEvent.setup({ delay: null });
  await user.click(projectToggle("Launch"));
  expect(namedLink(projectRows(), "Launch planning")).toBeVisible();
  expect(namedLink(projectRows(), "Other Agent research")).toHaveAttribute(
    "href",
    expect.stringContaining("/chats/" + other.id),
  );
  expect(namedLink(projectRows(), "Ordinary chat")).toBeNull();
  expect(namedLink(projectRows(), "Archived research")).toBeNull();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  openChatListMenu();
  click(menuItemByText("Archived"));
  await waitFor(() => {
    expect(namedLink(projectRows(), "Archived research")).toBeVisible();
  });
  expect(namedLink(projectRows(), "Launch planning")).toBeNull();
  await user.click(projectToggle("Launch"));
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
});
function pressChatNavigation(direction: "ArrowUp" | "ArrowDown") {
  return userEvent
    .setup({ delay: null })
    .keyboard(`{Control>}{Shift>}{${direction}}{/Shift}{/Control}`);
}
function activeListItem() {
  return (
    document
      .querySelector('[data-testid="sidebar-chat-threads-virtual-list"]')
      ?.querySelector('[aria-current="page"]') ?? null
  );
}
async function setupProjectNavigation(
  caseId: number,
  path: string,
  extraProjects: readonly { id: string; name: string }[] = [],
) {
  // Project: A1, A, A2 (newest first); B stays outside it.
  const b = continuityThread(caseId, 1, "Thread B");
  const a2 = { ...continuityThread(caseId, 2, "Thread A2"), projectId: id };
  const a = { ...continuityThread(caseId, 3, "Thread A"), projectId: id };
  const a1 = { ...continuityThread(caseId, 4, "Thread A1"), projectId: id };
  const workspace = installContinuityWorkspace(context, {
    caseId,
    threads: [b, a2, a, a1],
  });
  // A Project page lists the default Agent's chats, so these belong to it.
  context.mocks.data.onboardingStatus({ defaultAgentId: b.agentId });
  metadata(extraProjects);
  await setupPage({
    context,
    path: path
      .replace(":b", b.id)
      .replace(":a1", a1.id)
      .replace(":a2", a2.id)
      .replace(":a", a.id),
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  return { a1, a, a2, b };
}

test("Chat navigation shortcuts move through expanded Projects and the chats outside them", async () => {
  const { a2, b } = await setupProjectNavigation(113, "/chats/:b");
  await userEvent.setup({ delay: null }).click(projectToggle("Launch"));
  expect(namedLink(projectRows(), "Thread A2")).toBeInTheDocument();
  (await screen.findByRole("textbox", { name: "Message" })).focus();

  // The first chat outside Projects continues upward into the Project above.
  await pressChatNavigation("ArrowUp");
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${a2.id}`);
  });
  expect(threadLink(a2.id)).toHaveAttribute("aria-current", "page");

  await pressChatNavigation("ArrowDown");
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${b.id}`);
  });
});

test("A folded Project keeps the open chat's place: up selects the Project and down passes the fold", async () => {
  const { a, b } = await setupProjectNavigation(114, "/chats/:a");
  // Opening a chat reveals its Project the first time.
  await waitFor(() => {
    expect(threadLink(a.id)).toHaveAttribute("aria-current", "page");
  });
  await userEvent.setup({ delay: null }).click(projectToggle("Launch"));
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  expect(location.pathname).toBe(`/chats/${a.id}`);
  expect(activeListItem()).toBeNull();
  (await screen.findByRole("textbox", { name: "Message" })).focus();

  await pressChatNavigation("ArrowDown");
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${b.id}`);
  });

  await pressChatNavigation("ArrowUp");
  await waitFor(() => {
    expect(location.pathname).toBe(`/projects/${id}`);
  });
  await waitFor(() => {
    expect(projectLink("Launch")).toHaveAttribute("aria-current", "page");
  });
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
});

test("Clicking a Project's name opens its page and unfolds its chats, then toggles them there", async () => {
  await setupProjectNavigation(223, "/chats/:b");
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  expect(namedLink(projectRows(), "Thread A2")).toBeNull();

  const user = userEvent.setup({ delay: null });
  await user.click(projectLink("Launch"));
  await waitFor(() => {
    expect(location.pathname).toBe(`/projects/${id}`);
  });
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  expect(namedLink(projectRows(), "Thread A2")).toBeInTheDocument();

  // On the Project's page, clicking its name again folds and unfolds it.
  await user.click(projectLink("Launch"));
  expect(location.pathname).toBe(`/projects/${id}`);
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  expect(namedLink(projectRows(), "Thread A2")).toBeNull();

  await user.click(projectLink("Launch"));
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  expect(namedLink(projectRows(), "Thread A2")).toBeInTheDocument();
});

test("Clicking a folded Project's name from one of its chats unfolds it", async () => {
  await setupProjectNavigation(225, "/chats/:a");
  const user = userEvent.setup({ delay: null });
  await user.click(projectToggle("Launch"));
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");

  await user.click(projectLink("Launch"));
  await waitFor(() => {
    expect(location.pathname).toBe(`/projects/${id}`);
  });
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
});

test("Opening a Project's name in a new tab leaves its chats folded", async () => {
  await setupProjectNavigation(224, "/chats/:b");
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(projectLink("Launch"), { ctrlKey: true });
  fireEvent.click(projectLink("Launch"), { metaKey: true });

  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  expect(namedLink(projectRows(), "Thread A2")).toBeNull();
});

test("A Project page moves down into its chats when unfolded and past them when folded", async () => {
  const { a1, b } = await setupProjectNavigation(115, `/projects/${id}`);
  await waitFor(() => {
    expect(projectLink("Launch")).toHaveAttribute("aria-current", "page");
  });
  // A Project page leaves the Project folded the way it was.
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");

  await pressChatNavigation("ArrowDown");
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${b.id}`);
  });
  await pressChatNavigation("ArrowUp");
  await waitFor(() => {
    expect(location.pathname).toBe(`/projects/${id}`);
  });

  await userEvent.setup({ delay: null }).click(projectToggle("Launch"));
  (await screen.findByRole("textbox", { name: "Message" })).focus();
  await pressChatNavigation("ArrowDown");
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${a1.id}`);
  });
  expect(threadLink(a1.id)).toHaveAttribute("aria-current", "page");
});
function pressProjectFold(direction: "ArrowLeft" | "ArrowRight") {
  return userEvent
    .setup({ delay: null })
    .keyboard(`{Control>}{Shift>}{${direction}}{/Shift}{/Control}`);
}

test("Project fold shortcuts fold and unfold the open chat's Project unless the composer holds text", async () => {
  const { a } = await setupProjectNavigation(116, "/chats/:a");
  await waitFor(() => {
    expect(threadLink(a.id)).toHaveAttribute("aria-current", "page");
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();

  await pressProjectFold("ArrowLeft");
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  expect(activeListItem()).toBeNull();
  expect(location.pathname).toBe(`/chats/${a.id}`);

  await pressProjectFold("ArrowRight");
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  expect(threadLink(a.id)).toHaveAttribute("aria-current", "page");

  // Typed text keeps the keys for selecting to the line edge.
  await userEvent.setup({ delay: null }).type(composer, "Draft");
  await pressProjectFold("ArrowLeft");
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  expect(composer).toHaveTextContent("Draft");
});

test("A Project page folds its own Project, and a chat outside Projects folds none", async () => {
  const { b } = await setupProjectNavigation(117, `/projects/${id}`);
  await waitFor(() => {
    expect(projectLink("Launch")).toHaveAttribute("aria-current", "page");
  });
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  (await screen.findByRole("textbox", { name: "Message" })).focus();

  await pressProjectFold("ArrowRight");
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  await pressProjectFold("ArrowLeft");
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");

  fireEvent.keyDown(document.body, { key: "?", code: "Slash", shiftKey: true });
  const dialog = (await screen.findByText("Keyboard Shortcuts")).closest(
    '[role="dialog"]',
  );
  expect(dialog).toHaveTextContent("Collapse Project");
  expect(dialog).toHaveTextContent("Expand Project");
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByText("Keyboard Shortcuts")).toBeNull();
  });

  await pressChatNavigation("ArrowDown");
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${b.id}`);
  });
  (await screen.findByRole("textbox", { name: "Message" })).focus();
  await pressProjectFold("ArrowRight");
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
});

test("A Project's menu folds it with the shortcut shown, and the keys act on the menu's Project", async () => {
  const campaignId = "30000000-0000-4000-8000-000000000072";
  const { a } = await setupProjectNavigation(118, "/chats/:a", [
    { id: campaignId, name: "Campaign" },
  ]);
  await waitFor(() => {
    expect(threadLink(a.id)).toHaveAttribute("aria-current", "page");
  });
  const user = userEvent.setup({ delay: null });

  await user.click(button("Options for Launch", projectRows()));
  const collapse = await findMenuItem("Collapse");
  expect(collapse).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+ArrowLeft Control+Shift+ArrowLeft",
  );
  expect(collapse.querySelector("kbd")).toHaveTextContent("←");
  await user.click(collapse);
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");

  await user.click(button("Options for Campaign", projectRows(campaignId)));
  const expand = await findMenuItem("Expand");
  expect(expand).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+ArrowRight Control+Shift+ArrowRight",
  );
  // The open menu's Project takes the keys, not the open chat's.
  await pressProjectFold("ArrowRight");
  expect(projectToggle("Campaign", campaignId)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
  await findMenuItem("Collapse");
});

test("ordinary lists hide assigned chats and @Project inserts captured identity without navigating", async () => {
  const ordinary = continuityThread(91, 1, "Ordinary chat");
  const member = {
    ...continuityThread(91, 2, "Launch planning"),
    projectId: id,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 91,
    threads: [ordinary, member],
  });
  metadata();
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await waitFor(() => {
    return expect(
      document.querySelector(`[data-sidebar-chat-thread-id="${ordinary.id}"]`),
    ).toBeVisible();
  });
  expect(
    document.querySelector(`[data-sidebar-chat-thread-id="${member.id}"]`),
  ).toBeNull();
  const input = await screen.findByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  await user.click(input);
  await user.type(input, "@Launch");
  const menu = await screen.findByTestId("chat-thread-suggestion-menu");
  const item = queryAllByRoleFast("button", menu).find((button) => {
    return button.textContent?.trim() === "Launch";
  });
  if (!item) {
    throw new Error("Project mention was not offered");
  }
  await user.click(item);
  expect(
    input.querySelector(`[data-project-mention="${id}"]`),
  ).toHaveTextContent("Launch");
  expect(location.pathname).toContain(ordinary.id);
});

test("creates, renames and deletes a Project through the shared dialogs", async () => {
  const confirmation = context.mocks.deferred<void>();
  const ordinary = continuityThread(92, 1, "Ordinary chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 92,
    threads: [ordinary],
  });
  metadata();
  const events: {
    id: string;
    seqId: number;
    projectId: string;
    kind: "created" | "renamed" | "deleted";
    name: string | null;
    createdAt: string;
  }[] = [];
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > query.sinceSeqId;
      }),
      hasMore: false,
    });
  });
  context.mocks.api(projectsContract.create, async ({ body, respond }) => {
    await confirmation.promise;
    events.push({
      id: body.eventId,
      projectId: body.id,
      seqId: 2,
      kind: "created",
      name: body.name,
      createdAt: at,
    });
    return respond(201, {
      id: body.id,
      name: body.name,
      createdAt: at,
      updatedAt: at,
    });
  });
  context.mocks.api(projectsContract.update, ({ params, body, respond }) => {
    events.push({
      id: body.eventId,
      projectId: params.id,
      seqId: 3,
      kind: "renamed",
      name: body.name,
      createdAt: at,
    });
    return respond(200, {
      id: params.id,
      name: body.name,
      createdAt: at,
      updatedAt: at,
    });
  });
  context.mocks.api(projectsContract.delete, ({ params, body, respond }) => {
    events.push({
      id: body.eventId,
      projectId: params.id,
      seqId: 4,
      kind: "deleted",
      name: null,
      createdAt: at,
    });
    return respond(204);
  });
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const user = userEvent.setup({ delay: null });
  await user.click(button("Create Project"));
  await user.type(
    await screen.findByRole("textbox", { name: "Project name" }),
    "Campaign",
  );
  await user.click(button("Save"));
  await waitFor(() => {
    return expect(button("Show or hide chats in Campaign")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(confirmation.settled()).toBeFalsy();
  confirmation.resolve();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  await user.click(button("Options for Campaign"));
  await user.click(await findMenuItem("Rename"));
  const input = await screen.findByRole("textbox", { name: "Project name" });
  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  await fill(input, "Campaign two");
  await user.click(button("Save"));
  await waitFor(() => {
    return expect(namedLink(document, "Campaign two")).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(button("Options for Campaign two")).toHaveFocus();
  });
  await user.click(button("Options for Campaign two"));
  await user.click(await findMenuItem("Delete"));
  const dialog = await screen.findByRole("dialog");
  await user.click(button("Delete Project", dialog));
  await waitFor(() => {
    return expect(
      queryAllByRoleFast("button").some((item) => {
        return item.textContent?.trim() === "Campaign two";
      }),
    ).toBeFalsy();
  });
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  await waitFor(() => {
    expect(button("Create Project")).toHaveFocus();
  });
});

test("Creating a Project from a chat moves it immediately and survives navigation", async () => {
  const confirmation = context.mocks.deferred<void>();
  const ordinary = continuityThread(113, 1, "Campaign planning");
  const other = continuityThread(113, 2, "Other conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 113,
    threads: [ordinary, other],
  });
  metadata();
  const events: ProjectEvent[] = [];
  const threadEvents: ChatThreadEvent[] = [];
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > query.sinceSeqId;
      }),
      hasMore: false,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: threadEvents.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  context.mocks.api(projectsContract.create, async ({ body, respond }) => {
    await confirmation.promise;
    events.push(
      {
        id: body.eventId,
        projectId: body.id,
        seqId: 2,
        kind: "created",
        name: body.name,
        createdAt: at,
      },
      {
        id: crypto.randomUUID(),
        projectId: body.id,
        seqId: 3,
        kind: "renamed",
        name: "Campaign confirmed",
        createdAt: at,
      },
    );
    threadEvents.push({
      id: body.eventId,
      seqId: 2,
      kind: "project_updated",
      chatThreadId: ordinary.id,
      agentId: ordinary.agentId,
      projectId: body.id,
      title: ordinary.title,
      selectedModel: ordinary.selectedModel,
      serviceTier: null,
      computerUseHostId: null,
      createdAt: at,
    });
    return respond(201, {
      id: body.id,
      name: body.name,
      createdAt: at,
      updatedAt: at,
    });
  });
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const user = userEvent.setup({ delay: null });
  const row = threadLink(ordinary.id).closest<HTMLElement>(
    "[data-sidebar-chat-thread-row-id]",
  );
  if (!row) {
    throw new Error("Chat row missing");
  }
  await user.click(within(row).getByTestId("chat-thread-menu-trigger"));
  await user.click(await findMenuItem("Move to Project"));
  await user.click(button("Create a Project from this chat"));
  await fill(
    await screen.findByRole("textbox", { name: "Project name" }),
    "Campaign",
  );
  await user.click(button("Save"));
  const groupProjectId = await waitFor(() => {
    const projectId = threadLink(ordinary.id).closest<HTMLElement>(
      "[data-project-row-id]",
    )?.dataset.projectRowId;
    if (!projectId) {
      throw new Error("Project not found");
    }
    return projectId;
  });
  expect(projectToggle("Campaign", groupProjectId)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await waitFor(() => {
    expect(threadLink(ordinary.id)).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(confirmation.settled()).toBeFalsy();
  const projectId = groupProjectId;
  if (!projectId) {
    throw new Error("Project identity missing");
  }

  await user.click(projectToggle("Campaign", groupProjectId));
  await user.click(threadLink(other.id));
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${other.id}`);
  });
  confirmation.resolve();
  await waitFor(() => {
    expect(projectToggle("Campaign confirmed", projectId)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
  await user.click(projectToggle("Campaign confirmed", projectId));
  await waitFor(() => {
    expect(
      namedLink(projectRows(projectId), "Campaign planning"),
    ).toBeInTheDocument();
  });
  expect(
    document.querySelectorAll(
      `[data-project-row-id="${projectId}"] [data-sidebar-chat-thread-id="${ordinary.id}"]`,
    ),
  ).toHaveLength(1);
});

test("A new Project accepts a new chat after its pending creation is confirmed", async () => {
  const confirmation = context.mocks.deferred<void>();
  const ordinary = continuityThread(114, 1, "Ordinary chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 114,
    threads: [ordinary],
  });
  metadata();
  const events: ProjectEvent[] = [];
  let projectId: string | undefined;
  let createdThread: ChatThreadSnapshotProjection | undefined;
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > query.sinceSeqId;
      }),
      hasMore: false,
    });
  });
  context.mocks.api(projectsContract.create, async ({ body, respond }) => {
    await confirmation.promise;
    projectId = body.id;
    events.push({
      id: body.eventId,
      projectId: body.id,
      seqId: 2,
      kind: "created",
      name: body.name,
      createdAt: at,
    });
    return respond(201, {
      id: body.id,
      name: body.name,
      createdAt: at,
      updatedAt: at,
    });
  });
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    if (!projectId || body.projectId !== projectId) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Project not found" },
      });
    }
    if (!body.clientThreadId) {
      throw new Error("Client chat identity missing");
    }
    createdThread = {
      ...continuityThread(114, 2, "New chat"),
      id: body.clientThreadId,
      projectId,
    };
    return respond(201, {
      id: createdThread.id,
      title: createdThread.title,
      createdAt: at,
      selectedModel: createdThread.selectedModel,
      serviceTier: null,
      projectId,
    });
  });
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    const thread = params.id === ordinary.id ? ordinary : createdThread;
    if (!thread) {
      throw new Error("Unknown chat");
    }
    return respond(200, {
      ...thread,
      modelSettings: thread.modelSettings ?? {},
      muted: thread.muted ?? false,
      cloudBrowserEnabled: false,
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const user = userEvent.setup({ delay: null });
  await user.click(button("Create Project"));
  await fill(
    await screen.findByRole("textbox", { name: "Project name" }),
    "Campaign",
  );
  await user.click(button("Save"));
  const groupProjectId = await waitFor(() => {
    const projectId = button(
      "Show or hide chats in Campaign",
    ).closest<HTMLElement>("[data-project-row-id]")?.dataset.projectRowId;
    if (!projectId) {
      throw new Error("Project not found");
    }
    return projectId;
  });
  await user.click(button("New chat", projectRows(groupProjectId)));
  await waitFor(() => {
    expect(button("New chat", projectRows(groupProjectId))).toBeDisabled();
  });
  expect(confirmation.settled()).toBeFalsy();
  confirmation.resolve();
  await waitFor(() => {
    expect(createdThread).toBeDefined();
    expect(location.pathname).toBe(`/chats/${createdThread?.id}`);
    expect(namedLink(projectRows(groupProjectId), "New chat")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

test("Thread menu searches and changes Project membership while preserving the open chat", async () => {
  const ordinary = continuityThread(93, 1, "Ordinary chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 93,
    threads: [ordinary],
  });
  const secondId = "30000000-0000-4000-8000-000000000072";
  metadata([{ id: secondId, name: "Research" }]);
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
    projectsContract.membership,
    ({ params, body, respond }) => {
      events.push({
        id: body.eventId,
        seqId: events.length + 2,
        kind: "project_updated",
        chatThreadId: params.id,
        agentId: ordinary.agentId,
        title: ordinary.title,
        projectId: body.projectId,
        selectedModel: ordinary.selectedModel,
        serviceTier: null,
        computerUseHostId: null,
        createdAt: at,
      });
      return respond(200, { threadId: params.id, projectId: body.projectId });
    },
  );
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const user = userEvent.setup({ delay: null });
  function rowMenu() {
    const row = document.querySelector<HTMLElement>(
      `[data-sidebar-chat-thread-row-id="${ordinary.id}"]`,
    );
    if (!row) {
      throw new Error("Thread row missing");
    }
    return within(row).getByTestId("chat-thread-menu-trigger");
  }
  await user.click(rowMenu());
  await user.click(await findMenuItem("Move to Project"));
  await screen.findByRole("textbox", { name: "Search projects…" });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(
      document.querySelector(`[data-sidebar-chat-thread-id="${ordinary.id}"]`),
    ).toHaveFocus();
  });
  await user.click(rowMenu());
  await user.click(await findMenuItem("Move to Project"));
  const search = await screen.findByRole("textbox", {
    name: "Search projects…",
  });
  await user.type(search, "missing");
  await expect(
    screen.findByText("No projects found"),
  ).resolves.toBeInTheDocument();
  await fill(search, "laun");
  await user.click(
    button("Launch", await screen.findByRole("dialog", { name: "Move chat" })),
  );
  await waitFor(() => {
    return expect(
      namedLink(projectRows(), "Ordinary chat"),
    ).toBeInTheDocument();
  });
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  await waitFor(() => {
    return expect(
      screen.queryByRole("textbox", { name: "Search projects…" }),
    ).not.toBeInTheDocument();
  });
  await user.click(rowMenu());
  await user.click(await findMenuItem("Move to Project"));
  await user.click(
    button(
      "Research",
      await screen.findByRole("dialog", { name: "Move chat" }),
    ),
  );
  await waitFor(() => {
    return expect(
      namedLink(projectRows(secondId), "Ordinary chat"),
    ).toBeInTheDocument();
  });
  expect(namedLink(projectRows(), "Ordinary chat")).toBeNull();
  await user.click(rowMenu());
  await user.click(await findMenuItem("Move to Project"));
  await user.click(
    button(
      "Remove from Project",
      await screen.findByRole("dialog", { name: "Move chat" }),
    ),
  );
  await waitFor(() => {
    return expect(namedLink(projectRows(), "Ordinary chat")).toBeNull();
  });
  expect(
    document.querySelector(`[data-sidebar-chat-thread-id="${ordinary.id}"]`),
  ).toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
});

test("A rejected Project move does not replace a later confirmed move", async () => {
  const ordinary = continuityThread(124, 1, "Ordinary chat");
  const reference = continuityThread(124, 2, "Reference notes");
  const workspace = installContinuityWorkspace(context, {
    caseId: 124,
    threads: [ordinary, reference],
  });
  const secondId = "30000000-0000-4000-8000-000000000072";
  metadata([{ id: secondId, name: "Research" }]);
  const events: ChatThreadEvent[] = [];
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  function membershipEvent(
    thread: ChatThreadSnapshotProjection,
    eventId: string,
    projectId: string | null,
  ): ChatThreadEvent {
    return {
      id: eventId,
      seqId: events.length + 2,
      kind: "project_updated",
      chatThreadId: thread.id,
      agentId: thread.agentId,
      title: thread.title,
      projectId,
      selectedModel: thread.selectedModel,
      serviceTier: null,
      computerUseHostId: null,
      createdAt: at,
    };
  }
  let rejected = false;
  context.mocks.api(
    projectsContract.membership,
    ({ params, body, respond }) => {
      if (!rejected) {
        rejected = true;
        return respond(409, {
          error: { code: "CONFLICT", message: "Project state changed" },
        });
      }
      events.push(membershipEvent(ordinary, body.eventId, body.projectId));
      // Another device files a second chat, marking when the catch-up lands.
      events.push(membershipEvent(reference, crypto.randomUUID(), secondId));
      return respond(200, { threadId: params.id, projectId: body.projectId });
    },
  );
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const user = userEvent.setup({ delay: null });
  async function moveTo(project: string) {
    const row = document.querySelector<HTMLElement>(
      `[data-sidebar-chat-thread-row-id="${ordinary.id}"]`,
    );
    if (!row) {
      throw new Error("Thread row missing");
    }
    await user.click(within(row).getByTestId("chat-thread-menu-trigger"));
    await user.click(await findMenuItem("Move to Project"));
    await user.click(
      button(project, await screen.findByRole("dialog", { name: "Move chat" })),
    );
  }
  await moveTo("Launch");
  await expect(
    screen.findByText("Project state changed"),
  ).resolves.toBeInTheDocument();

  await moveTo("Research");

  await waitFor(() => {
    return expect(
      namedLink(projectRows(secondId), "Reference notes"),
    ).toBeInTheDocument();
  });
  expect(namedLink(projectRows(secondId), "Ordinary chat")).toBeInTheDocument();
});

test("Dropping over an existing Project chat moves immediately while the request is pending", async () => {
  const confirmation = context.mocks.deferred<void>();
  const canonicalRead = context.mocks.deferred<void>();
  const ordinary = continuityThread(101, 1, "Drag me into Launch");
  const member = {
    ...continuityThread(101, 2, "Launch planning"),
    projectId: id,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 101,
    threads: [ordinary, member],
  });
  metadata();
  const events: ChatThreadEvent[] = [];
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    if (events.length > 0) {
      canonicalRead.resolve();
    }
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  context.mocks.api(
    projectsContract.membership,
    async ({ params, body, respond }) => {
      await confirmation.promise;
      events.push({
        id: body.eventId,
        seqId: 2,
        kind: "project_updated",
        chatThreadId: params.id,
        agentId: ordinary.agentId,
        title: ordinary.title,
        projectId: body.projectId,
        selectedModel: ordinary.selectedModel,
        serviceTier: null,
        computerUseHostId: null,
        createdAt: at,
      });
      return respond(200, { threadId: params.id, projectId: body.projectId });
    },
  );
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  click(projectToggle("Launch"));
  const source = threadLink(ordinary.id);
  const target = threadLink(member.id);
  const dataTransfer = createDataTransferStub({ "text/uri-list": source.href });
  fireEvent.dragStart(source, { dataTransfer });
  expect(dataTransfer.getData("text/uri-list")).toBe("");
  fireEvent.dragOver(target, { dataTransfer, clientX: 160, clientY: 160 });
  await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
    "Move to Launch",
  );
  expect(projectRow()).toHaveAttribute("data-project-drop-target");
  // Moving between children must not clear the enclosing Project's hover.
  fireEvent(
    target,
    new MouseEvent("dragleave", {
      bubbles: true,
      relatedTarget: projectToggle("Launch"),
    }),
  );
  expect(screen.getByRole("tooltip")).toHaveTextContent("Move to Launch");
  fireEvent.drop(target, { dataTransfer });
  await waitFor(() => {
    expect(namedLink(projectRows(), "Drag me into Launch")).toBeInTheDocument();
  });
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  confirmation.resolve();
  await canonicalRead.promise;
  expect(namedLink(projectRows(), "Drag me into Launch")).toBeInTheDocument();
});

test.each(["chat row", "empty list space"] as const)(
  "Dropping a Project chat onto the outer %s removes it while preserving the open chat",
  async (destination) => {
    const confirmation = context.mocks.deferred<void>();
    const canonicalRead = context.mocks.deferred<void>();
    const member = {
      ...continuityThread(125, 1, "Launch planning"),
      projectId: id,
    };
    const ordinary = continuityThread(125, 2, "Ordinary chat");
    const workspace = installContinuityWorkspace(context, {
      caseId: 125,
      threads: destination === "chat row" ? [member, ordinary] : [member],
    });
    metadata();
    const events: ChatThreadEvent[] = [];
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      if (events.length > 0) {
        canonicalRead.resolve();
      }
      return respond(200, {
        events: events.filter((event) => {
          return event.seqId > (query.sinceSeqId ?? 0);
        }),
        hasMore: false,
      });
    });
    context.mocks.api(
      projectsContract.membership,
      async ({ params, body, respond }) => {
        await confirmation.promise;
        events.push({
          id: body.eventId,
          seqId: 2,
          kind: "project_updated",
          chatThreadId: params.id,
          agentId: member.agentId,
          title: member.title,
          projectId: body.projectId,
          selectedModel: member.selectedModel,
          serviceTier: null,
          computerUseHostId: null,
          createdAt: at,
        });
        return respond(200, { threadId: params.id, projectId: body.projectId });
      },
    );
    await setupPage({
      context,
      path: `/chats/${member.id}`,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.Projects]: true },
    });
    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
    const target =
      destination === "chat row"
        ? threadLink(ordinary.id)
        : screen.getByTestId("sidebar-scroll-area");
    const dataTransfer = createDataTransferStub();
    fireEvent.dragStart(threadLink(member.id), { dataTransfer });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.dragOver(target, { dataTransfer, clientX: 160, clientY: 240 });
    await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
      "Remove from Project",
    );
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => {
      expect(threadLink(member.id).closest("[data-project-row-id]")).toBeNull();
    });
    expect(namedLink(projectRows(), "Launch planning")).toBeNull();
    expect(location.pathname).toBe(`/chats/${member.id}`);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    confirmation.resolve();
    await canonicalRead.promise;
    expect(threadLink(member.id).closest("[data-project-row-id]")).toBeNull();
  },
);

test("A cross-Agent Project chat can be dragged onto another collapsed Project", async () => {
  const secondId = "30000000-0000-4000-8000-000000000072";
  const ordinary = continuityThread(102, 1, "Keep this chat open");
  const member = {
    ...continuityThread(102, 2, "Cross-Agent research"),
    projectId: id,
    agentId: "c7000000-0000-4000-a000-000000000009",
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 102,
    threads: [ordinary, member],
  });
  metadata([{ id: secondId, name: "Research" }]);
  context.mocks.api(
    projectsContract.membership,
    ({ params, body, respond }) => {
      return respond(200, { threadId: params.id, projectId: body.projectId });
    },
  );
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  click(projectToggle("Launch"));
  expect(projectToggle("Research", secondId)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const dataTransfer = createDataTransferStub();
  fireEvent.dragStart(threadLink(member.id), { dataTransfer });
  fireEvent.dragOver(projectRow(secondId), { dataTransfer });
  await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
    "Move to Research",
  );
  fireEvent.drop(projectRow(secondId), { dataTransfer });
  await waitFor(() => {
    expect(
      namedLink(projectRows(secondId), "Cross-Agent research"),
    ).toBeInTheDocument();
  });
  expect(projectToggle("Research", secondId)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    namedLink(projectRows(), "Cross-Agent research"),
  ).not.toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
});

test("Escape cancels a Project drag, and unrelated drags or the current Project are not accepted", async () => {
  const ordinary = continuityThread(103, 1, "Ordinary chat");
  const member = {
    ...continuityThread(103, 2, "Launch planning"),
    projectId: id,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 103,
    threads: [ordinary, member],
  });
  metadata();
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  click(projectToggle("Launch"));
  const dataTransfer = createDataTransferStub();
  fireEvent.dragStart(threadLink(ordinary.id), { dataTransfer });
  fireEvent.dragOver(projectRow(), { dataTransfer });
  await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
    "Move to Launch",
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(projectRow()).not.toHaveAttribute("data-project-drop-target");
  fireEvent.drop(projectRow(), { dataTransfer });
  expect(threadLink(ordinary.id).closest("[data-project-row-id]")).toBeNull();

  const ownProjectTransfer = createDataTransferStub();
  fireEvent.dragStart(threadLink(member.id), {
    dataTransfer: ownProjectTransfer,
  });
  expect(
    fireEvent.dragOver(projectRow(), { dataTransfer: ownProjectTransfer }),
  ).toBeTruthy();
  fireEvent.dragEnd(threadLink(member.id), {
    dataTransfer: ownProjectTransfer,
  });
  const externalTransfer = createDataTransferStub({
    "text/uri-list": "https://example.com",
  });
  expect(
    fireEvent.dragOver(projectRow(), { dataTransfer: externalTransfer }),
  ).toBeTruthy();
  expect(
    fireEvent.drop(projectRow(), { dataTransfer: externalTransfer }),
  ).toBeTruthy();
  expect(namedLink(projectRows(), "Launch planning")).toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
});

test("A failed drag move shows an error beside its destination", async () => {
  const ordinary = continuityThread(104, 1, "Ordinary chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 104,
    threads: [ordinary],
  });
  metadata();
  context.mocks.api(projectsContract.membership, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Project access denied" },
    });
  });
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const dataTransfer = createDataTransferStub();
  fireEvent.dragStart(threadLink(ordinary.id), { dataTransfer });
  fireEvent.dragOver(projectRow(), { dataTransfer });
  fireEvent.drop(projectRow(), { dataTransfer });
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Could not move chat",
  );
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
});

test("Project deep links open the Project page with its composer", async () => {
  const member = {
    ...continuityThread(94, 1, "Launch planning"),
    projectId: id,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 94,
    threads: [member],
  });
  metadata();
  await setupPage({
    context,
    path: `/projects/${id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  // The page keeps Okou's greeting; the composer names the Project.
  await waitFor(() => {
    expect(projectChip("Launch")).toBeInTheDocument();
  });
  expect(screen.getByTestId("chat-greeting")).toBeInTheDocument();
  expect(location.pathname).toBe(`/projects/${id}`);
  expect(projectLink("Launch")).toHaveAttribute("aria-current", "page");
  expect(projectLink("Launch")).toHaveAttribute("href", `/projects/${id}`);
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
});
test("A message sent from the Project page starts its chat inside the Project", async () => {
  const ordinary = continuityThread(116, 1, "Thread B");
  const workspace = installContinuityWorkspace(context, {
    caseId: 116,
    threads: [ordinary],
  });
  context.mocks.data.onboardingStatus({ defaultAgentId: ordinary.agentId });
  metadata();
  const created: {
    threadId?: string;
    agentId?: string;
    projectId?: string | null;
  } = {};
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    created.threadId = body.clientThreadId;
    created.agentId = body.agentId;
    created.projectId = body.projectId;
    return respond(201, {
      id: body.clientThreadId ?? crypto.randomUUID(),
      title: null,
      createdAt: at,
      selectedModel: body.model ?? null,
      serviceTier: null,
      projectId: body.projectId ?? null,
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    return respond(201, {
      threadId: body.threadId ?? crypto.randomUUID(),
      createdAt: at,
    });
  });
  await setupPage({
    context,
    path: `/projects/${id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await waitFor(() => {
    expect(projectChip("Launch")).toBeInTheDocument();
  });

  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Plan the launch",
  );
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));

  // The Project page composes with the default Agent inside its Project.
  await waitFor(() => {
    expect(created.threadId).toBeDefined();
  });
  expect(created).toMatchObject({
    agentId: ordinary.agentId,
    projectId: id,
  });
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${created.threadId}`);
  });
  await waitFor(() => {
    expect(
      document.querySelector(
        `[data-project-row-id="${id}"] [data-sidebar-chat-thread-id="${created.threadId}"]`,
      ),
    ).toHaveAttribute("aria-current", "page");
  });
});

test("The composer's + menu starts a new chat in a Project and keeps the message", async () => {
  const ordinary = continuityThread(117, 1, "Thread B");
  const workspace = installContinuityWorkspace(context, {
    caseId: 117,
    threads: [ordinary],
  });
  context.mocks.data.onboardingStatus({ defaultAgentId: ordinary.agentId });
  metadata([{ id: campaignId, name: "Campaign" }]);
  const created: { threadId?: string; projectId?: string | null } = {};
  mockThreadCreation(created);
  await setupPage({
    context,
    path: `/agents/${ordinary.agentId}/chat`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Plan the launch",
  );
  // Without a Project the toolbar carries no chip; the + menu offers one.
  expect(queryProjectChip("Launch")).toBeNull();
  const user = userEvent.setup({ delay: null });
  const menu = await openComposerProjectMenu();
  expect(menuLabels(menu)).toStrictEqual([
    "Attach",
    "Project",
    "Template",
    "Import skills",
  ]);
  await user.click(await findMenuItem("Project"));
  const submenu = await screen.findByRole("menu", { name: "Project" });
  expect(menuLabels(submenu)).toStrictEqual([
    "New Project",
    "Launch",
    "Campaign",
  ]);
  click(await findMenuItem("Launch"));

  // Choosing a Project opens its page with the same message.
  await waitFor(() => {
    expect(location.pathname).toBe(`/projects/${id}`);
  });
  await waitFor(() => {
    expect(projectChip("Launch")).toBeInTheDocument();
  });
  expect(projectLink("Launch")).toHaveAttribute("aria-current", "page");
  expect(
    screen.getByRole("textbox", { name: "Message" }).textContent,
  ).toContain("Plan the launch");

  // The current Project is marked, and switching moves to the other one.
  await openComposerProjectMenu();
  await user.click(await findMenuItem("Project"));
  const current = await findMenuItem("Launch");
  expect(current).toHaveAttribute("aria-disabled", "true");
  click(await findMenuItem("Campaign"));
  await waitFor(() => {
    expect(location.pathname).toBe(`/projects/${campaignId}`);
  });
  await waitFor(() => {
    expect(projectChip("Campaign")).toBeInTheDocument();
  });

  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(created.threadId).toBeDefined();
  });
  expect(created.projectId).toBe(campaignId);
});

test("Removing the Project chip returns the message to a chat outside any Project", async () => {
  const ordinary = continuityThread(118, 1, "Thread B");
  const workspace = installContinuityWorkspace(context, {
    caseId: 118,
    threads: [ordinary],
  });
  context.mocks.data.onboardingStatus({ defaultAgentId: ordinary.agentId });
  metadata();
  const created: { threadId?: string; projectId?: string | null } = {};
  mockThreadCreation(created);
  await setupPage({
    context,
    path: `/projects/${id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Outside the launch",
  );
  await waitFor(() => {
    expect(projectChip("Launch")).toBeInTheDocument();
  });
  click(projectChip("Launch"));

  await waitFor(() => {
    expect(location.pathname).toBe(`/agents/${ordinary.agentId}/chat`);
  });
  await waitFor(() => {
    expect(
      screen.getByRole("textbox", { name: "Message" }).textContent,
    ).toContain("Outside the launch");
  });
  expect(queryProjectChip("Launch")).toBeNull();
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(created.threadId).toBeDefined();
  });
  expect(created.projectId).toBeNull();
});

test("A Project named from the composer's + menu opens with the message and accepts it once created", async () => {
  const confirmation = context.mocks.deferred<void>();
  const ordinary = continuityThread(119, 1, "Thread B");
  const workspace = installContinuityWorkspace(context, {
    caseId: 119,
    threads: [ordinary],
  });
  context.mocks.data.onboardingStatus({ defaultAgentId: ordinary.agentId });
  metadata();
  const events: ProjectEvent[] = [];
  let confirmedProjectId: string | undefined;
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > query.sinceSeqId;
      }),
      hasMore: false,
    });
  });
  context.mocks.api(projectsContract.create, async ({ body, respond }) => {
    await confirmation.promise;
    confirmedProjectId = body.id;
    events.push({
      id: body.eventId,
      projectId: body.id,
      seqId: 2,
      kind: "created",
      name: body.name,
      createdAt: at,
    });
    return respond(201, {
      id: body.id,
      name: body.name,
      createdAt: at,
      updatedAt: at,
    });
  });
  const created: { threadId?: string; projectId?: string | null } = {};
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    // The server knows a Project only once its creation is confirmed.
    if (!confirmedProjectId || body.projectId !== confirmedProjectId) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Project not found" },
      });
    }
    created.threadId = body.clientThreadId;
    created.projectId = body.projectId;
    return respond(201, {
      id: body.clientThreadId ?? crypto.randomUUID(),
      title: null,
      createdAt: at,
      selectedModel: body.model ?? null,
      serviceTier: null,
      projectId: body.projectId,
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    return respond(201, {
      threadId: body.threadId ?? crypto.randomUUID(),
      createdAt: at,
    });
  });
  await setupPage({
    context,
    path: `/agents/${ordinary.agentId}/chat`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Kick off the campaign",
  );
  const user = userEvent.setup({ delay: null });
  await openComposerProjectMenu();
  await user.click(await findMenuItem("Project"));
  click(await findMenuItem("New Project"));
  await fill(
    await screen.findByRole("textbox", { name: "Project name" }),
    "Campaign",
  );
  await user.click(button("Save"));

  // The new Project's page opens before the server confirms the Project.
  await waitFor(() => {
    expect(projectChip("Campaign")).toBeInTheDocument();
  });
  const projectId = location.pathname.replace("/projects/", "");
  expect(location.pathname).toBe(`/projects/${projectId}`);
  expect(
    screen.getByRole("textbox", { name: "Message" }).textContent,
  ).toContain("Kick off the campaign");

  // Until the server has the Project, the message cannot start a chat in it.
  // Opening the + menu again lets the new page's composer settle first.
  const menu = await openComposerProjectMenu();
  expect(menuLabels(menu)).toContain("Project");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
  });
  expect(button("Send")).toBeDisabled();
  expect(confirmation.settled()).toBeFalsy();

  confirmation.resolve();
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${created.threadId}`);
  });
  expect(created.projectId).toBe(projectId);
});

test("Without Projects the new chat's + menu and toolbar stay as they were", async () => {
  const ordinary = continuityThread(120, 1, "Thread B");
  const workspace = installContinuityWorkspace(context, {
    caseId: 120,
    threads: [ordinary],
  });
  context.mocks.data.onboardingStatus({ defaultAgentId: ordinary.agentId });
  metadata();
  await setupPage({
    context,
    path: `/agents/${ordinary.agentId}/chat`,
    ...workspace.pageOptions,
  });
  await screen.findByRole("textbox", { name: "Message" });
  const menu = await openComposerProjectMenu();
  expect(menuLabels(menu)).toStrictEqual([
    "Attach",
    "Template",
    "Import skills",
  ]);
});

test("Project new chat opens before confirmation with the default Agent", async () => {
  const confirmation = context.mocks.deferred<void>();
  const persisted = context.mocks.deferred<void>();
  const ordinary = continuityThread(95, 1, "Ordinary chat");
  const other = {
    ...continuityThread(95, 2, "Other Agent research"),
    projectId: id,
    agentId: "c7000000-0000-4000-a000-000000000009",
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 95,
    threads: [ordinary, other],
  });
  metadata();
  const threads = new Map<string, ChatThreadSnapshotProjection>([
    [ordinary.id, ordinary],
    [other.id, other],
  ]);
  const events: ChatThreadEvent[] = [];
  let createdId: string | undefined;
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    const thread = threads.get(params.id);
    if (!thread) {
      throw new Error("Unknown chat");
    }
    return respond(200, {
      ...thread,
      modelSettings: thread.modelSettings ?? {},
      muted: thread.muted ?? false,
      cloudBrowserEnabled: false,
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    if (!body.clientThreadId) {
      throw new Error("Client chat identity missing");
    }
    // Projects compose with the workspace's default Agent from the
    // onboarding status, whichever Agent's chat was open.
    expect(body.agentId).toBe("c0000000-0000-4000-a000-000000000001");
    expect(body.projectId).toBe(id);
    createdId = body.clientThreadId;
    await confirmation.promise;
    const thread = {
      ...continuityThread(95, 3, "New Project chat"),
      id: body.clientThreadId,
      agentId: body.agentId,
      projectId: body.projectId ?? null,
    };
    threads.set(thread.id, thread);
    events.push({
      id: body.eventId ?? crypto.randomUUID(),
      seqId: 2,
      kind: "created",
      chatThreadId: thread.id,
      agentId: thread.agentId,
      projectId: thread.projectId,
      title: thread.title,
      selectedModel: thread.selectedModel,
      serviceTier: null,
      computerUseHostId: null,
      createdAt: at,
    });
    persisted.resolve();
    return respond(201, {
      id: thread.id,
      title: thread.title,
      createdAt: at,
      selectedModel: thread.selectedModel,
      serviceTier: null,
      projectId: thread.projectId,
    });
  });
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const user = userEvent.setup({ delay: null });
  await user.click(projectToggle("Launch"));
  const link = namedLink(projectRows(), "Other Agent research");
  if (!link) {
    throw new Error("Member chat missing");
  }
  expect(link).toHaveAttribute("href", `/chats/${other.id}`);
  await user.click(link);
  await waitFor(() => {
    return expect(location.pathname).toBe(`/chats/${other.id}`);
  });
  await user.click(button("New chat", projectRows()));
  await waitFor(() => {
    expect(namedLink(projectRows(), "New chat")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(createdId).toBeDefined();
    expect(location.pathname).toBe(`/chats/${createdId}`);
  });
  expect(confirmation.settled()).toBeFalsy();
  confirmation.resolve();
  await persisted.promise;
  context.mocks.ably.trigger("threadListChanged");
  await waitFor(() => {
    return expect(namedLink(projectRows(), "New Project chat")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(location.pathname).toBe(`/chats/${createdId}`);
  expect(
    document.querySelectorAll(
      `[data-project-row-id="${id}"] [data-sidebar-chat-thread-id="${createdId}"]`,
    ),
  ).toHaveLength(1);
});

test("Project rename closes immediately and yields to persisted events", async () => {
  const confirmation = context.mocks.deferred<void>();
  const ordinary = continuityThread(98, 1, "Ordinary chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 98,
    threads: [ordinary],
  });
  metadata();
  const events: {
    id: string;
    seqId: number;
    projectId: string;
    kind: "renamed";
    name: string;
    createdAt: string;
  }[] = [];
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > query.sinceSeqId;
      }),
      hasMore: false,
    });
  });
  context.mocks.api(projectsContract.update, async ({ body, respond }) => {
    await confirmation.promise;
    events.push(
      {
        id: body.eventId,
        seqId: 2,
        projectId: id,
        kind: "renamed",
        name: body.name,
        createdAt: at,
      },
      {
        id: crypto.randomUUID(),
        seqId: 3,
        projectId: id,
        kind: "renamed",
        name: "Launch confirmed",
        createdAt: at,
      },
    );
    return respond(200, {
      id,
      name: body.name,
      createdAt: at,
      updatedAt: at,
    });
  });
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  click(button("Options for Launch", projectRows()));
  click(await findMenuItem("Rename"));
  await fill(
    await screen.findByRole("textbox", { name: "Project name" }),
    "Launch renamed",
  );
  click(button("Save"));
  await waitFor(() => {
    expect(projectToggle("Launch renamed")).toBeInTheDocument();
    expect(button("Options for Launch renamed", projectRows())).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(confirmation.settled()).toBeFalsy();
  confirmation.resolve();
  await waitFor(() => {
    expect(projectToggle("Launch confirmed")).toBeInTheDocument();
  });
});

test.each([
  {
    name: "join",
    initialProjectId: null,
    projectId: id,
    target: "Launch",
    mobile: false,
  },
  {
    name: "move",
    initialProjectId: id,
    projectId: "30000000-0000-4000-8000-000000000072",
    target: "Research",
    mobile: false,
  },
  {
    name: "leave",
    initialProjectId: id,
    projectId: null,
    target: "Remove from Project",
    mobile: false,
  },
  {
    name: "join on PWA",
    initialProjectId: null,
    projectId: id,
    target: "Launch",
    mobile: true,
  },
])(
  "Project membership $name updates before confirmation",
  async ({ initialProjectId, projectId, target, mobile }) => {
    if (mobile) {
      context.mocks.browser.matchMedia(false);
    }
    const confirmation = context.mocks.deferred<void>();
    const thread = {
      ...continuityThread(99, 1, "Planning chat"),
      projectId: initialProjectId,
    };
    const initialPath = mobile
      ? `/agents/${thread.agentId}/chat`
      : `/chats/${thread.id}`;
    const workspace = installContinuityWorkspace(context, {
      caseId: 99,
      threads: [thread],
    });
    metadata([
      { id: "30000000-0000-4000-8000-000000000072", name: "Research" },
    ]);
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
      projectsContract.membership,
      async ({ params, body, respond }) => {
        await confirmation.promise;
        const committed: ChatThreadEvent = {
          id: body.eventId,
          seqId: 2,
          kind: "project_updated",
          chatThreadId: params.id,
          agentId: thread.agentId,
          projectId: body.projectId,
          title: thread.title,
          selectedModel: thread.selectedModel,
          serviceTier: null,
          computerUseHostId: null,
          createdAt: at,
        };
        events.push(committed, {
          ...committed,
          id: crypto.randomUUID(),
          seqId: 3,
          projectId: projectId === null ? id : null,
        });
        return respond(200, { threadId: params.id, projectId: body.projectId });
      },
    );
    await setupPage({
      context,
      path: initialPath,
      ...workspace.pageOptions,
      featureSwitches: {
        [FeatureSwitchKey.Projects]: true,
      },
    });
    const row = await waitFor(() => {
      const candidate = document.querySelector<HTMLElement>(
        `[data-sidebar-chat-thread-row-id="${thread.id}"]`,
      );
      if (!candidate) {
        throw new Error("Chat row missing");
      }
      return candidate;
    });
    const user = userEvent.setup({ delay: null });
    await user.click(within(row).getByTestId("chat-thread-menu-trigger"));
    await user.click(await findMenuItem("Move to Project"));
    await user.click(
      button(target, await screen.findByRole("dialog", { name: "Move chat" })),
    );
    await waitFor(() => {
      const link = projectId
        ? namedLink(projectRows(projectId), thread.title!)
        : document.querySelector(
            `[data-sidebar-chat-thread-id="${thread.id}"]`,
          );
      expect(link).toHaveFocus();
    });
    expect(
      screen.queryByRole("dialog", { name: "Move chat" }),
    ).not.toBeInTheDocument();
    expect(location.pathname).toBe(initialPath);
    expect(confirmation.settled()).toBeFalsy();
    confirmation.resolve();
    await waitFor(() => {
      const link =
        projectId === null
          ? namedLink(projectRows(), "Planning chat")
          : document.querySelector(
              `[data-sidebar-chat-thread-id="${thread.id}"]`,
            );
      expect(link).toHaveTextContent("Planning chat");
      expect(
        link?.closest<HTMLElement>("[data-project-row-id]")?.dataset
          .projectRowId ?? null,
      ).toBe(projectId === null ? id : null);
    });
  },
);

test("Deleting another Agent's Project chat removes it before confirmation", async () => {
  const confirmation = context.mocks.deferred<void>();
  const ordinary = continuityThread(100, 1, "Current chat");
  const member = {
    ...continuityThread(100, 2, "Project research"),
    agentId: "c7000000-0000-4000-a000-000000000009",
    projectId: id,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 100,
    threads: [ordinary, member],
  });
  metadata();
  context.mocks.api(chatThreadByIdContract.delete, async ({ respond }) => {
    await confirmation.promise;
    return respond(204);
  });
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  click(projectToggle("Launch"));
  const row = document.querySelector<HTMLElement>(
    `[data-sidebar-chat-thread-row-id="${member.id}"]`,
  );
  if (!row) {
    throw new Error("Project chat row missing");
  }
  click(within(row).getByTestId("chat-thread-menu-trigger"));
  click(await findMenuItem("Delete chat"));
  click(
    button(
      "Delete",
      await screen.findByRole("dialog", { name: "Delete chat?" }),
    ),
  );
  await expect(
    screen.findByText("No chats here yet"),
  ).resolves.toBeInTheDocument();
  expect(namedLink(projectRows(), "Project research")).toBeNull();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  expect(confirmation.settled()).toBeFalsy();
  confirmation.resolve();
});

test("PWA uses the same Projects and a bottom sheet for Thread membership", async () => {
  context.mocks.browser.matchMedia(false);
  const ordinary = continuityThread(96, 1, "Ordinary chat");
  const member = {
    ...continuityThread(96, 2, "Launch planning"),
    projectId: id,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 96,
    threads: [ordinary, member],
  });
  metadata();
  await setupPage({
    context,
    path: `/agents/${ordinary.agentId}/chat`,
    ...workspace.pageOptions,
    featureSwitches: {
      [FeatureSwitchKey.Projects]: true,
    },
  });
  const user = userEvent.setup({ delay: null });
  await waitFor(() => {
    return expect(projectToggle("Launch")).toBeInTheDocument();
  });
  await user.click(projectToggle("Launch"));
  const row = document.querySelector<HTMLElement>(
    `[data-sidebar-chat-thread-row-id="${member.id}"]`,
  );
  if (!row) {
    throw new Error("Member chat missing");
  }
  await user.click(within(row).getByTestId("chat-thread-menu-trigger"));
  await user.click(await findMenuItem("Move to Project"));
  const sheet = await screen.findByRole("dialog", {
    name: "Move chat",
  });
  expect(sheet).toHaveAttribute("data-slot", "drawer-popup");
  expect(
    within(sheet).getByRole("textbox", { name: "Search projects…" }),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Move chat" }),
    ).not.toBeInTheDocument();
  });
  const link = namedLink(projectRows(), "Launch planning");
  if (!link) {
    throw new Error("Member link missing");
  }
  await user.click(link);
  await waitFor(() => {
    return expect(location.pathname).toBe(`/chats/${member.id}`);
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
});

test("A Project mention reveals a folded chat sidebar and keeps the current conversation", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  const ordinary = continuityThread(97, 1, "Current conversation");
  const member = {
    ...continuityThread(97, 2, "Launch planning"),
    projectId: id,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 97,
    threads: [ordinary, member],
    chatEventRows: [
      continuityEventRow(97, 1, ordinary.id, "input.prompt", {
        payload: {
          userMessage: {
            version: 1,
            parts: [{ type: "project", projectId: id, nameSnapshot: "Launch" }],
          },
        },
      }),
    ],
  });
  metadata();
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: {
      [FeatureSwitchKey.Projects]: true,
    },
  });
  const user = userEvent.setup({ delay: null });
  await user.click(button("Hide chat list"));
  await waitFor(() => {
    expect(button("Show chat list")).toBeInTheDocument();
  });
  const mention = await waitFor(() => {
    const message = document.querySelector<HTMLElement>(
      "[data-structured-user-message]",
    );
    if (!message) {
      throw new Error("Message missing");
    }
    const link = namedLink(message, "Launch");
    if (!link) {
      throw new Error("Project mention missing");
    }
    return link;
  });
  expect(mention.getAttribute("href")).toContain(`/projects/${id}`);
  await user.click(mention);
  await waitFor(() => {
    expect(screen.getByTestId("chat-list-column")).toBeInTheDocument();
    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  });
  expect(namedLink(projectRows(), "Launch planning")).toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
});
