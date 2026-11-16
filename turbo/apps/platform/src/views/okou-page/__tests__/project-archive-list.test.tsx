import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import type {
  Project,
  ProjectEvent,
} from "@okouai/api-contracts/validators/projects";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
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
import { CHAT_LIST_AGENT_ID } from "./chat-list-test-helpers.ts";
import { menuItemByText } from "./sidebar-test-helpers.tsx";

const context = testContext();
const launchId = "30000000-0000-4000-8000-000000000091";
const researchId = "30000000-0000-4000-8000-000000000092";
const emptyArchiveId = "30000000-0000-4000-8000-000000000093";
const emptyActiveId = "30000000-0000-4000-8000-000000000094";
const missingId = "30000000-0000-4000-8000-000000000095";
const at = "2026-11-01T00:00:00.000Z";
const archivedAt = "2026-11-02T00:00:00.000Z";

function project(
  id: string,
  name: string,
  archiveTime?: string | null,
): Project {
  return {
    id,
    name,
    createdAt: at,
    updatedAt: at,
    ...(archiveTime === undefined ? {} : { archivedAt: archiveTime }),
  };
}

// The endpoint state owns the lifecycle. Tests only drive it through the page.
function installProjects(initialProjects: readonly Project[]) {
  const projects = new Map(
    initialProjects.map((item) => {
      return [item.id, item];
    }),
  );
  const events: ProjectEvent[] = [];
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [...initialProjects],
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > query.sinceSeqId;
      }),
      hasMore: false,
    });
  });
  context.mocks.api(projectsContract.archive, ({ params, body, respond }) => {
    const current = projects.get(params.id);
    if (!current) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Project not found" },
      });
    }
    const archived = { ...current, archivedAt };
    projects.set(current.id, archived);
    events.push({
      id: body.eventId,
      projectId: current.id,
      seqId: events.length + 2,
      name: current.name,
      kind: "archived",
      createdAt: archivedAt,
    });
    return respond(200, archived);
  });
  context.mocks.api(projectsContract.restore, ({ params, body, respond }) => {
    const current = projects.get(params.id);
    if (!current) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Project not found" },
      });
    }
    const restored = { ...current, archivedAt: null };
    projects.set(current.id, restored);
    events.push({
      id: body.eventId,
      projectId: current.id,
      seqId: events.length + 2,
      name: current.name,
      kind: "restored",
      createdAt: archivedAt,
    });
    return respond(200, restored);
  });
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(agentDraftContract.patch, ({ respond }) => {
    return respond(204);
  });
}

function projectRows(projectId = launchId) {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-project-row-id="${projectId}"]`,
    ),
  ];
}

function button(name: string, container: ParentNode = document) {
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

function projectToggle(name: string, projectId = launchId) {
  const row = projectRows(projectId)[0];
  if (!row) {
    throw new Error(`Project ${name} not found`);
  }
  return button(`Show or hide chats in ${name}`, row);
}

function threadLink(threadId: string) {
  return document.querySelector<HTMLAnchorElement>(
    `[data-sidebar-chat-thread-id="${threadId}"]`,
  );
}

function projectThreadIds(projectId = launchId) {
  return projectRows(projectId).flatMap((row) => {
    return [
      ...row.querySelectorAll<HTMLElement>("[data-sidebar-chat-thread-id]"),
    ].map((link) => {
      return link.dataset.sidebarChatThreadId;
    });
  });
}

async function selectFilter(name: "Inbox" | "Unread" | "Archived" | "Muted") {
  click(button("Open chat list menu"));
  await screen.findByRole("menu");
  click(menuItemByText(name));
}

function installUnread(threadIds: readonly string[]) {
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [CHAT_LIST_AGENT_ID]: "unread" },
      threads: Object.fromEntries(
        threadIds.map((id) => {
          return [id, "unread" as const];
        }),
      ),
      unreadAt: Object.fromEntries(
        threadIds.map((id) => {
          return [id, archivedAt];
        }),
      ),
    });
  });
}

test.each([false, true])(
  "Archived combines whole archived Projects, independently archived chats and empty Projects (mobile: %s)",
  async (mobile) => {
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 48rem)" && !mobile;
    });
    const ordinary = continuityThread(331, 1, "Ordinary chat");
    const parentOnly = {
      ...continuityThread(331, 2, "Other Agent pin"),
      agentId: "c7000000-0000-4000-a000-000000000009",
      projectId: launchId,
      pinnedAt: at,
      pinOrder: "a0",
      muted: true,
    };
    const archivedChild = {
      ...continuityThread(331, 3, "Archived Launch notes"),
      projectId: launchId,
      archived: true,
    };
    const activeChild = {
      ...continuityThread(331, 4, "Active Research"),
      projectId: researchId,
    };
    const independentArchive = {
      ...continuityThread(331, 5, "Archived Research"),
      projectId: researchId,
      archived: true,
    };
    const outsideArchive = {
      ...continuityThread(331, 6, "Unassigned archive"),
      archived: true,
    };
    const workspace = installContinuityWorkspace(context, {
      caseId: 331,
      threads: [
        ordinary,
        parentOnly,
        archivedChild,
        activeChild,
        independentArchive,
        outsideArchive,
      ],
    });
    installProjects([
      project(launchId, "Launch", archivedAt),
      // An older snapshot may omit the field; it still owns an active group.
      project(researchId, "Research"),
      project(emptyArchiveId, "Empty archive", archivedAt),
      project(emptyActiveId, "Empty active", null),
    ]);
    await setupPage({
      context,
      path: `/agents/${ordinary.agentId}/chat`,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.Projects]: true },
    });
    await waitFor(() => {
      expect(projectToggle("Research", researchId)).toBeInTheDocument();
    });
    expect(projectRows()).toHaveLength(0);
    expect(projectRows(emptyArchiveId)).toHaveLength(0);
    click(projectToggle("Research", researchId));
    await waitFor(() => {
      expect(projectThreadIds(researchId)).toStrictEqual([activeChild.id]);
    });

    await selectFilter("Archived");
    await waitFor(() => {
      expect(projectToggle("Launch")).toBeInTheDocument();
    });
    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
    expect(projectThreadIds(researchId)).toStrictEqual([independentArchive.id]);
    expect(projectToggle("Empty archive", emptyArchiveId)).toBeInTheDocument();
    expect(projectRows(emptyActiveId)).toHaveLength(0);
    expect(threadLink(outsideArchive.id)).toBeInTheDocument();
    expect(threadLink(ordinary.id)).not.toBeInTheDocument();

    click(projectToggle("Launch"));
    await waitFor(() => {
      expect(projectThreadIds()).toStrictEqual([
        parentOnly.id,
        archivedChild.id,
      ]);
    });
    // The older pin still leads; the muted state takes the row's state label.
    await waitFor(() => {
      expect(threadLink(parentOnly.id)).toHaveAccessibleName(
        "Other Agent pin Muted",
      );
    });
    click(projectToggle("Empty archive", emptyArchiveId));
    await waitFor(() => {
      expect(
        projectRows(emptyArchiveId).some((row) => {
          return row.textContent?.includes("No chats here yet");
        }),
      ).toBeTruthy();
    });
    const listedIds = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-sidebar-chat-thread-id]",
      ),
    ].map((link) => {
      return link.dataset.sidebarChatThreadId;
    });
    expect(listedIds).toHaveLength(4);
    expect(new Set(listedIds).size).toBe(4);

    await selectFilter("Inbox");
    await waitFor(() => {
      expect(projectThreadIds(researchId)).toStrictEqual([activeChild.id]);
    });
    expect(projectRows()).toHaveLength(0);
    await selectFilter("Archived");
    await waitFor(() => {
      expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
    });
    expect(projectThreadIds()).toStrictEqual([parentOnly.id, archivedChild.id]);
  },
);

test.each([false, true])(
  "An empty Inbox still leads to an empty archived Project (mobile: %s)",
  async (mobile) => {
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 48rem)" && !mobile;
    });
    const workspace = installContinuityWorkspace(context, {
      caseId: 332,
      threads: [],
    });
    installProjects([project(emptyArchiveId, "Empty archive", archivedAt)]);
    await setupPage({
      context,
      path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.Projects]: true },
    });
    await expect(
      screen.findByText("Your inbox is empty"),
    ).resolves.toBeInTheDocument();
    click(button("Show archived chats"));
    await waitFor(() => {
      expect(
        projectToggle("Empty archive", emptyArchiveId),
      ).toBeInTheDocument();
    });
  },
);

test.each(["Inbox", "Unread", "Muted"] as const)(
  "%s hides an archived parent and all its children while keyboard navigation keeps the hidden current position",
  async (filter) => {
    const current = {
      ...continuityThread(333, 2, "Hidden current pin"),
      projectId: launchId,
      pinnedAt: at,
      pinOrder: "a0",
      muted: true,
    };
    const hiddenSibling = {
      ...continuityThread(333, 3, "Hidden archived sibling"),
      projectId: launchId,
      archived: true,
      muted: true,
    };
    const visible = {
      ...continuityThread(333, 4, "Visible Research"),
      projectId: researchId,
      // An independent archive still belongs in Unread under an active parent.
      archived: filter === "Unread",
      muted: true,
    };
    const workspace = installContinuityWorkspace(context, {
      caseId: 333,
      threads: [current, hiddenSibling, visible],
    });
    context.mocks.data.onboardingStatus({ defaultAgentId: current.agentId });
    installProjects([
      project(launchId, "Launch", archivedAt),
      project(researchId, "Research", null),
    ]);
    // The current chat is already read; its hidden position must still exist.
    installUnread([hiddenSibling.id, visible.id]);
    await setupPage({
      context,
      path: `/chats/${current.id}`,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.Projects]: true },
    });
    await waitFor(() => {
      expect(projectToggle("Research", researchId)).toBeInTheDocument();
    });
    if (filter !== "Inbox") {
      await selectFilter(filter);
    }
    await waitFor(() => {
      expect(projectToggle("Research", researchId)).toBeInTheDocument();
    });
    click(projectToggle("Research", researchId));
    await waitFor(() => {
      expect(threadLink(visible.id)).toBeInTheDocument();
    });
    expect(projectRows()).toHaveLength(0);
    expect(threadLink(current.id)).not.toBeInTheDocument();
    expect(threadLink(hiddenSibling.id)).not.toBeInTheDocument();
    expect(location.pathname).toBe(`/chats/${current.id}`);
    const composer = await screen.findByRole("textbox", { name: "Message" });
    composer.focus();

    await userEvent
      .setup({ delay: null })
      .keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}");
    await waitFor(() => {
      expect(location.pathname).toBe(`/projects/${researchId}`);
    });
    expect(projectRows()).toHaveLength(0);
    expect(threadLink(visible.id)).toBeInTheDocument();
  },
);

test("Restoring a Project reclassifies its chats without changing their archive, pin, unread or mute state", async () => {
  const ordinary = continuityThread(334, 1, "Ordinary chat");
  const pinned = {
    ...continuityThread(334, 2, "Pinned child"),
    projectId: launchId,
    pinnedAt: at,
    pinOrder: "a0",
  };
  const muted = {
    ...continuityThread(334, 3, "Muted child"),
    projectId: launchId,
    muted: true,
  };
  const unread = {
    ...continuityThread(334, 4, "Unread child"),
    projectId: launchId,
  };
  const independentArchive = {
    ...continuityThread(334, 5, "Independently archived child"),
    projectId: launchId,
    archived: true,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 334,
    threads: [ordinary, pinned, muted, unread, independentArchive],
  });
  installProjects([
    project(launchId, "Launch", null),
    project(researchId, "Research", null),
  ]);
  installUnread([unread.id]);
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await waitFor(() => {
    expect(projectToggle("Launch")).toBeInTheDocument();
  });
  click(projectToggle("Launch"));
  await waitFor(() => {
    expect(threadLink(unread.id)).toHaveAccessibleName("Unread child Unread");
  });
  expect(projectThreadIds()).toStrictEqual([pinned.id, unread.id, muted.id]);
  click(button("Options for Launch"));
  await screen.findByRole("menu");
  click(menuItemByText("Archive project"));
  await expect(
    screen.findByText("Project archived"),
  ).resolves.toBeInTheDocument();
  expect(projectRows()).toHaveLength(0);
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);

  click(button("View archives"));
  await waitFor(() => {
    expect(projectThreadIds()).toStrictEqual([
      pinned.id,
      independentArchive.id,
      unread.id,
      muted.id,
    ]);
  });
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  click(button("Options for Launch"));
  await screen.findByRole("menu");
  click(menuItemByText("Restore project"));
  await expect(
    screen.findByText("Project restored"),
  ).resolves.toBeInTheDocument();
  expect(projectThreadIds()).toStrictEqual([independentArchive.id]);

  await selectFilter("Inbox");
  await waitFor(() => {
    expect(threadLink(unread.id)).toHaveAccessibleName("Unread child Unread");
  });
  expect(projectThreadIds()).toStrictEqual([pinned.id, unread.id, muted.id]);
  expect(threadLink(pinned.id)).toHaveAccessibleName("Pinned child Pinned");
  expect(threadLink(muted.id)).toHaveAccessibleName("Muted child Muted");
  expect(
    [...document.querySelectorAll<HTMLElement>("[data-project-trigger]")].map(
      (trigger) => {
        return trigger.getAttribute("aria-label");
      },
    ),
  ).toStrictEqual([
    "Show or hide chats in Launch",
    "Show or hide chats in Research",
  ]);
  await selectFilter("Unread");
  await waitFor(() => {
    expect(projectThreadIds()).toStrictEqual([unread.id]);
  });
  await selectFilter("Muted");
  await waitFor(() => {
    expect(projectThreadIds()).toStrictEqual([muted.id]);
  });
});

test("Hidden archived-parent chats remain directly usable and searchable without exposing a missing Project", async () => {
  const ordinary = continuityThread(335, 1, "Ordinary chat");
  const hidden = {
    ...continuityThread(335, 2, "Hidden project chat"),
    projectId: launchId,
  };
  const unresolved = {
    ...continuityThread(335, 3, "Unavailable parent chat"),
    projectId: missingId,
    archived: true,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 335,
    threads: [ordinary, hidden, unresolved],
  });
  installProjects([project(launchId, "Launch", archivedAt)]);
  await setupPage({
    context,
    path: `/chats/${hidden.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${hidden.id}`);
  expect(projectRows()).toHaveLength(0);
  expect(threadLink(ordinary.id)).toBeInTheDocument();

  await selectFilter("Archived");
  await waitFor(() => {
    expect(threadLink(hidden.id)).toBeInTheDocument();
  });
  expect(projectRows(missingId)).toHaveLength(0);
  expect(threadLink(unresolved.id)).not.toBeInTheDocument();
  await selectFilter("Inbox");
  await waitFor(() => {
    expect(threadLink(ordinary.id)).toHaveAttribute("aria-current", "page");
  });
  click(button("Search workspace"));
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "Hidden project chat",
  );
  const result = await within(dialog).findByText("Hidden project chat");
  click(result);
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${hidden.id}`);
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(projectRows()).toHaveLength(0);
  expect(projectRows(missingId)).toHaveLength(0);
});
