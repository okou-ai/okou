import {
  projectsContract,
  type ProjectEvent,
} from "@okouai/api-contracts/contracts/projects";
import {
  chatThreadDraftContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread, chatListEvent } from "./chat-list-test-helpers.ts";
import {
  continuityEventRow,
  installContinuityWorkspace,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";
import { project } from "./project-editor-fixtures.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { checkLocation } from "./project-chat-membership-fixtures.ts";
const context = testContext();
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
  click(await findFastControl("link", "Chat"));
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
