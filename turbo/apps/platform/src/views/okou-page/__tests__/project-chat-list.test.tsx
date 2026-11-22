import {
  projectsContract,
  type Project,
} from "@okouai/api-contracts/contracts/projects";
import {
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
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
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
