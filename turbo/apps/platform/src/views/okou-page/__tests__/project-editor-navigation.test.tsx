import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import {
  projectsContract,
  type Project,
} from "@okouai/api-contracts/contracts/projects";
import {
  chatListThread,
  chatListAuth,
  cachedChatListEvents,
  installActiveChatBoundaries,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { project, projectEditor } from "./project-editor-fixtures.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import type { ProjectEvent } from "@okouai/api-contracts/validators/projects";
import { mockNow } from "../../../lib/time.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  menuItemByText,
  queryMenuItemByText,
} from "./sidebar-test-helpers.tsx";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatThreadsContract,
  chatThreadPinOrderContract,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";

const context = testContext();

async function options(name: string, action: "Rename" | "Delete") {
  click(await screen.findByLabelText("Options for " + name));
  await screen.findByRole("menu");
  click(menuItemByText(action));
  return screen.findByRole("dialog", {
    name: action === "Delete" ? "Delete Project?" : "Rename Project",
  });
}
async function save(dialog: HTMLElement, name: string) {
  await fill(within(dialog).getByRole("textbox"), name);
  click(await findFastControl("button", "Save", dialog));
}
const folder = (name: string) => {
  return findFastControl("button", "Show or hide chats in " + name);
};
test("projects-025 Creating, renaming and deleting a Project keeps the current conversation open", async () => {
  const release = context.mocks.deferred<void>();
  const ws = await projectEditor(context, [], {
    path: "chat",
    createGate: release.promise,
  });
  click(await findFastControl("button", "Create Project"));
  const create = await screen.findByRole("dialog", { name: "Create Project" });
  await save(create, "Campaign");
  await ws.creating;
  await expect(folder("Campaign")).resolves.toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(create).not.toBeInTheDocument();
  expect(location.pathname).toBe("/chats/" + ws.ordinary);
  release.resolve();
  const rename = await options("Campaign", "Rename");
  await save(rename, "Campaign two");
  await folder("Campaign two");
  const deletion = await options("Campaign two", "Delete");
  click(await findFastControl("button", "Delete project only", deletion));
  await waitFor(() => {
    expect(deletion).not.toBeInTheDocument();
    expect(
      queryFastControl("button", "Show or hide chats in Campaign two"),
    ).toBeNull();
  });
  expect(location.pathname).toBe("/chats/" + ws.ordinary);
});
test("projects-027 A denied deletion keeps the Project and offers a working retry in the same dialog", async () => {
  const gate = context.mocks.deferred<void>();
  let reject = true;
  const launch = project("Launch");
  const ws = await projectEditor(context, [launch], {
    path: "chat",
    onDelete: async () => {
      await gate.promise;
      return reject ? "fail" : "ok";
    },
  });
  const launchRow = await folder("Launch");
  const deletion = await options("Launch", "Delete");
  const remove = await findFastControl(
    "button",
    "Delete project only",
    deletion,
  );
  click(remove);
  await waitFor(() => {
    return expect(remove).toBeDisabled();
  });
  expect(launchRow).toBeInTheDocument();
  gate.resolve();
  await expect(
    within(deletion).findByText("Could not delete Project"),
  ).resolves.toBeVisible();
  expect(remove).toBeEnabled();
  reject = false;
  click(remove);
  await waitFor(() => {
    expect(deletion).not.toBeInTheDocument();
    expect(
      queryFastControl("button", "Show or hide chats in Launch"),
    ).toBeNull();
  });
  expect(location.pathname).toBe("/chats/" + ws.ordinary);
});
test("projects-049 The optimistic renamed folder appears before its persisted name replaces it", async () => {
  const gate = context.mocks.deferred<void>();
  const launch = project("Launch");
  await projectEditor(context, [launch], {
    path: "chat",
    renameGate: gate.promise,
    confirmedName: "Launch confirmed",
  });
  click(await screen.findByLabelText("Options for Launch"));
  await screen.findByRole("menu");
  await userEvent.keyboard("{F2}");
  const rename = await screen.findByRole("dialog", { name: "Rename Project" });
  expect(within(rename).getByRole("textbox")).toHaveValue("Launch");
  await save(rename, "Launch renamed");
  await expect(folder("Launch renamed")).resolves.toBeVisible();
  expect(rename).not.toBeInTheDocument();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  gate.resolve();
  await expect(folder("Launch confirmed")).resolves.toBeVisible();
  expect(
    queryFastControl("button", "Show or hide chats in Launch renamed"),
  ).toBeNull();
});

test("A second project rename replaces the rejected draft with the persisted label", async () => {
  const ws = await projectEditor(context, [project("Atlas")], {
    path: "chat",
    rejectedName: "Atlas draft",
    confirmedName: "Coastal atlas",
  });
  await save(await options("Atlas", "Rename"), "Atlas draft");
  await expect(
    screen.findByText("The project was edited elsewhere"),
  ).resolves.toBeVisible();
  await expect(folder("Atlas draft")).resolves.toBeVisible();
  const retry = await options("Atlas draft", "Rename");
  expect(within(retry).getByRole("textbox")).toHaveValue("Atlas draft");
  await save(retry, "Atlas revised");
  await expect(folder("Coastal atlas")).resolves.toBeVisible();
  expect(
    queryFastControl("button", "Show or hide chats in Atlas draft"),
  ).toBeNull();
  expect(location.pathname).toBe("/chats/" + ws.ordinary);
});

test.each([1, 3, 101])(
  "Deleting a project with %i conversations previews the named threads",
  async (count) => {
    const collection = project("Field notes");
    await projectEditor(context, [collection]);
    const records = Array.from({ length: count }, (_, index) => {
      return chatListThread(index + 1, "Field record " + (index + 1), {
        archived: true,
        projectId: collection.id,
      });
    });
    context.mocks.api(projectsContract.threads, ({ query, respond }) => {
      if (query.archived === "false") {
        return respond(200, { threads: [], nextAfter: null });
      }
      const start =
        records.findIndex((item) => {
          return item.id === query.after;
        }) + 1;
      const page = records.slice(start, start + query.limit);
      return respond(200, {
        threads: page,
        nextAfter: start + page.length < count ? page.at(-1)!.id : null,
      });
    });
    const choices = await options(collection.name, "Delete");
    const label =
      count === 1
        ? "Delete project and 1 thread"
        : "Delete project and " + count + " threads";
    click(await findFastControl("button", label, choices));
    const review = await screen.findByRole("dialog", {
      name: "Delete project and threads?",
    });
    expect(
      within(review).getByText("Field record " + count, { exact: true }),
    ).toBeInTheDocument();
    expect(within(review).getAllByRole("listitem")).toHaveLength(count);
  },
);

function chatListProject(name: string, sortOrder: string): Project {
  return {
    id: crypto.randomUUID(),
    name,
    sortOrder,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };
}
async function open(
  projects: Project[],
  threads: ChatThreadSnapshotProjection[],
  page: Partial<
    Pick<Parameters<typeof setupPage>[0], "auth" | "path" | "featureSwitches">
  > = {},
) {
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects,
      latestSeqId: 1,
      latestEventId: crypto.randomUUID(),
    });
  });
  context.mocks.api(projectsContract.threads, ({ params, respond }) => {
    return respond(200, {
      threads: threads.filter((t) => {
        return t.projectId === params.id;
      }),
      nextAfter: null,
    });
  });
  installChatListStream(context, { caseId: 848, snapshot: threads });
  installActiveChatBoundaries(context);
  context.mocks.api(
    chatThreadPinOrderContract.reorder,
    ({ params, body, respond }) => {
      const thread = threads.find((t) => {
        return t.id === params.id;
      });
      if (!thread) {
        throw new Error("Unknown chat");
      }
      thread.pinOrder = body.pinOrder;
      return respond(204);
    },
  );
  await setupPage({
    context,
    path: "/",
    auth: chatListAuth(848),
    ...page,
    cachedChatThreadEvents: cachedChatListEvents(848, threads),
  });
}
function handle(name: string) {
  return findFastControl("button", "Show or hide chats in " + name);
}
function children(p: Project) {
  const container = document.querySelector<HTMLElement>(
    '[data-project-children-id="' + p.id + '"]',
  );
  if (!container) {
    throw new Error("Project children not rendered: " + p.name);
  }
  return container;
}
function titles(p: Project) {
  return queryAllByRoleFast("link", children(p)).map((link) => {
    return link.querySelector('[data-slot="sidebar-thread-title"]')
      ?.textContent;
  });
}
test("project-chat-list-001 expanding active and empty projects keeps inbox-empty and archive controls out of view", async () => {
  const launch = chatListProject("Launch", "a0"),
    research = chatListProject("Research", "a1"),
    active = chatListThread(11, "Coastal launch", { projectId: launch.id }),
    archived = chatListThread(12, "Retired notebook", { archived: true });
  await open([launch, research], [active, archived]);
  const list = await handle("Launch");
  expect(list).toHaveAttribute("aria-expanded", "false");
  const inbox = () => {
    expect(screen.queryByText("Your inbox is empty")).toBeNull();
    expect(screen.queryByText("Show archived chats")).toBeNull();
  };
  inbox();
  click(list);
  await waitFor(() => {
    expect(titles(launch)).toContain("Coastal launch");
  });
  inbox();
  click(await handle("Research"));
  await waitFor(() => {
    expect(
      within(children(research)).getByText("No chats here yet"),
    ).toBeInTheDocument();
  });
  inbox();
});
test("project-chat-list-005 a staff workspace with All disabled opens its archived conversation from an empty Inbox", async () => {
  const old = chatListThread(13, "Winter plan", { archived: true });
  await open([], [old], {
    auth: staffAuth(),
    featureSwitches: { [FeatureSwitchKey.ChatListAllFilter]: false },
  });
  await screen.findByText("Your inbox is empty");
  click(await findFastControl("button", "Show archived chats"));
  await expect(
    findFastControl("link", /Winter plan/),
  ).resolves.toBeInTheDocument();
});
test("project-chat-list-007 an empty project's archive reveals its own chat and preserves the current conversation", async () => {
  const launch = chatListProject("Launch", "a0"),
    research = chatListProject("Research", "a1"),
    active = chatListThread(14, "Outside notes"),
    old = chatListThread(15, "Archived launch", {
      archived: true,
      projectId: launch.id,
    });
  await open([launch, research], [active, old], {
    path: "/chats/" + active.id,
  });
  click(await handle("Research"));
  await waitFor(() => {
    expect(
      within(children(research)).getByText("No chats here yet"),
    ).toBeInTheDocument();
  });
  click(await handle("Launch"));
  await waitFor(() => {
    expect(
      within(children(launch)).getByText("No chats here yet"),
    ).toBeInTheDocument();
  });
  click(
    await findFastControl("button", "Show archived chats", children(launch)),
  );
  await waitFor(() => {
    expect(titles(launch)).toContain("Archived launch");
  });
  expect(location.pathname).toBe("/chats/" + active.id);
});
test("project-chat-list-009 moving a project pin up and down never brings in an outside pin", async () => {
  const launch = chatListProject("Launch", "a0"),
    pinnedAt = "2026-08-02T09:00:00Z",
    first = chatListThread(17, "First pin", {
      projectId: launch.id,
      pinnedAt,
      pinOrder: "a0",
    }),
    second = chatListThread(18, "Second pin", {
      projectId: launch.id,
      pinnedAt,
      pinOrder: "a2",
    }),
    regular = chatListThread(19, "Regular chat", { projectId: launch.id }),
    outside = chatListThread(20, "Outside pin", { pinnedAt, pinOrder: "a1" });
  await open([launch], [first, second, regular, outside]);
  click(await handle("Launch"));
  const initial = ["First pin", "Second pin", "Regular chat"];
  await waitFor(() => {
    expect(titles(launch)).toStrictEqual(initial);
  });
  async function move(direction: "up" | "down") {
    const link = await findFastControl("link", /Second pin/, children(launch));
    const row = link.closest("[data-project-row-id]");
    if (!(row instanceof HTMLElement)) {
      throw new Error("Missing project chat row");
    }
    click(await within(row).findByTestId("chat-thread-menu-trigger"));
    const menu = await screen.findByRole("menu");
    click(await within(menu).findByText("Move " + direction));
  }
  await move("up");
  await waitFor(() => {
    expect(titles(launch)).toStrictEqual([
      "Second pin",
      "First pin",
      "Regular chat",
    ]);
  });
  await move("down");
  await waitFor(() => {
    expect(titles(launch)).toStrictEqual(initial);
  });
});
test("project-chat-list-011 folding Launch twice preserves the selected outside conversation and its address", async () => {
  const launch = chatListProject("Launch", "a0"),
    inside = chatListThread(21, "Launch planning", { projectId: launch.id }),
    outside = chatListThread(22, "Current notes");
  await open([launch], [inside, outside], { path: "/chats/" + outside.id });
  const current = await findFastControl("link", /Current notes/);
  expect(current).toHaveAttribute("aria-current", "page");
  const trigger = await handle("Launch");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  click(trigger);
  await waitFor(() => {
    expect(titles(launch)).toContain("Launch planning");
  });
  click(trigger);
  await waitFor(() => {
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Launch planning")).toBeNull();
  });
  expect(current).toHaveAttribute("aria-current", "page");
  expect(location.pathname).toBe("/chats/" + outside.id);
});

test("The archive shows both chats in a retired project and only the archived chat in a current project", async () => {
  const retired = { ...chatListProject("Harbor maps", "a0"), archived: true };
  const current = chatListProject("Field notes", "a1");
  const threads = [
    chatListThread(31, "Harbor survey", { projectId: retired.id }),
    chatListThread(32, "Older survey", {
      projectId: retired.id,
      archived: true,
    }),
    chatListThread(33, "Current fieldwork", { projectId: current.id }),
    chatListThread(34, "Prior fieldwork", {
      projectId: current.id,
      archived: true,
    }),
  ];
  await open([retired, current], threads, {
    featureSwitches: { [FeatureSwitchKey.ChatListAllFilter]: true },
  });
  await handle(current.name);
  expect(
    queryFastControl("button", "Show or hide chats in Harbor maps"),
  ).toBeNull();
  click(await findFastControl("button", "Open chat list menu"));
  const filters = within(await screen.findByRole("menu"));
  click(await filters.findByText("Archived"));
  const archivedRow = await handle(retired.name);
  expect(archivedRow).not.toHaveTextContent("Archived");
  click(archivedRow);
  click(await handle(current.name));
  await waitFor(() => {
    expect(titles(retired).sort()).toStrictEqual([
      "Harbor survey",
      "Older survey",
    ]);
    expect(titles(current)).toStrictEqual(["Prior fieldwork"]);
  });
});

test.each([true, false])(
  "Project archive action follows the workspace switch (%s)",
  async (enabled) => {
    const client = chatListProject("Seaside research", "a0");
    await open([client], [], {
      featureSwitches: { [FeatureSwitchKey.ProjectArchive]: enabled },
    });
    click(await findFastControl("button", "Options for Seaside research"));
    await screen.findByRole("menu");
    const rename = menuItemByText("Rename");
    expect(rename).toHaveTextContent("F2");
    expect(rename).toHaveAttribute("aria-keyshortcuts", "F2");
    const archiveHint = expect.stringContaining("Ctrl+Shift+X");
    expect(queryMenuItemByText("Archive")?.textContent).toStrictEqual(
      enabled ? archiveHint : undefined,
    );
  },
);

function projectRows(projectId: string) {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-project-row-id="${projectId}"]`,
    ),
  ];
}

function threadLink(threadId: string) {
  return document.querySelector<HTMLAnchorElement>(
    `[data-sidebar-chat-thread-id="${threadId}"]`,
  );
}

function staffAuth() {
  const staffOrg = { id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", name: "Staff" };
  return {
    ...chatListAuth(848),
    organization: { activeOrg: staffOrg, memberships: [staffOrg] },
  };
}

test("All shows active and archived chats both inside and outside Projects", async () => {
  const current = chatListProject("Current work", "a0");
  const previous = { ...chatListProject("Past work", "a1"), archived: true };
  const notes = chatListThread(11, "Notes");
  const oldNotes = chatListThread(12, "Old notes", {
    archived: true,
    muted: true,
  });
  const planning = chatListThread(13, "Planning", { projectId: current.id });
  const history = chatListThread(14, "History", {
    projectId: current.id,
    archived: true,
  });
  const handoff = chatListThread(15, "Handoff", { projectId: previous.id });
  await open(
    [current, previous],
    [notes, oldNotes, planning, history, handoff],
    { path: "/chats/" + planning.id, auth: staffAuth() },
  );

  await waitFor(() => {
    expect(threadLink(planning.id)).toBeVisible();
    expect(threadLink(notes.id)).toBeVisible();
  });
  expect(threadLink(oldNotes.id)).toBeNull();
  expect(threadLink(history.id)).toBeNull();
  expect(projectRows(previous.id)).toHaveLength(0);

  click(await findFastControl("button", "Open chat list menu"));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("Unarchived")).toBeVisible();
  click(within(menu).getByText("All"));
  click(await handle(previous.name));
  await waitFor(() => {
    for (const thread of [notes, oldNotes, planning, history, handoff]) {
      expect(threadLink(thread.id)).toBeVisible();
    }
  });
  expect(location.pathname).toBe("/chats/" + planning.id);

  click(await findFastControl("button", "Open chat list menu"));
  click(within(await screen.findByRole("menu")).getByText("Unarchived"));
  await waitFor(() => {
    expect(threadLink(notes.id)).toBeVisible();
    expect(threadLink(oldNotes.id)).toBeNull();
    expect(projectRows(previous.id)).toHaveLength(0);
  });
});

test("Show all chats in the empty mobile list reveals an archived Project's unarchived chat", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(pointer: coarse)" || query === "(display-mode: standalone)"
    );
  });
  const previous = { ...chatListProject("Past work", "a0"), archived: true };
  const handoff = chatListThread(15, "Handoff", { projectId: previous.id });
  await open([previous], [handoff], { auth: staffAuth() });
  await screen.findByText("No unarchived chats");
  click(await findFastControl("button", "Show all chats"));
  click(await handle(previous.name));
  await waitFor(() => {
    expect(threadLink(handoff.id)).toBeVisible();
  });
  expect(location.pathname).toBe("/");
});

async function openProjectForArchiveShortcut(
  current: Project,
  other: Project,
  enabled: boolean,
) {
  context.mocks.browser.userAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X)");
  const workspace = installContinuityWorkspace(context, {
    caseId: enabled ? 332 : 333,
    threads: [],
  });
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [current, other],
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  await setupPage({
    context,
    path: `/projects/${current.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.ProjectArchive]: enabled },
  });
  await expect(handle(current.name)).resolves.toBeInTheDocument();
}

function pressMacArchiveShortcut() {
  return fireEvent.keyDown(document, {
    key: "X",
    code: "KeyX",
    metaKey: true,
    shiftKey: true,
  });
}

test("The Project page still offers F2 rename when Project Archive is disabled", async () => {
  await openProjectForArchiveShortcut(
    chatListProject("Launch", "a0"),
    chatListProject("Research", "a1"),
    false,
  );
  expect(pressMacArchiveShortcut()).toBeTruthy();
  await userEvent.keyboard("{F2}");
  const dialog = await screen.findByRole("dialog", { name: "Rename Project" });
  expect(within(dialog).getByRole("textbox")).toHaveValue("Launch");
});

test("The Mac archive shortcut toggles the current Project and follows focus to another Project row", async () => {
  const launch = chatListProject("Launch", "a0");
  const research = chatListProject("Research", "a1");
  context.mocks.api(projectsContract.update, ({ params, body, respond }) => {
    const project = [launch, research].find((item) => {
      return item.id === params.id;
    });
    if (!project) {
      throw new Error("Unknown Project");
    }
    return respond(200, { ...project, archived: body.archived });
  });
  await openProjectForArchiveShortcut(launch, research, true);

  pressMacArchiveShortcut();
  await waitFor(() => {
    expect(projectRows(launch.id)).toHaveLength(0);
  });
  await expect(handle(research.name)).resolves.toBeInTheDocument();

  pressMacArchiveShortcut();
  await expect(handle(launch.name)).resolves.toBeInTheDocument();

  (await handle(research.name)).focus();
  await userEvent.keyboard("{Meta>}{Shift>}x{/Shift}{/Meta}");
  await waitFor(() => {
    expect(projectRows(research.id)).toHaveLength(0);
  });
  await expect(handle(launch.name)).resolves.toBeInTheDocument();
  expect(location.pathname).toBe(`/projects/${launch.id}`);
});

test.each([
  { mobile: false, rejected: false },
  { mobile: true, rejected: false },
  { mobile: false, rejected: true },
])(
  "Project archive and restore update before confirmation and reconcile later events (mobile: $mobile, rejected: $rejected)",
  async ({ mobile, rejected }) => {
    const launchId = "30000000-0000-4000-8000-000000000081";
    const at = "2026-11-02T00:00:00.000Z";
    mockNow(new Date("2026-11-03T00:00:00.000Z"), context.signal);
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 48rem)" && !mobile;
    });
    const toggle = (name: string) => {
      return queryFastControl("button", "Show or hide chats in " + name);
    };
    const archiveResponse = context.mocks.deferred<void>();
    const restoreResponse = context.mocks.deferred<void>();
    const ordinary = continuityThread(328, 1, "Ordinary chat");
    const planning = {
      ...continuityThread(328, 2, "Launch planning"),
      projectId: launchId,
    };
    const workspace = installContinuityWorkspace(context, {
      caseId: 328,
      threads: [ordinary, planning],
    });
    const project = {
      id: launchId,
      name: "Launch",
      createdAt: at,
      updatedAt: at,
    };
    context.mocks.api(projectsContract.snapshot, ({ respond }) => {
      return respond(200, {
        projects: [project],
        latestEventId: null,
        latestSeqId: 1,
      });
    });
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        threads: { [planning.id]: "unread" },
        unreadAt: { [planning.id]: at },
      });
    });
    const events: ProjectEvent[] = [];
    context.mocks.api(projectsContract.events, ({ query, respond }) => {
      return respond(200, {
        events: events.filter((event) => {
          return event.seqId > query.sinceSeqId;
        }),
        hasMore: false,
      });
    });
    context.mocks.api(projectsContract.update, async ({ body, respond }) => {
      const { archived } = body;
      if (archived === undefined) {
        throw new Error("Expected a Project archive or restore");
      }
      await (archived ? archiveResponse.promise : restoreResponse.promise);
      if (archived && rejected) {
        return respond(409, {
          error: {
            code: "CONFLICT",
            message: "Archive confirmation unavailable",
          },
        });
      }
      const name = archived ? "Launch saved" : "Launch restored";
      events.push({
        id: body.eventId,
        seqId: events.length + 2,
        projectId: launchId,
        kind: "renamed",
        name,
        archived,
        lastArchivedAt: at,
        createdAt: at,
      });
      return respond(200, { ...project, name, archived, lastArchivedAt: at });
    });
    await setupPage({
      context,
      path: mobile ? "/" : `/chats/${ordinary.id}`,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.ProjectArchive]: true },
    });
    await waitFor(() => {
      expect(toggle("Launch")).toHaveAccessibleDescription("Unread");
    });
    click(await handle("Launch"));
    await waitFor(() => {
      expect(threadLink(planning.id)).toHaveAccessibleName(
        "Launch planning Unread",
      );
    });
    click(await findFastControl("button", "Options for Launch"));
    await screen.findByRole("menu");
    if (mobile) {
      click(menuItemByText("Archive"));
    } else {
      await userEvent.keyboard("{Control>}{Shift>}x{/Shift}{/Control}");
    }
    await waitFor(() => {
      expect(projectRows(launchId)).toHaveLength(0);
    });
    expect(archiveResponse.settled()).toBeFalsy();

    click(await findFastControl("button", "Open chat list menu"));
    await screen.findByRole("menu");
    click(menuItemByText("Archived"));
    await waitFor(() => {
      expect(toggle("Launch")).toBeInTheDocument();
    });
    expect(titles(project)).toStrictEqual(["Launch planning"]);
    archiveResponse.resolve();
    if (rejected) {
      await screen.findByText("Archive confirmation unavailable");
    } else {
      await handle("Launch saved");
    }
    const archivedName = rejected ? "Launch" : "Launch saved";
    click(await findFastControl("button", `Options for ${archivedName}`));
    await screen.findByRole("menu");
    click(menuItemByText("Restore project"));
    await waitFor(() => {
      expect(projectRows(launchId)).toHaveLength(0);
    });
    expect(restoreResponse.settled()).toBeFalsy();

    click(await findFastControl("button", "Open chat list menu"));
    await screen.findByRole("menu");
    click(menuItemByText("Inbox"));
    await waitFor(() => {
      expect(toggle(archivedName)).toBeInTheDocument();
    });
    expect(titles(project)).toStrictEqual(["Launch planning"]);
    // Restoring retains the archive cutoff instead of reviving old unread state.
    expect(threadLink(planning.id)).toHaveAccessibleName("Launch planning");
    restoreResponse.resolve();
    await waitFor(() => {
      expect(toggle("Launch restored")).toBeInTheDocument();
    });

    // The restore receipt also settles a rejected archive. Once settled,
    // neither local edit can hide a later archive from another client.
    events.push({
      id: crypto.randomUUID(),
      seqId: events.length + 2,
      projectId: launchId,
      kind: "renamed",
      name: "Launch remote",
      archived: true,
      lastArchivedAt: at,
      createdAt: at,
    });
    context.mocks.ably.trigger("threadListChanged");
    await waitFor(() => {
      expect(projectRows(launchId)).toHaveLength(0);
    });
    click(await findFastControl("button", "Open chat list menu"));
    await screen.findByRole("menu");
    click(menuItemByText("Archived"));
    await waitFor(() => {
      expect(toggle("Launch remote")).toBeInTheDocument();
    });
    expect(titles(project)).toStrictEqual(["Launch planning"]);
  },
);
