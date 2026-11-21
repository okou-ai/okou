import { CHAT_LIST_AGENT_ID } from "./chat-list-test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  projectsContract,
  type ProjectEvent,
} from "@okouai/api-contracts/contracts/projects";
import {
  chatThreadByIdContract,
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const projectId = "30000000-0000-4000-8000-000000000071";
const at = "2026-11-02T00:00:00.000Z";
function button(name: string, scope: ParentNode = document) {
  const found = queryAllByRoleFast("button", scope).find((item) => {
    return (
      item.textContent?.trim() === name ||
      item.getAttribute("aria-label") === name
    );
  });
  if (!found) {
    throw new Error(`Button ${name} not found`);
  }
  return found;
}
function members(quantity: number) {
  return Array.from({ length: quantity }, (_, index) => {
    return {
      ...continuityThread(451, 1, `Planning ${index + 1}`),
      id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      projectId,
      archived: index % 2 === 1,
    };
  });
}
function installDeletion(threads: readonly ChatThreadSnapshotProjection[]) {
  const ordinary = continuityThread(451, 2, "Unrelated chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 451,
    threads: [ordinary, ...threads],
  });
  const remaining = new Map(
    threads.map((thread) => {
      return [thread.id, thread];
    }),
  );
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    if (
      threads.some((thread) => {
        return thread.id === params.id;
      }) &&
      !remaining.has(params.id)
    ) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Chat not found" },
      });
    }
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  const projectEvents: ProjectEvent[] = [];
  const projectDeleted = context.mocks.deferred<void>();
  const threadEvents: ChatThreadEvent[] = [];
  context.mocks.api(projectsContract.get, ({ respond }) => {
    if (
      projectEvents.some((event) => {
        return event.kind === "deleted";
      })
    ) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Project not found" },
      });
    }
    return respond(200, {
      id: projectId,
      name: "Launch",
      createdAt: at,
      updatedAt: at,
    });
  });
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [
        { id: projectId, name: "Launch", createdAt: at, updatedAt: at },
      ],
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: projectEvents.filter((event) => {
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
  context.mocks.api(projectsContract.threads, ({ query, respond }) => {
    const all = [...remaining.values()].filter((thread) => {
      return (
        (!query.after || thread.id > query.after) &&
        (query.archived === "all" ||
          thread.archived === (query.archived === "true"))
      );
    });
    const page = all.slice(0, query.limit);
    return respond(200, {
      threads: page,
      nextAfter: all.length > page.length ? page.at(-1)!.id : null,
    });
  });
  function deleteThread(threadId: string, eventId: string) {
    const thread = remaining.get(threadId);
    if (!thread) {
      throw new Error("A successful deletion must not be replayed");
    }
    remaining.delete(threadId);
    threadEvents.push({
      id: eventId,
      seqId: threadEvents.length + 2,
      kind: "deleted",
      chatThreadId: threadId,
      title: thread.title,
      selectedModel: thread.selectedModel,
      serviceTier: thread.serviceTier,
      computerUseHostId: thread.computerUseHostId,
      createdAt: at,
    });
  }
  context.mocks.api(
    chatThreadByIdContract.delete,
    ({ params, query, respond }) => {
      deleteThread(params.id, query?.eventId ?? crypto.randomUUID());
      return respond(204);
    },
  );
  context.mocks.api(projectsContract.delete, ({ body, respond }) => {
    if (remaining.size > 0) {
      return respond(409, {
        error: {
          code: "CONFLICT",
          message: "Threads still need to be deleted",
        },
      });
    }
    projectEvents.push({
      id: body.eventId,
      seqId: 2,
      projectId,
      kind: "deleted",
      name: null,
      createdAt: at,
    });
    projectDeleted.resolve();
    return respond(204);
  });
  return {
    workspace,
    ordinary,
    remaining,
    deleteThread,
    projectEvents,
    projectDeleted,
  };
}
async function openDeletion() {
  click(button("Options for Launch"));
  const menu = await screen.findByRole("menu");
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === "Delete";
  });
  if (!item) {
    throw new Error("Delete menu item not found");
  }
  click(item);
  return screen.findByRole("dialog", { name: "Delete Project?" });
}
function switches() {
  return {
    [FeatureSwitchKey.ProjectThreadDeletion]: true,
  };
}

test("Project deletion confirmation includes every archived page and returns safely to choices", async () => {
  const fixture = installDeletion(members(101));
  await setupPage({
    context,
    path: `/chats/${fixture.ordinary.id}`,
    ...fixture.workspace.pageOptions,
    featureSwitches: switches(),
  });
  const first = await openDeletion();
  const fullDelete = await waitFor(() => {
    return button("Delete project and 101 threads…", first);
  });
  click(fullDelete);
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete project and threads?",
  });
  expect(within(confirmation).getByText("Planning 101")).toBeInTheDocument();
  expect(
    within(confirmation).getByText(/This cannot be undone/),
  ).toBeInTheDocument();
  await waitFor(() => {
    return expect(button("Back", confirmation)).toHaveFocus();
  });
  click(button("Back", confirmation));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Delete project and threads?" }),
    ).not.toBeInTheDocument();
  });
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Delete Project?" }),
    ).not.toBeInTheDocument();
  });
  expect(
    document.querySelector(`[data-project-row-id="${projectId}"]`),
  ).toHaveTextContent("Launch");
  expect(location.pathname).toBe(`/chats/${fixture.ordinary.id}`);
});

test("Retry reconciles an unknown deletion of the open thread and recovers navigation", async () => {
  const threads = members(3);
  const fixture = installDeletion(threads);
  let reject = true;
  context.mocks.api(
    chatThreadByIdContract.delete,
    ({ params, query, respond }) => {
      fixture.deleteThread(params.id, query?.eventId ?? crypto.randomUUID());
      if (params.id === threads[1]!.id && reject) {
        reject = false;
        return respond(400, {
          error: {
            code: "BAD_REQUEST",
            message: "Deletion response interrupted",
          },
        });
      }
      return respond(204);
    },
  );
  await setupPage({
    context,
    path: `/chats/${threads[1]!.id}`,
    ...fixture.workspace.pageOptions,
    featureSwitches: switches(),
  });
  const first = await openDeletion();
  click(
    await waitFor(() => {
      return button("Delete project and 3 threads…", first);
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete project and threads?",
  });
  click(button("Permanently delete", confirmation));
  await expect(
    within(confirmation).findByRole("alert"),
  ).resolves.toHaveTextContent("Deletion stopped");
  expect(button("Permanently delete", confirmation)).toBeEnabled();
  click(button("Permanently delete", confirmation));
  await expect(
    within(confirmation).findByText(/Review the updated list/),
  ).resolves.toBeInTheDocument();
  expect(within(confirmation).getByText("Planning 3")).toBeInTheDocument();
  expect(
    document.querySelector(`[data-project-row-id="${projectId}"]`),
  ).toHaveTextContent("Launch");
  click(button("Permanently delete", confirmation));
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
});

test("A new Project member requires reviewing the changed list before deleting anything", async () => {
  const threads = members(2);
  const fixture = installDeletion(threads.slice(0, 1));
  await setupPage({
    context,
    path: `/chats/${fixture.ordinary.id}`,
    ...fixture.workspace.pageOptions,
    featureSwitches: switches(),
  });
  const first = await openDeletion();
  click(
    await waitFor(() => {
      return button("Delete project and 1 thread…", first);
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete project and threads?",
  });
  expect(
    within(confirmation).getByText(
      /Permanently delete this Project and 1 thread,/,
    ),
  ).toBeInTheDocument();
  fixture.remaining.set(threads[1]!.id, threads[1]!);
  click(button("Permanently delete", confirmation));
  await expect(
    within(confirmation).findByText(/Review the updated list/),
  ).resolves.toBeInTheDocument();
  expect(within(confirmation).getByText("Planning 1")).toBeInTheDocument();
  expect(within(confirmation).getByText("Planning 2")).toBeInTheDocument();
  expect(
    within(confirmation).getByText(
      /Permanently delete this Project and 2 threads,/,
    ),
  ).toBeInTheDocument();
  click(button("Permanently delete", confirmation));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Delete Project?" }),
    ).not.toBeInTheDocument();
  });
});

test("Deleting an empty Project keeps the Project-only action available", async () => {
  const fixture = installDeletion([]);
  await setupPage({
    context,
    path: `/chats/${fixture.ordinary.id}`,
    ...fixture.workspace.pageOptions,
    featureSwitches: switches(),
  });
  const first = await openDeletion();
  await waitFor(() => {
    return expect(button("Delete project only", first)).toBeEnabled();
  });
  click(button("Delete project only", first));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Delete Project?" }),
    ).not.toBeInTheDocument();
  });
  expect(location.pathname).toBe(`/chats/${fixture.ordinary.id}`);
});

test("Deleting the open Project thread finishes the batch before navigating to a new chat", async () => {
  const threads = members(3);
  const fixture = installDeletion(threads);
  const gate = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadByIdContract.delete,
    async ({ params, query, respond }) => {
      await gate.promise;
      fixture.deleteThread(params.id, query?.eventId ?? crypto.randomUUID());
      return respond(204);
    },
  );
  await setupPage({
    context,
    path: `/chats/${threads[0]!.id}`,
    ...fixture.workspace.pageOptions,
    featureSwitches: switches(),
  });
  const first = await openDeletion();
  click(
    await waitFor(() => {
      return button("Delete project and 3 threads…", first);
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete project and threads?",
  });
  click(button("Permanently delete", confirmation));
  await waitFor(() => {
    return expect(button("Deleting…", confirmation)).toBeDisabled();
  });
  expect(button("Back", confirmation)).toBeDisabled();
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  expect(confirmation).toBeInTheDocument();
  gate.resolve();
  await fixture.projectDeleted.promise;
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(
    document.querySelector(`[data-project-row-id="${projectId}"]`),
  ).toBeNull();
});

test("Retry reconciles a final Project deletion that committed before its error response", async () => {
  const fixture = installDeletion(members(1));
  context.mocks.api(projectsContract.delete, ({ body, respond }) => {
    fixture.projectEvents.push({
      id: body.eventId,
      seqId: 2,
      projectId,
      kind: "deleted",
      name: null,
      createdAt: at,
    });
    return respond(409, {
      error: { code: "CONFLICT", message: "Final response interrupted" },
    });
  });
  await setupPage({
    context,
    path: `/chats/${fixture.ordinary.id}`,
    ...fixture.workspace.pageOptions,
    featureSwitches: switches(),
  });
  const first = await openDeletion();
  click(
    await waitFor(() => {
      return button("Delete project and 1 thread…", first);
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete project and threads?",
  });
  click(button("Permanently delete", confirmation));
  await expect(
    within(confirmation).findByRole("alert"),
  ).resolves.toHaveTextContent("Deletion stopped");
  click(button("Permanently delete", confirmation));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Delete Project?" }),
    ).not.toBeInTheDocument();
  });
  expect(location.pathname).toBe(`/chats/${fixture.ordinary.id}`);
});
