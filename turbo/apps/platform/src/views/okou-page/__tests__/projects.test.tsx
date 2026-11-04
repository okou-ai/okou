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
import { createDataTransferStub } from "./sidebar-test-helpers.tsx";

const context = testContext();
const reloadedContext = createTestRuntime(context);
const id = "30000000-0000-4000-8000-000000000071";
const at = "2026-11-02T00:00:00.000Z";
function folder(projectId = id) {
  const found = document.querySelector<HTMLElement>(
    `[data-project-folder-id="${projectId}"]`,
  );
  if (!found) {
    throw new Error("Project folder not found");
  }
  return found;
}
function button(name: string, container: HTMLElement | Document = document) {
  const found = queryAllByRoleFast("button", container).find((item) => {
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
function namedLink(container: HTMLElement, name: string) {
  return (
    queryAllByRoleFast("link", container).find((link) => {
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

test("Cached Project folders appear before chat setup and remote synchronization finish", async () => {
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
  expect(button("Launch", folder())).toBeInTheDocument();

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
    const projects = screen.getByRole("region", { name: "Projects" });
    await within(projects).findByText("Launch");
    expect(threadLink(thread.id)).toBeInTheDocument();
    expect(chatSetup.settled()).toBeFalsy();
    expect(remote.settled()).toBeFalsy();

    remote.resolve();
    await within(projects).findByText("Launch updated");
    expect(chatSetup.settled()).toBeFalsy();
  } finally {
    if (!remote.settled()) {
      remote.resolve();
    }
    chatSetup.resolve();
    await page.ready;
  }
});

test("Project folders stay visible when returning from a chat to its pinned Agent", async () => {
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
  click(button("Launch", folder()));
  expect(namedLink(folder(), "Launch planning")).toBeInTheDocument();
  const agent = await waitFor(() => {
    const link = document.querySelector(
      `[data-testid="pinned-agent-card"][href="/agents/${ordinary.agentId}/chat"]`,
    );
    if (!link) {
      throw new Error("Pinned Agent not found");
    }
    return link;
  });
  const projects = screen.getByRole("region", { name: "Projects" });
  let foldersDisappeared = false;
  const observer = new MutationObserver(() => {
    if (!projects.querySelector(`[data-project-folder-id="${id}"]`)) {
      foldersDisappeared = true;
    }
  });
  observer.observe(projects, { childList: true, subtree: true });
  try {
    refreshing = true;
    click(agent);
    await refreshStarted.promise;
    expect(location.pathname).toBe(`/agents/${ordinary.agentId}/chat`);
    expect(namedLink(folder(), "Launch planning")).toBeInTheDocument();
    expect(foldersDisappeared).toBeFalsy();

    releaseRefresh.resolve();
    await within(projects).findByText("Launch updated");
    expect(namedLink(folder(), "Launch planning")).toBeInTheDocument();
    expect(foldersDisappeared).toBeFalsy();
  } finally {
    if (!releaseRefresh.settled()) {
      releaseRefresh.resolve();
    }
    observer.disconnect();
  }
});

test.each(["account", "workspace"] as const)(
  "Project folders are cleared when the authenticated %s changes",
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
    expect(button("Launch", folder())).toBeInTheDocument();

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

test("Project folders remember open and collapsed states after a page reload", async () => {
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
  expect(button("Launch", folder())).toHaveAttribute("aria-expanded", "true");
  expect(button("Research", folder(otherId))).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  click(button("Launch", folder()));
  click(button("Research", folder(otherId)));
  expect(button("Launch", folder())).toHaveAttribute("aria-expanded", "false");
  expect(namedLink(folder(otherId), "Research notes")).toBeInTheDocument();

  context.store.set(resetPage$);
  releasePageDom();
  await setupPage({ context: reloadedContext, ...options });

  expect(button("Launch", folder())).toHaveAttribute("aria-expanded", "false");
  expect(namedLink(folder(), "Launch planning")).toBeNull();
  expect(button("Research", folder(otherId))).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(namedLink(folder(otherId), "Research notes")).toBeInTheDocument();
});

test.each(["account", "workspace"] as const)(
  "Project folder preferences stay separate for each %s",
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
    click(button("Launch", folder()));
    expect(button("Launch", folder())).toHaveAttribute("aria-expanded", "true");

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

    expect(button("Launch", folder())).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    click(button("Launch", folder()));
    expect(button("Launch", folder())).toHaveAttribute("aria-expanded", "true");
  },
);

test.each(["not json", '{"invalid":"true"}'])(
  "Project folders remain usable with invalid cached preferences: %s",
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

    expect(button("Launch", folder())).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    click(button("Launch", folder()));
    expect(button("Launch", folder())).toHaveAttribute("aria-expanded", "true");
    click(button("Launch", folder()));
    expect(button("Launch", folder())).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  },
);

test("Project folders show cross-Agent chats inline without leaving the current conversation", async () => {
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
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const user = userEvent.setup({ delay: null });
  await user.click(button("Launch", folder()));
  expect(namedLink(folder(), "Launch planning")).toBeVisible();
  expect(namedLink(folder(), "Other Agent research")).toHaveAttribute(
    "href",
    expect.stringContaining("/chats/" + other.id),
  );
  expect(namedLink(folder(), "Ordinary chat")).toBeNull();
  expect(namedLink(folder(), "Archived research")).toBeNull();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  await user.click(button("Options for Launch", folder()));
  await user.click(await findMenuItem("Archived chats"));
  expect(namedLink(folder(), "Archived research")).toBeVisible();
  await user.click(button("Launch", folder()));
  expect(button("Launch", folder())).toHaveAttribute("aria-expanded", "false");
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
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
    return expect(button("Campaign")).toHaveAttribute("aria-expanded", "true");
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
    return expect(button("Campaign two")).toBeInTheDocument();
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
  const projectFolder = await waitFor(() => {
    const parent = threadLink(ordinary.id).closest<HTMLElement>(
      "[data-project-folder-id]",
    );
    if (!parent) {
      throw new Error("Project folder not found");
    }
    return parent;
  });
  expect(button("Campaign", projectFolder)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await waitFor(() => {
    expect(threadLink(ordinary.id)).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(confirmation.settled()).toBeFalsy();
  const projectId = projectFolder.dataset.projectFolderId;
  if (!projectId) {
    throw new Error("Project identity missing");
  }

  await user.click(button("Campaign", projectFolder));
  await user.click(threadLink(other.id));
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${other.id}`);
  });
  confirmation.resolve();
  await waitFor(() => {
    expect(button("Campaign confirmed", folder(projectId))).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
  await user.click(button("Campaign confirmed", folder(projectId)));
  await waitFor(() => {
    expect(
      namedLink(folder(projectId), "Campaign planning"),
    ).toBeInTheDocument();
  });
  expect(
    folder(projectId).querySelectorAll(
      `[data-sidebar-chat-thread-id="${ordinary.id}"]`,
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
  const projectFolder = await waitFor(() => {
    const parent = button("Campaign").closest<HTMLElement>(
      "[data-project-folder-id]",
    );
    if (!parent) {
      throw new Error("Project folder not found");
    }
    return parent;
  });
  await user.click(button("New chat", projectFolder));
  await waitFor(() => {
    expect(button("New chat", projectFolder)).toBeDisabled();
  });
  expect(confirmation.settled()).toBeFalsy();
  confirmation.resolve();
  await waitFor(() => {
    expect(createdThread).toBeDefined();
    expect(location.pathname).toBe(`/chats/${createdThread?.id}`);
    expect(namedLink(projectFolder, "New chat")).toHaveAttribute(
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
    return expect(namedLink(folder(), "Ordinary chat")).toBeInTheDocument();
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
      namedLink(folder(secondId), "Ordinary chat"),
    ).toBeInTheDocument();
  });
  expect(namedLink(folder(), "Ordinary chat")).toBeNull();
  await user.click(rowMenu());
  await user.click(await findMenuItem("Move to Project"));
  await user.click(
    button(
      "Remove from Project",
      await screen.findByRole("dialog", { name: "Move chat" }),
    ),
  );
  await waitFor(() => {
    return expect(namedLink(folder(), "Ordinary chat")).toBeNull();
  });
  expect(
    document.querySelector(`[data-sidebar-chat-thread-id="${ordinary.id}"]`),
  ).toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
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
  click(button("Launch", folder()));
  const source = threadLink(ordinary.id);
  const target = threadLink(member.id);
  const dataTransfer = createDataTransferStub({ "text/uri-list": source.href });
  fireEvent.dragStart(source, { dataTransfer });
  expect(dataTransfer.getData("text/uri-list")).toBe("");
  fireEvent.dragOver(target, { dataTransfer, clientX: 160, clientY: 160 });
  await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
    "Move to Launch",
  );
  expect(folder()).toHaveAttribute("data-project-drop-target");
  // Moving between children must not clear the enclosing Project's hover.
  fireEvent(
    target,
    new MouseEvent("dragleave", {
      bubbles: true,
      relatedTarget: button("Launch", folder()),
    }),
  );
  expect(screen.getByRole("tooltip")).toHaveTextContent("Move to Launch");
  fireEvent.drop(target, { dataTransfer });
  await waitFor(() => {
    expect(namedLink(folder(), "Drag me into Launch")).toBeInTheDocument();
  });
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  confirmation.resolve();
  await canonicalRead.promise;
  expect(namedLink(folder(), "Drag me into Launch")).toBeInTheDocument();
});

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
  click(button("Launch", folder()));
  expect(button("Research", folder(secondId))).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const dataTransfer = createDataTransferStub();
  fireEvent.dragStart(threadLink(member.id), { dataTransfer });
  fireEvent.dragOver(folder(secondId), { dataTransfer });
  await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
    "Move to Research",
  );
  fireEvent.drop(folder(secondId), { dataTransfer });
  await waitFor(() => {
    expect(
      namedLink(folder(secondId), "Cross-Agent research"),
    ).toBeInTheDocument();
  });
  expect(button("Research", folder(secondId))).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(namedLink(folder(), "Cross-Agent research")).not.toBeInTheDocument();
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
  click(button("Launch", folder()));
  const dataTransfer = createDataTransferStub();
  fireEvent.dragStart(threadLink(ordinary.id), { dataTransfer });
  fireEvent.dragOver(folder(), { dataTransfer });
  await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
    "Move to Launch",
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(folder()).not.toHaveAttribute("data-project-drop-target");
  fireEvent.drop(folder(), { dataTransfer });
  expect(
    threadLink(ordinary.id).closest("[data-project-folder-id]"),
  ).toBeNull();

  const ownProjectTransfer = createDataTransferStub();
  fireEvent.dragStart(threadLink(member.id), {
    dataTransfer: ownProjectTransfer,
  });
  expect(
    fireEvent.dragOver(folder(), { dataTransfer: ownProjectTransfer }),
  ).toBeTruthy();
  fireEvent.dragEnd(threadLink(member.id), {
    dataTransfer: ownProjectTransfer,
  });
  const externalTransfer = createDataTransferStub({
    "text/uri-list": "https://example.com",
  });
  expect(
    fireEvent.dragOver(folder(), { dataTransfer: externalTransfer }),
  ).toBeTruthy();
  expect(
    fireEvent.drop(folder(), { dataTransfer: externalTransfer }),
  ).toBeTruthy();
  expect(namedLink(folder(), "Launch planning")).toBeInTheDocument();
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
  fireEvent.dragOver(folder(), { dataTransfer });
  fireEvent.drop(folder(), { dataTransfer });
  await expect(within(folder()).findByRole("alert")).resolves.toHaveTextContent(
    "Could not move chat",
  );
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
});

test("Project deep links open the Chat workspace with the folder expanded", async () => {
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
  await waitFor(() => {
    return expect(button("Launch", folder())).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
  expect(namedLink(folder(), "Launch planning")).toBeInTheDocument();
  expect(location.pathname).toContain("/chat");
});

test("Folder new chat opens before confirmation and retains its entry Agent", async () => {
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
    expect(body.agentId).toBe(ordinary.agentId);
    expect(body.projectId).toBe(id);
    createdId = body.clientThreadId;
    await confirmation.promise;
    const thread = {
      ...continuityThread(95, 3, "New folder chat"),
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
  await user.click(button("Launch", folder()));
  const link = namedLink(folder(), "Other Agent research");
  if (!link) {
    throw new Error("Member chat missing");
  }
  await waitFor(() => {
    return expect(link.getAttribute("href")).toContain(
      `projectAgent=${ordinary.agentId}`,
    );
  });
  await user.click(link);
  await waitFor(() => {
    return expect(location.pathname).toBe(`/chats/${other.id}`);
  });
  expect(location.search).toContain(`projectAgent=${ordinary.agentId}`);
  await user.click(button("New chat", folder()));
  await waitFor(() => {
    expect(namedLink(folder(), "New chat")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(createdId).toBeDefined();
    expect(location.pathname).toBe(`/chats/${createdId}`);
  });
  expect(location.search).toContain(`project=${id}`);
  expect(location.search).toContain(`projectAgent=${ordinary.agentId}`);
  expect(confirmation.settled()).toBeFalsy();
  confirmation.resolve();
  await persisted.promise;
  context.mocks.ably.trigger("threadListChanged");
  await waitFor(() => {
    return expect(namedLink(folder(), "New folder chat")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(location.pathname).toBe(`/chats/${createdId}`);
  expect(
    folder().querySelectorAll(`[data-sidebar-chat-thread-id="${createdId}"]`),
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
  click(button("Options for Launch", folder()));
  click(await findMenuItem("Rename"));
  await fill(
    await screen.findByRole("textbox", { name: "Project name" }),
    "Launch renamed",
  );
  click(button("Save"));
  await waitFor(() => {
    expect(button("Launch renamed", folder())).toBeInTheDocument();
    expect(button("Options for Launch renamed", folder())).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(confirmation.settled()).toBeFalsy();
  confirmation.resolve();
  await waitFor(() => {
    expect(button("Launch confirmed", folder())).toBeInTheDocument();
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
        [FeatureSwitchKey.PwaNavigation]: mobile,
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
        ? namedLink(folder(projectId), thread.title!)
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
          ? namedLink(folder(), "Planning chat")
          : document.querySelector(
              `[data-sidebar-chat-thread-id="${thread.id}"]`,
            );
      expect(link).toHaveTextContent("Planning chat");
      expect(link?.closest("[data-project-folder-id]")).toBe(
        projectId === null ? folder() : null,
      );
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
  click(button("Launch", folder()));
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
    within(folder()).findByText("No chats here yet"),
  ).resolves.toBeInTheDocument();
  expect(namedLink(folder(), "Project research")).toBeNull();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  expect(confirmation.settled()).toBeFalsy();
  confirmation.resolve();
});

test("PWA uses the same folders and a bottom sheet for Thread membership", async () => {
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
      [FeatureSwitchKey.PwaNavigation]: true,
    },
  });
  const user = userEvent.setup({ delay: null });
  await waitFor(() => {
    return expect(button("Launch", folder())).toBeInTheDocument();
  });
  await user.click(button("Launch", folder()));
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
  const link = namedLink(folder(), "Launch planning");
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
      [FeatureSwitchKey.UnifiedChatWorkspace]: true,
    },
  });
  const user = userEvent.setup({ delay: null });
  await user.click(button("Hide chat list"));
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
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
    expect(button("Launch", folder())).toHaveAttribute("aria-expanded", "true");
  });
  expect(namedLink(folder(), "Launch planning")).toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
});
