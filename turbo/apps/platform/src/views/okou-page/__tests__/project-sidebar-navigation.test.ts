import {
  projectsContract,
  type ProjectEvent,
} from "@okouai/api-contracts/contracts/projects";
import {
  fireEvent,
  waitFor,
  screen,
  within,
  cleanup,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  setupPage,
  click,
  fill,
  swipeBack,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread, chatListEvent } from "./chat-list-test-helpers.ts";
import {
  installContinuityWorkspace,
  continuityEventRow,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  chatThreadDraftContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import { project } from "./project-editor-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  checkLocation,
  membershipPage,
  drag,
  indicator,
} from "./project-chat-membership-fixtures.ts";

const context = testContext();

const launch = "66666666-0000-4000-8000-000000000019";
const timestamp = "2026-06-02T11:30:00Z";
async function projectWorkspace(start: "outside" | "member" | "home") {
  const planning = chatListThread(4, "Campaign planning", {
    projectId: launch,
  });
  const outside = chatListThread(2, "Other conversation");
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 199,
    threads: [outside, planning],
  });
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [
        {
          id: launch,
          name: "Launch",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      latestEventId: null,
      latestSeqId: 0,
    });
  });
  await setupPage({
    context,
    ...pageOptions,
    path:
      start === "home"
        ? "/projects/" + launch
        : "/chats/" + (start === "member" ? planning.id : outside.id),
  });
  const toggle = await findFastControl("button", /Launch/);
  const home = await findFastControl("link", "New chat in Launch");
  return {
    toggle,
    home,
    outside: "/chats/" + outside.id,
    member: "/chats/" + planning.id,
  };
}
async function fold(toggle: HTMLElement, expanded: boolean) {
  if (toggle.getAttribute("aria-expanded") !== String(expanded)) {
    click(toggle);
  }
  await waitFor(() => {
    expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
  });
}
function member() {
  return queryFastControl("link", "Campaign planning");
}
async function at(path: string) {
  await waitFor(() => {
    expect(location.pathname).toBe(path);
  });
}
async function arrow(direction: "Up" | "Down", expected: string) {
  const composer = await findComposerEditor();
  composer.focus();
  fireEvent.keyDown(composer, {
    key: "Arrow" + direction,
    ctrlKey: true,
    shiftKey: true,
  });
  await at(expected);
}
test("projects-014 The title folds Launch in place and its separate home link preserves the expanded project across Back", async () => {
  const p = await projectWorkspace("outside");
  await fold(p.toggle, false);
  click(p.toggle);
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  expect(location.pathname).toBe(p.outside);
  click(p.toggle);
  await waitFor(() => {
    expect(member()).toBeNull();
  });
  expect(location.pathname).toBe(p.outside);
  click(p.home);
  await at("/projects/" + launch);
  expect(p.home).toHaveAttribute("aria-current", "page");
  await fold(p.toggle, true);
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  swipeBack();
  await at(p.outside);
  expect(p.toggle).toHaveAttribute("aria-expanded", "true");
  expect(member()).toBeVisible();
});
test("projects-015 The title handles Enter and Space without navigating and Tab reaches the project home", async () => {
  const p = await projectWorkspace("member");
  await fold(p.toggle, true);
  const user = userEvent.setup({ delay: null });
  p.toggle.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(p.toggle).toHaveAttribute("aria-expanded", "false");
  });
  expect(location.pathname).toBe(p.member);
  await user.keyboard(" ");
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  expect(location.pathname).toBe(p.member);
  await user.keyboard("{Tab}");
  expect(p.home).toHaveFocus();
  await user.keyboard("{Enter}");
  await at("/projects/" + launch);
  expect(p.toggle).toHaveAttribute("aria-expanded", "true");
});
test("projects-012 Up enters the last visible Project chat and Down returns to the outside conversation", async () => {
  const p = await projectWorkspace("outside");
  await fold(p.toggle, true);
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  await arrow("Up", p.member);
  await arrow("Down", p.outside);
});
test("projects-013 Chat navigation skips a folded project member and returns to its folded Project page", async () => {
  const p = await projectWorkspace("member");
  await fold(p.toggle, false);
  await arrow("Down", p.outside);
  await arrow("Up", "/projects/" + launch);
  expect(p.toggle).toHaveAttribute("aria-expanded", "false");
  expect(member()).toBeNull();
});
test("projects-020 Opening Launch changes where ArrowDown goes from its Project home", async () => {
  const p = await projectWorkspace("home");
  await fold(p.toggle, false);
  await arrow("Down", p.outside);
  await arrow("Up", "/projects/" + launch);
  await fold(p.toggle, true);
  await arrow("Down", p.member);
  await waitFor(() => {
    expect(member()).toHaveAttribute("aria-current", "page");
  });
});
test("projects-021 A nonempty draft protects the Project fold while the empty composer handles both shortcuts", async () => {
  const p = await projectWorkspace("member");
  await fold(p.toggle, true);
  const editor = await findComposerEditor();
  editor.focus();
  const move = (key: string) => {
    fireEvent.keyDown(editor, { key, ctrlKey: true, shiftKey: true });
  };
  move("ArrowLeft");
  await waitFor(() => {
    expect(p.toggle).toHaveAttribute("aria-expanded", "false");
  });
  expect(location.pathname).toBe(p.member);
  move("ArrowRight");
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  await fill(editor, "Draft");
  move("ArrowLeft");
  expect(editor).toHaveTextContent("Draft");
  expect(p.toggle).toHaveAttribute("aria-expanded", "true");
  expect(location.pathname).toBe(p.member);
});

async function workspace(mode: "create" | "drafts" | "mobile" | "mention") {
  const launch = project("Launch"),
    member = chatListThread(28, "Campaign planning", {
      projectId: mode === "create" ? null : launch.id,
    }),
    current = chatListThread(29, "Independent conversation");
  const message = continuityEventRow(789, 1, current.id, "input.prompt", {
    runId: crypto.randomUUID(),
    payload: {
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Look at " },
          { type: "project", projectId: launch.id, nameSnapshot: "Launch" },
        ],
      },
    },
  });
  const ws = installContinuityWorkspace(context, {
    caseId: 789,
    threads: [current, member],
    ...(mode === "mention" ? { chatEventRows: [message] } : {}),
    drafts: new Map([
      [current.id, textContinuityDraft("Conversation-only draft")],
    ]),
  });
  const created = context.mocks.deferred<string>(),
    save = context.mocks.deferred<void>(),
    sent = context.mocks.deferred<string>(),
    thread = context.mocks.deferred<{ id: string; project: string | null }>();
  const projects = mode === "create" ? [] : [launch];
  let createdEvent: ProjectEvent | undefined;
  if (mode === "drafts") {
    mockChatLifecycle(context, {
      threadId: current.id,
      onSendRequest: (body) => {
        return sent.resolve(body.prompt);
      },
    });
    context.mocks.api(chatThreadDraftContract.get, ({ params, respond }) => {
      return respond(
        200,
        textContinuityDraft(
          params.id === current.id ? "Conversation-only draft" : "",
        ),
      );
    });
    context.mocks.api(composerDraftContract.get, ({ respond }) => {
      return respond(200, textContinuityDraft("New conversation draft"));
    });
    context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
      const id = body.clientThreadId!;
      thread.resolve({ id, project: body.projectId ?? null });
      return respond(201, {
        id,
        projectId: body.projectId ?? null,
        title: body.title ?? null,
        createdAt: launch.createdAt,
        selectedModel: body.model ?? null,
        serviceTier: null,
      });
    });
  }
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, { projects, latestSeqId: 0, latestEventId: null });
  });
  context.mocks.api(projectsContract.threads, ({ params, respond }) => {
    return respond(200, {
      threads: member.projectId === params.id ? [member] : [],
      nextAfter: null,
    });
  });
  context.mocks.api(projectsContract.create, async ({ body, respond }) => {
    created.resolve(body.id);
    await save.promise;
    createdEvent = {
      id: body.eventId,
      seqId: 1,
      kind: "created",
      projectId: body.id,
      name: "Campaign confirmed",
      createdAt: launch.createdAt,
    };
    return respond(201, { ...launch, id: body.id, name: createdEvent.name! });
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: createdEvent && query.sinceSeqId < 1 ? [createdEvent] : [],
      hasMore: false,
    });
  });
  if (mode === "create") {
    let moved = false;
    context.mocks.api(
      projectsContract.membership,
      ({ body, params, respond }) => {
        moved = true;
        return respond(200, { threadId: params.id, projectId: body.projectId });
      },
    );
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      return respond(200, {
        events:
          moved && createdEvent && (query.sinceSeqId ?? 0) < 2
            ? [
                chatListEvent(789, 2, "project_updated", member.id, {
                  projectId: createdEvent.projectId,
                }),
              ]
            : [],
        hasMore: false,
      });
    });
  }
  if (mode === "mobile") {
    context.mocks.browser.matchMedia((q) => {
      return q === "(display-mode: standalone)" || q === "(pointer: coarse)";
    });
    context.mocks.browser.userAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    );
  }
  await setupPage({
    context,
    ...ws.pageOptions,
    path:
      mode === "mention"
        ? "/chats/" + current.id
        : mode === "create"
          ? "/chats/" + member.id
          : "/",
  });
  return {
    launch,
    member,
    current,
    created: created.promise,
    save,
    sent: sent.promise,
    thread: thread.promise,
  };
}
function conversation(id: string) {
  return waitFor(() => {
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="/chats/' + id + '"]',
    );
    expect(link).toBeVisible();
    return link!;
  });
}
async function rowMenu(id: string) {
  const link = await conversation(id);
  const row =
    link.closest<HTMLElement>("[data-chat-thread-id]") ??
    link.parentElement!.parentElement!;
  const trigger =
    queryFastControl("button", "Open chat menu", row) ??
    document.querySelector<HTMLElement>(
      '[data-chat-thread-id="' + id + '"] button[aria-label="Open chat menu"]',
    );
  expect(trigger).toBeVisible();
  click(trigger!);
  click(await screen.findByText("Move to Project", { exact: true }));
}
test("projects-028 Creating Campaign on a conversation keeps exactly one membership across navigation and project confirmation", async () => {
  const w = await workspace("create");
  await rowMenu(w.member.id);
  click(await findFastControl("button", "Create a Project from this chat"));
  const dialog = await screen.findByRole("dialog", { name: "Create Project" });
  await fill(within(dialog).getByRole("textbox"), "Campaign");
  click(await findFastControl("button", "Save", dialog));
  const id = await w.created;
  await findFastControl("button", "Show or hide chats in Campaign");
  checkLocation(w.member.title!, id);
  click(await conversation(w.current.id));
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + w.current.id);
  });
  checkLocation(w.member.title!, id);
  w.save.resolve();
  await findFastControl("button", "Show or hide chats in Campaign confirmed");
  checkLocation(w.member.title!, id);
  expect(
    document.querySelectorAll('a[href="/chats/' + w.member.id + '"]'),
  ).toHaveLength(1);
  expect(location.pathname).toBe("/chats/" + w.current.id);
});
test("projects-040 Home and Launch share the new-chat draft, existing threads keep theirs and a Project submission opens in Launch", async () => {
  const w = await workspace("drafts");
  await waitFor(async () => {
    return await expect(findComposerEditor()).resolves.toHaveTextContent(
      "New conversation draft",
    );
  });
  const folder = () => {
    return findFastControl("link", "New chat in Launch");
  };
  click(await folder());
  await screen.findByLabelText("Remove Launch");
  await expect(findComposerEditor()).resolves.toHaveTextContent(
    "New conversation draft",
  );
  click(await conversation(w.current.id));
  await waitFor(async () => {
    return await expect(findComposerEditor()).resolves.toHaveTextContent(
      "Conversation-only draft",
    );
  });
  click(await findFastControl("link", "Okou"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  expect(screen.queryByLabelText("Remove Launch")).toBeNull();
  click(await folder());
  await screen.findByLabelText("Remove Launch");
  const editor = await findComposerEditor();
  await fill(editor, "Continue the campaign");
  const submit = await findFastControl("button", "Send");
  await waitFor(() => {
    return expect(submit).toBeEnabled();
  });
  click(submit);
  const result = await w.thread;
  expect(result.project).toBe(w.launch.id);
  await expect(w.sent).resolves.toBe("Continue the campaign");
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + result.id);
  });
  await screen.findByText("Continue the campaign");
});
test("projects-056 The PWA Project chooser is a searchable bottom sheet and its dismissed member still opens for composing", async () => {
  const w = await workspace("mobile");
  await conversation(w.current.id);
  const toggle = await findFastControl(
    "button",
    "Show or hide chats in Launch",
  );
  if (toggle.getAttribute("aria-expanded") !== "true") {
    click(toggle);
  }
  await rowMenu(w.member.id);
  const sheet = await screen.findByRole("dialog", { name: "Move chat" });
  await expect(
    within(sheet).findByRole("textbox", { name: /Search projects/ }),
  ).resolves.toBeVisible();
  expect(
    sheet.closest('[data-slot="drawer-content"]') ??
      sheet.querySelector('[data-slot="drawer-content"]'),
  ).not.toBeNull();
  await expect(
    findFastControl("button", "Launch", sheet),
  ).resolves.toBeDisabled();
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(sheet).not.toBeInTheDocument();
  });
  click(await findFastControl("link", w.member.title!));
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + w.member.id);
  });
  await expect(findComposerEditor()).resolves.toBeVisible();
});
test("projects-057 A Project mention reveals the hidden list at Launch while the reader stays in the original conversation", async () => {
  const w = await workspace("mention");
  const mention = await waitFor(() => {
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a[href="/projects/' + w.launch.id + '"]',
      ),
    );
    const el = anchors.find((a) => {
      return a.parentElement?.textContent?.includes("Look at");
    });
    expect(el).toBeVisible();
    return el!;
  });
  const toggle = await findFastControl(
    "button",
    "Show or hide chats in Launch",
  );
  if (toggle.getAttribute("aria-expanded") === "true") {
    click(toggle);
  }
  click(await findFastControl("button", "Hide chat list"));
  await findFastControl("button", "Show chat list");
  click(mention);
  await expect(
    findFastControl("button", "Hide chat list"),
  ).resolves.toBeVisible();
  await expect(
    findFastControl("button", "Show or hide chats in Launch"),
  ).resolves.toHaveAttribute("aria-expanded", "true");
  await expect(findFastControl("link", w.member.title!)).resolves.toBeVisible();
  expect(location.pathname).toBe("/chats/" + w.current.id);
});

const moves = [
  { id: "projects-032", moving: "outside", action: "Move to Launch" },
  { id: "projects-033", moving: "member", action: "Remove from Project" },
] as const;

test.each(moves)(
  "$id Dropping a chat on another row shows $action and applies that membership before and after confirmation",
  async ({ moving, action }) => {
    const state = await membershipPage(context, moving);
    const toProject = moving === "outside",
      source = toProject ? state.outside : state.member,
      target = toProject ? state.member : state.outside;
    const dest = toProject ? state.launch.id : null;
    const transfer = await drag(source.title!, target.title!);
    const hint = await indicator(action);
    transfer.drop();
    await state.received;
    await waitFor(() => {
      checkLocation(source.title!, dest);
      expect(hint).not.toBeInTheDocument();
    });
    expect(location.pathname).toBe(state.path);
    await state.fold("Launch", false);
    expect(Boolean(queryFastControl("link", source.title!))).toBe(!toProject);
    await state.fold("Launch", true);
    state.save.resolve();
    const confirmed = source.title + " confirmed";
    await findFastControl("link", confirmed);
    checkLocation(confirmed, dest);
    expect(location.pathname).toBe(state.path);
    expect(state.requests).toStrictEqual([{ chat: source.id, project: dest }]);
  },
);

test("projects-036 Escape cancels the move and neither existing membership nor an external URL becomes an accepted drop", async () => {
  const state = await membershipPage(context);
  const folder = "Show or hide chats in Launch";
  const attempt = await drag(state.outside.title!, folder, "button");
  const hint = await indicator("Move to Launch");
  fireEvent.keyDown(attempt.from, { key: "Escape" });
  await waitFor(() => {
    return expect(hint).not.toBeInTheDocument();
  });
  attempt.drop();
  checkLocation(state.outside.title!, null);
  const own = await drag(state.member.title!, folder, "button");
  expect(screen.queryByRole("tooltip")).toBeNull();
  own.drop();
  fireEvent.dragEnd(own.from, { dataTransfer: own.data });
  const outside = new DataTransfer();
  outside.setData("text/uri-list", "https://external.example");
  fireEvent.dragOver(own.to, { dataTransfer: outside });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.drop(own.to, { dataTransfer: outside });
  checkLocation(state.member.title!, state.launch.id);
  expect(state.requests).toStrictEqual([]);
  expect(location.pathname).toBe(state.path);
});

test("projects-006 Both Project fold choices survive a full App replacement under the same signed-in member", async () => {
  const first = createTestRuntime(context);
  const ws = await membershipPage(first);
  await ws.fold("Research", false);
  await ws.fold("Launch", false);
  await ws.fold("Research", true);
  await findFastControl("link", ws.review.title!);
  expect(queryFastControl("link", ws.member.title!)).toBeNull();
  cleanup();
  if (vi.isMockFunction(history.replaceState)) {
    vi.mocked(history.replaceState).mockRestore();
  }
  const next = createTestRuntime(context);
  await setupPage({ context: next, ...ws.pageOptions, path: ws.path });
  first.dispose();
  await expect(
    findFastControl("button", "Show or hide chats in Launch"),
  ).resolves.toHaveAttribute("aria-expanded", "false");
  await expect(
    findFastControl("button", "Show or hide chats in Research"),
  ).resolves.toHaveAttribute("aria-expanded", "true");
  expect(queryFastControl("link", ws.member.title!)).toBeNull();
  await expect(
    findFastControl("link", ws.review.title!),
  ).resolves.toBeVisible();
});

test("projects-003 An expanded Project and its planning chat remain visible while a pending refresh spans navigation Home and a server rename", async () => {
  const ws = await membershipPage(context),
    begun = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  const changed: ProjectEvent = {
    kind: "renamed",
    name: "Launch updated",
    projectId: ws.launch.id,
    id: crypto.randomUUID(),
    seqId: 1,
    createdAt: "2026-08-21T00:00:00Z",
  };
  context.mocks.api(projectsContract.events, async ({ query, respond }) => {
    begun.resolve();
    await release.promise;
    return respond(200, {
      events: query.sinceSeqId < 1 ? [changed] : [],
      hasMore: false,
    });
  });
  const owner = ws.pageOptions.auth!;
  context.mocks.ably.triggerOnChannel(
    "user-org:" + owner.user.id + ":" + owner.organization!.activeOrg!.id,
    "threadListChanged",
  );
  await begun.promise;
  checkLocation(ws.member.title!, ws.launch.id);
  click(await findFastControl("link", "Okou"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  await expect(
    findFastControl("button", "Show or hide chats in Launch"),
  ).resolves.toBeVisible();
  checkLocation(ws.member.title!, ws.launch.id);
  release.resolve();
  await expect(
    findFastControl("button", "Show or hide chats in Launch updated"),
  ).resolves.toHaveAttribute("aria-expanded", "true");
  checkLocation(ws.member.title!, ws.launch.id);
});

test("projects-026 Deleting a Project closes the dialog before membership sync returns and leaves the former member in the ordinary chat list", async () => {
  const ws = await membershipPage(context),
    sync = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  let removed: ProjectEvent | undefined;
  context.mocks.api(projectsContract.delete, ({ body, params, respond }) => {
    removed = {
      id: body.eventId,
      seqId: 1,
      kind: "deleted",
      name: null,
      projectId: params.id,
      createdAt: "2026-08-21T11:00:00Z",
    };
    return respond(204);
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: removed && query.sinceSeqId === 0 ? [removed] : [],
      hasMore: false,
    });
  });
  context.mocks.api(chatThreadsContract.events, async ({ query, respond }) => {
    if (!removed) {
      return respond(200, { events: [], hasMore: false });
    }
    sync.resolve();
    await release.promise;
    const events = [
      chatListEvent(482, 2, "project_updated", ws.member.id, {
        projectId: null,
      }),
      chatListEvent(482, 3, "renamed", ws.member.id, {
        title: "Planning outside Launch",
      }),
    ];
    return respond(200, {
      events: events.filter((e) => {
        return e.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  click(await findFastControl("button", "Options for Launch"));
  click(await screen.findByText("Delete", { exact: true }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  click(await findFastControl("button", "Delete project only", dialog));
  await sync.promise;
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(queryFastControl("button", "Show or hide chats in Launch")).toBeNull();
  expect(location.pathname).toBe(ws.path);
  release.resolve();
  await findFastControl("link", "Planning outside Launch");
  checkLocation("Planning outside Launch", null);
  expect(location.pathname).toBe(ws.path);
});
