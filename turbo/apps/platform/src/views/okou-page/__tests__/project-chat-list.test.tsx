import type { ProjectEvent } from "@okouai/api-contracts/validators/projects";
import { mockNow } from "../../../lib/time.ts";
import { continuityThread, installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { menuItemByText } from "./sidebar-test-helpers.tsx";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  projectsContract,
  type Project,
} from "@okouai/api-contracts/contracts/projects";
import {
  chatThreadsContract,
  chatThreadPinOrderContract,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListAuth,
  chatListThread,
  cachedChatListEvents,
  installActiveChatBoundaries,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
function project(name: string, sortOrder: string): Project {
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
  current?: string,
  archiveMenuEnabled?: boolean,
) {
  const auth = chatListAuth(848);
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
    path: current ? "/chats/" + current : "/",
    auth,
    ...(archiveMenuEnabled === undefined
      ? {}
      : {
          featureSwitches: {
            [FeatureSwitchKey.ProjectArchive]: archiveMenuEnabled,
          },
        }),
    sharedWorkerTestTransport: "message-port",
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
  const launch = project("Launch", "a0"),
    research = project("Research", "a1"),
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
test("project-chat-list-005 an empty Inbox opens its archived conversation", async () => {
  const old = chatListThread(13, "Winter plan", { archived: true });
  await open([], [old]);
  await screen.findByText("Your inbox is empty");
  click(await findFastControl("button", "Show archived chats"));
  await expect(
    findFastControl("link", /Winter plan/),
  ).resolves.toBeInTheDocument();
});
test("project-chat-list-007 an empty project's archive reveals its own chat and preserves the current conversation", async () => {
  const launch = project("Launch", "a0"),
    research = project("Research", "a1"),
    active = chatListThread(14, "Outside notes"),
    old = chatListThread(15, "Archived launch", {
      archived: true,
      projectId: launch.id,
    });
  await open([launch, research], [active, old], active.id);
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
  const launch = project("Launch", "a0"),
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
  const launch = project("Launch", "a0"),
    inside = chatListThread(21, "Launch planning", { projectId: launch.id }),
    outside = chatListThread(22, "Current notes");
  await open([launch], [inside, outside], outside.id);
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
  const retired = { ...project("Harbor maps", "a0"), archived: true };
  const current = project("Field notes", "a1");
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
  await open([retired, current], threads);
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
    const client = project("Seaside research", "a0");
    await open([client], [], undefined, enabled);
    click(await findFastControl("button", "Options for Seaside research"));
    const menu = await screen.findByRole("menu");
    const actions = queryAllByRoleFast("menuitem", menu).filter((item) => {
      const label = item.textContent?.trim();
      return label === "Rename" || label === "Archive";
    });
    const labels = actions.map((action) => {
      expect(action).toBeVisible();
      return action.textContent?.trim();
    });
    expect(labels.sort()).toStrictEqual(
      enabled ? ["Archive", "Rename"] : ["Rename"],
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
    const toggle = (name: string) => queryFastControl("button", "Show or hide chats in " + name);
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
      return respond(200, { projects: [project], latestEventId: null, latestSeqId: 1 });
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
    click(menuItemByText("Archive"));
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
    const archiveResult = await waitFor(() => {
      return rejected
        ? screen.getByText("Archive confirmation unavailable")
        : toggle("Launch saved");
    });
    expect(archiveResult).toBeInTheDocument();
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
