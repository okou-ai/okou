import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import type {
  Project,
  ProjectEvent,
} from "@okouai/api-contracts/validators/projects";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const projectId = "30000000-0000-4000-8000-000000000081";
const researchId = "30000000-0000-4000-8000-000000000082";
const createdAt = "2026-11-02T00:00:00.000Z";
const archivedAt = "2026-11-03T00:00:00.000Z";
const bannerText = "This project is archived. You can still start chats here.";

function project(archived = false): Project {
  return {
    id: projectId,
    name: "Launch",
    createdAt,
    updatedAt: createdAt,
    ...(archived ? { archivedAt } : {}),
  };
}

/** Stateful provider fixtures; all mutations enter through typed HTTP mocks. */
function installProjectApi(
  initial: readonly Project[] = [project()],
  options: {
    readonly archiveGate?: Promise<void>;
    readonly restoreGate?: Promise<void>;
    readonly archiveError?: string;
    readonly restoreError?: string;
    readonly events?: ProjectEvent[];
  } = {},
) {
  const events = options.events ?? [];
  const projects = new Map(
    initial.map((item) => {
      return [item.id, item] as const;
    }),
  );
  let archiveError = options.archiveError;
  let restoreError = options.restoreError;
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [...initial],
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
  context.mocks.api(
    projectsContract.archive,
    async ({ params, body, respond }) => {
      await options.archiveGate;
      if (archiveError) {
        const message = archiveError;
        archiveError = undefined;
        return respond(409, { error: { code: "CONFLICT", message } });
      }
      const current = projects.get(params.id);
      if (!current) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Project unavailable" },
        });
      }
      const archived = { ...current, archivedAt };
      projects.set(params.id, archived);
      events.push({
        id: body.eventId,
        seqId: events.length + 2,
        projectId: params.id,
        kind: "archived",
        name: current.name,
        createdAt: archivedAt,
      });
      return respond(200, archived);
    },
  );
  context.mocks.api(
    projectsContract.restore,
    async ({ params, body, respond }) => {
      await options.restoreGate;
      if (restoreError) {
        const message = restoreError;
        restoreError = undefined;
        return respond(409, { error: { code: "CONFLICT", message } });
      }
      const current = projects.get(params.id);
      if (!current) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Project unavailable" },
        });
      }
      const restored = { ...current, archivedAt: null };
      projects.set(params.id, restored);
      events.push({
        id: body.eventId,
        seqId: events.length + 2,
        projectId: params.id,
        kind: "restored",
        name: current.name,
        createdAt: archivedAt,
      });
      return respond(200, restored);
    },
  );
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, textContinuityDraft(""));
  });
  context.mocks.api(agentDraftContract.patch, ({ respond }) => {
    return respond(204);
  });
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

function menuItem(name: string, container: ParentNode = document) {
  const found = queryAllByRoleFast("menuitem", container).find((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      item.textContent?.trim() === name
    );
  });
  if (!found) {
    throw new Error(`Menu item ${name} not found`);
  }
  return found;
}

function projectRow(id = projectId) {
  const row = document.querySelector<HTMLElement>(
    `[data-project-row-id="${id}"]`,
  );
  if (!row) {
    throw new Error("Project row missing");
  }
  return row;
}

function composer() {
  return screen.getByRole("textbox", { name: "Message" });
}

function openProjectMenu(name = "Launch", id = projectId) {
  click(button(`Options for ${name}`, projectRow(id)));
  return screen.findByRole("menu");
}

function menuLabels(menu: HTMLElement) {
  return queryAllByRoleFast("menuitem", menu).map((item) => {
    return item.textContent?.trim() ?? "";
  });
}

function archiveToast() {
  const toast = screen
    .getByText("Project archived")
    .closest<HTMLElement>("[data-sonner-toast]");
  if (!toast) {
    throw new Error("Project archive toast missing");
  }
  return toast;
}

async function selectArchived() {
  click(button("Open chat list menu"));
  const menu = await screen.findByRole("menu");
  click(menuItem("Archived", menu));
  await waitFor(() => {
    expect(projectRow()).toBeInTheDocument();
  });
}

test.each([false, true])(
  "Archiving keeps the Project page and draft mounted; Undo restores the same Project (capabilities: %s)",
  async (capabilities) => {
    const ordinary = continuityThread(341, 1, "Ordinary conversation");
    const workspace = installContinuityWorkspace(context, {
      caseId: 341,
      threads: [ordinary],
    });
    const gate = context.mocks.deferred<void>();
    installProjectApi([project()], { archiveGate: gate.promise });
    await setupPage({
      context,
      path: `/projects/${projectId}`,
      ...workspace.pageOptions,
      featureSwitches: {
        [FeatureSwitchKey.Projects]: true,
        [FeatureSwitchKey.HomeCapabilities]: capabilities,
      },
    });
    await screen.findByRole("textbox", { name: "Message" });
    await fill(composer(), "Keep my unsent launch plan");
    const menu = await openProjectMenu();
    expect(menuItem("Expand", menu)).toHaveAttribute("aria-label", "Expand");
    expect(menuLabels(menu).slice(-3)).toStrictEqual([
      "Rename",
      "Archive project",
      "Delete",
    ]);
    click(menuItem("Archive project", menu));
    try {
      await waitFor(() => {
        expect(button("Options for Launch", projectRow())).toBeDisabled();
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(composer()).toHaveTextContent("Keep my unsent launch plan");
      expect(button("Send")).toBeEnabled();
      expect(location.pathname).toBe(`/projects/${projectId}`);
    } finally {
      gate.resolve();
    }
    await expect(
      screen.findByText("Project archived"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(bannerText)).toBeInTheDocument();
    expect(composer()).toHaveTextContent("Keep my unsent launch plan");
    expect(button("Remove Launch")).toBeInTheDocument();
    expect(location.pathname).toBe(`/projects/${projectId}`);
    expect(button("View archives", archiveToast())).toBeInTheDocument();

    click(button("Undo", archiveToast()));
    await waitFor(() => {
      expect(projectRow()).toBeInTheDocument();
      expect(screen.queryByText(bannerText)).not.toBeInTheDocument();
    });
    expect(composer()).toHaveTextContent("Keep my unsent launch plan");
    expect(button("Remove Launch")).toBeInTheDocument();
    expect(location.pathname).toBe(`/projects/${projectId}`);
  },
);

test("Archive feedback opens the existing Archived filter and its original Restore menu", async () => {
  const ordinary = continuityThread(342, 1, "Ordinary conversation");
  const member = {
    ...continuityThread(342, 2, "Launch conversation"),
    projectId,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 342,
    threads: [ordinary, member],
  });
  installProjectApi();
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const menu = await openProjectMenu();
  click(menuItem("Archive project", menu));
  await screen.findByText("Project archived");
  click(button("View archives", archiveToast()));
  await waitFor(() => {
    expect(projectRow()).toBeInTheDocument();
  });
  const archiveMenu = await openProjectMenu();
  expect(menuLabels(archiveMenu).slice(-3)).toStrictEqual([
    "Rename",
    "Restore project",
    "Delete",
  ]);
  click(menuItem("Restore project", archiveMenu));
  await expect(
    screen.findByText("Project restored"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("A rejected archive leaves the Project visible with its draft and can be retried", async () => {
  const ordinary = continuityThread(343, 1, "Ordinary conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 343,
    threads: [ordinary],
  });
  installProjectApi([project()], {
    archiveError: "Archive is temporarily unavailable",
  });
  await setupPage({
    context,
    path: `/projects/${projectId}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await screen.findByRole("textbox", { name: "Message" });
  await fill(composer(), "Draft survives a rejected archive");
  click(menuItem("Archive project", await openProjectMenu()));
  await expect(
    screen.findByText("Archive is temporarily unavailable"),
  ).resolves.toBeInTheDocument();
  expect(projectRow()).toBeInTheDocument();
  expect(composer()).toHaveTextContent("Draft survives a rejected archive");
  expect(location.pathname).toBe(`/projects/${projectId}`);
  await waitFor(() => {
    expect(button("Options for Launch", projectRow())).toBeEnabled();
  });

  const retryMenu = await openProjectMenu();
  expect(within(retryMenu).getByRole("alert")).toHaveTextContent(
    "Could not archive project. Try again.",
  );
  click(menuItem("Archive project", retryMenu));
  await expect(screen.findByText(bannerText)).resolves.toBeInTheDocument();
  expect(composer()).toHaveTextContent("Draft survives a rejected archive");
});

test("The archived Project banner keeps restore failures retryable and does not replace the draft", async () => {
  const ordinary = continuityThread(344, 1, "Ordinary conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 344,
    threads: [ordinary],
  });
  const gate = context.mocks.deferred<void>();
  installProjectApi([project(true)], {
    restoreGate: gate.promise,
    restoreError: "Restore is temporarily unavailable",
  });
  await setupPage({
    context,
    path: `/projects/${projectId}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await screen.findByText(bannerText);
  await fill(composer(), "Draft in an archived Project");
  click(button("Restore project"));
  try {
    await waitFor(() => {
      expect(button("Restore project")).toBeDisabled();
    });
    expect(composer()).toHaveTextContent("Draft in an archived Project");
    expect(button("Send")).toBeEnabled();
  } finally {
    gate.resolve();
  }
  await expect(
    screen.findByText("Restore is temporarily unavailable"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not restore project. Try again.",
  );
  expect(screen.getByText(bannerText)).toBeInTheDocument();
  await waitFor(() => {
    expect(button("Restore project")).toBeEnabled();
  });

  click(button("Restore project"));
  await expect(
    screen.findByText("Project restored"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(bannerText)).not.toBeInTheDocument();
  expect(projectRow()).toBeInTheDocument();
  expect(composer()).toHaveTextContent("Draft in an archived Project");
  expect(location.pathname).toBe(`/projects/${projectId}`);
});

test("A Project page receives archive and restore lifecycle changes without losing its draft", async () => {
  const ordinary = continuityThread(345, 1, "Ordinary conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 345,
    threads: [ordinary],
  });
  const events: ProjectEvent[] = [];
  installProjectApi([project()], { events });
  await setupPage({
    context,
    path: `/projects/${projectId}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
    sharedWorkerTestTransport: "message-port",
  });
  await screen.findByRole("textbox", { name: "Message" });
  await fill(composer(), "Draft while another tab archives");
  events.push({
    id: crypto.randomUUID(),
    seqId: 2,
    projectId,
    kind: "archived",
    name: "Launch",
    createdAt: archivedAt,
  });
  context.mocks.ably.trigger("threadListChanged");
  await expect(screen.findByText(bannerText)).resolves.toBeInTheDocument();
  expect(composer()).toHaveTextContent("Draft while another tab archives");

  events.push({
    id: crypto.randomUUID(),
    seqId: 3,
    projectId,
    kind: "restored",
    name: "Launch",
    createdAt: archivedAt,
  });
  context.mocks.ably.trigger("threadListChanged");
  await waitFor(() => {
    expect(projectRow()).toBeInTheDocument();
    expect(screen.queryByText(bannerText)).not.toBeInTheDocument();
  });
  expect(composer()).toHaveTextContent("Draft while another tab archives");
  expect(location.pathname).toBe(`/projects/${projectId}`);
});

test("An archived Project mention reveals the original Archived list without leaving the conversation", async () => {
  const ordinary = continuityThread(346, 1, "Current conversation");
  const member = {
    ...continuityThread(346, 2, "Launch conversation"),
    projectId,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 346,
    threads: [ordinary, member],
    chatEventRows: [
      continuityEventRow(346, 1, ordinary.id, "input.prompt", {
        payload: {
          userMessage: {
            version: 1,
            parts: [{ type: "project", projectId, nameSnapshot: "Launch" }],
          },
        },
      }),
    ],
  });
  installProjectApi([project(true)]);
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const mention = await waitFor(() => {
    const message = document.querySelector("[data-structured-user-message]");
    if (!message) {
      throw new Error("Message missing");
    }
    const link = queryAllByRoleFast("link", message).find((item) => {
      return item.textContent?.trim() === "Launch";
    });
    if (!link) {
      throw new Error("Project mention missing");
    }
    return link;
  });
  click(mention);
  await waitFor(() => {
    expect(
      button("Show or hide chats in Launch", projectRow()),
    ).toHaveAttribute("aria-expanded", "true");
  });
  expect(
    document.querySelector(`[data-sidebar-chat-thread-id="${member.id}"]`),
  ).toBeInTheDocument();
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
  expect(
    menuItem("Restore project", await openProjectMenu()),
  ).toBeInTheDocument();
});

test("The archived Project remains the selected composer context but is not offered as a new destination", async () => {
  const ordinary = continuityThread(347, 1, "Ordinary conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 347,
    threads: [ordinary],
  });
  installProjectApi([
    project(true),
    { ...project(), id: researchId, name: "Research" },
  ]);
  await setupPage({
    context,
    path: `/projects/${projectId}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await screen.findByText(bannerText);
  expect(button("Remove Launch")).toBeInTheDocument();
  await fill(composer(), "Still assigned to Launch");
  click(button("Add"));
  const addMenu = await screen.findByRole("menu", { name: "Add" });
  click(menuItem("Project", addMenu));
  const projectMenu = await screen.findByRole("menu", { name: "Project" });
  expect(menuLabels(projectMenu)).toStrictEqual([
    "New Project",
    "Research",
    "Remove from Project",
  ]);
  await userEvent.setup({ delay: null }).keyboard("{Escape}{Escape}");
  expect(composer()).toHaveTextContent("Still assigned to Launch");
  expect(button("Remove Launch")).toBeInTheDocument();
  expect(button("Send")).toBeEnabled();
});

test("The membership picker offers active Projects rather than archived destinations", async () => {
  const ordinary = continuityThread(348, 1, "Ordinary conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 348,
    threads: [ordinary],
  });
  installProjectApi([
    project(true),
    { ...project(), id: researchId, name: "Research" },
  ]);
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const row = await waitFor(() => {
    const item = document.querySelector<HTMLElement>(
      `[data-sidebar-chat-thread-row-id="${ordinary.id}"]`,
    );
    if (!item) {
      throw new Error("Chat row missing");
    }
    return item;
  });
  click(within(row).getByTestId("chat-thread-menu-trigger"));
  const menu = await screen.findByRole("menu");
  click(menuItem("Move to Project", menu));
  const picker = await screen.findByRole("dialog", { name: "Move chat" });
  expect(button("Research", picker)).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", picker).some((item) => {
      return item.textContent?.trim() === "Launch";
    }),
  ).toBeFalsy();
});

test("A new chat can be sent from an archived Project without restoring it", async () => {
  const ordinary = continuityThread(349, 1, "Ordinary conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 349,
    threads: [ordinary],
  });
  installProjectApi([project(true)]);
  let createdThreadId: string | undefined;
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    expect(body.projectId).toBe(projectId);
    createdThreadId = body.clientThreadId;
    return respond(201, {
      id: body.clientThreadId ?? crypto.randomUUID(),
      title: null,
      createdAt,
      selectedModel: body.model ?? null,
      serviceTier: null,
      projectId: body.projectId ?? null,
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    return respond(201, {
      threadId: body.threadId ?? crypto.randomUUID(),
      createdAt,
    });
  });
  await setupPage({
    context,
    path: `/projects/${projectId}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await screen.findByText(bannerText);
  await fill(composer(), "Keep working in this archived Project");
  click(button("Send"));
  await waitFor(() => {
    expect(createdThreadId).toBeDefined();
    expect(location.pathname).toBe(`/chats/${createdThreadId}`);
  });
  await selectArchived();
  expect(
    menuItem("Restore project", await openProjectMenu()),
  ).toBeInTheDocument();
});
