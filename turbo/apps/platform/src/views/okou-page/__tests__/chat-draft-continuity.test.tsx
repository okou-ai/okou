import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { presentationPreferenceContextPart } from "@okouai/api-contracts/contracts/presentation-preference-context";
import {
  chatThreadDraftContract,
  chatThreadRenameContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  startPage,
  click,
  fill,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  continuityAttachment,
  continuityDraft,
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
  textContinuityDraft,
  draftPlainText,
} from "./chat-continuity-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  chatListEvent,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import {
  composerDraftContract,
  type ComposerDraftResponse,
} from "@okouai/api-contracts/contracts/composer-draft";
import { findAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();

test("chat-continuity-drafts-004 returning from a neighboring chat restores the unsent checklist", async () => {
  const first = continuityThread(761, 1, "Launch checklist"),
    next = continuityThread(761, 2, "Design notes");
  const workspace = installContinuityWorkspace(context, {
    caseId: 761,
    threads: [first, next],
  });
  await setupPage({
    context,
    path: "/chats/" + first.id,
    ...workspace.pageOptions,
  });
  const draft = await findComposerEditor();
  await fill(draft, "Unsent launch checklist");
  click(continuitySidebarLink(next.id));
  await waitFor(() => {
    expect(location.pathname).toBe("/chats/" + next.id);
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Design notes",
    );
  });
  await expect(findComposerEditor()).resolves.not.toHaveTextContent(
    "Unsent launch checklist",
  );
  click(continuitySidebarLink(first.id));
  await waitFor(() => {
    return expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toHaveTextContent("Unsent launch checklist");
  });
});
test("chat-continuity-drafts-003 removing one restored attachment preserves the ordered draft and reference", async () => {
  const first = continuityThread(763, 1, "Release planning"),
    reference = continuityThread(763, 2, "Research notes");
  const file = continuityAttachment(763, 1, "launch-research.txt");
  const parts: Parameters<typeof continuityDraft>[0] = [
    {
      type: "text",
      text: "Opening paragraph\n# Presentation Output Preference\nKeep this heading in the brief.",
    },
    {
      type: "chat_thread",
      threadId: reference.id,
      titleSnapshot: reference.title!,
    },
    {
      type: "template",
      titleSnapshot: "Deck style",
      template: {
        type: "presentation",
        selection: { templateId: "planning", outputFormat: "html" },
      },
    },
    {
      type: "feedback",
      quote: "The opportunity",
      note: [
        { type: "text", text: "Keep this context" },
        {
          type: "template",
          titleSnapshot: "Review style",
          template: {
            type: "presentation",
            selection: { templateId: "planning", outputFormat: "pptx" },
          },
        },
      ],
    },
    {
      type: "file",
      fileId: file.id,
      filenameSnapshot: file.filename,
      contentType: file.contentType,
    },
  ];
  const workspace = installContinuityWorkspace(context, {
    caseId: 763,
    threads: [first, reference],
    drafts: new Map([
      [
        first.id,
        continuityDraft(
          [
            presentationPreferenceContextPart({ format: "pptx" }),
            {
              type: "additional_info",
              text: "# Presentation Output Preference\nSaved default from the copied input.",
            },
            ...parts,
          ],
          [file],
        ),
      ],
    ]),
  });
  await setupPage({
    context,
    path: "/chats/" + first.id,
    ...workspace.pageOptions,
  });
  click(await findFastControl("button", "Remove launch-research.txt"));
  const editor = await findComposerEditor();
  expect(editor.textContent).toMatch(
    /Opening paragraph.*Presentation Output Preference.*Keep this heading in the brief.*Research notes.*Deck style.*The opportunity.*Keep this context.*Review style/s,
  );
  await waitFor(() => {
    return expect(
      workspace.draftPatches.at(-1)?.draftUserMessage?.parts,
    ).toStrictEqual([parts[0], parts[1], parts[2], parts[3]]);
  });
  expect(queryFastControl("button", "Remove launch-research.txt")).toBeNull();
});
test("chat-continuity-drafts-007 sending the revised brief clears the saved draft and uses only its new attachment", async () => {
  const first = continuityThread(764, 1, "Release brief"),
    old = continuityAttachment(764, 1, "outdated-brief.txt"),
    fresh = continuityAttachment(764, 2, "latest-brief.txt");
  const sent = context.mocks.deferred<unknown>();
  mockChatLifecycle(context, {
    threadId: first.id,
    onSendRequest: (b) => {
      return sent.resolve(b);
    },
  });
  const workspace = installContinuityWorkspace(context, {
    caseId: 764,
    threads: [first],
    drafts: new Map([
      [first.id, textContinuityDraft("Original release brief", [old])],
    ]),
  });
  context.mocks.upload.success(fresh);
  await setupPage({
    context,
    path: "/chats/" + first.id,
    ...workspace.pageOptions,
  });
  click(await findFastControl("button", "Remove outdated-brief.txt"));
  await fill(await findComposerEditor(), "Revised release brief");
  const input = document.querySelector<HTMLInputElement>(
    "input[type=file][multiple]",
  )!;
  await userEvent.upload(
    input,
    new File(["release"], fresh.filename, { type: "text/plain" }),
  );
  await findFastControl("button", "Remove latest-brief.txt");
  click(await findFastControl("button", "Send"));
  const body = await sent.promise;
  expect(body).toMatchObject({
    prompt: "Revised release brief",
    userMessage: {
      parts: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "Revised release brief",
        }),
        expect.objectContaining({ type: "file", fileId: fresh.id }),
      ]),
    },
  });
  expect(JSON.stringify(body)).not.toContain(old.id);
  const message = await screen.findByText("Revised release brief", {
    selector: "[data-role=user] *",
  });
  expect(message.closest("[data-role=user]")).toHaveTextContent(fresh.filename);
  expect(screen.queryByText(old.filename)).toBeNull();
  await waitFor(() => {
    return expect(workspace.draftPatches.at(-1)).toMatchObject({
      threadId: first.id,
      draftUserMessage: null,
      draftAttachments: null,
    });
  });
  expect((await findComposerEditor()).textContent).toBe("");
});

async function openDelayedDraft() {
  const thread = continuityThread(883, 1, "Two versions of a draft");
  const attachment = continuityAttachment(883, 1, "older-notes.txt");
  const saved = textContinuityDraft("Older server draft", [attachment]);
  const receive = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const answered = context.mocks.deferred<void>();
  const workspace = installContinuityWorkspace(context, {
    caseId: 883,
    threads: [thread],
  });
  context.mocks.api(
    chatThreadDraftContract.get,
    async ({ params, respond }) => {
      expect(params.id).toBe(thread.id);
      if (!receive.settled()) {
        receive.resolve();
      }
      await release.promise;
      if (!answered.settled()) {
        answered.resolve();
      }
      return respond(200, saved);
    },
  );
  const page = await startPage({
    context,
    path: "/chats/" + thread.id,
    ...workspace.pageOptions,
  });
  await page.content;
  const editor = await findComposerEditor();
  await receive.promise;
  return { editor, workspace, release, answered };
}
test("chat-continuity-drafts-002 an untouched composer restores both the delayed server text and file", async () => {
  const { editor, release } = await openDelayedDraft();
  release.resolve();
  await findFastControl("button", "Remove older-notes.txt");
  expect(editor).toHaveTextContent("Older server draft");
});
test.each(["delivered", "withheld"] as const)(
  "chat-continuity-drafts-002 saved text and file restoration with the older response %s",
  async (variant) => {
    const { editor, workspace, release, answered } = await openDelayedDraft();
    try {
      const fresh = "Fresh work typed locally";
      await fill(editor, fresh);
      if (variant === "delivered") {
        release.resolve();
        await answered.promise;
      }
      expect(editor.textContent).toBe(fresh);
      // Finish an ordinary editor interaction before reading the persisted document.
      await userEvent.setup({ delay: null }).paste("!");
      await waitFor(() => {
        expect(
          workspace.draftPatches.at(-1)?.draftUserMessage?.parts,
        ).toStrictEqual([{ type: "text", text: fresh + "!" }]);
      });
      expect(editor.textContent).toBe(fresh + "!");
      expect(queryFastControl("button", "Remove older-notes.txt")).toBeNull();
      expect(screen.queryByText("Older server draft")).toBeNull();
    } finally {
      if (!release.settled()) {
        release.resolve();
      }
    }
  },
);

async function splitWorkspace() {
  const main = continuityThread(310, 2, "Project plan");
  const side = continuityThread(310, 1, "❓");
  const newer = continuityThread(310, 3, "Release checklist");
  const threads = [newer, main, side];
  const drafts = new Map(
    threads.map((t) => {
      return [t.id, textContinuityDraft("Draft for " + t.title)];
    }),
  );
  const workspace = installContinuityWorkspace(context, {
    caseId: 310,
    threads,
    drafts,
  });
  const renames: ReturnType<typeof chatListEvent>[] = [];
  const stream = installChatListStream(context, {
    caseId: 310,
    snapshot: threads,
    events: renames,
  });
  context.mocks.api(
    chatThreadRenameContract.rename,
    ({ body, params, respond }) => {
      renames.push(
        chatListEvent(310, renames.length + 2, "renamed", params.id, {
          id: body.eventId,
          title: body.title,
        }),
      );
      stream.setEvents(renames);
      return respond(204);
    },
  );
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: "/chats/" + main.id + "?sidebar=" + side.id,
  });
  const sideText = await screen.findByText("Draft for ❓");
  const sidePane = sideText.closest<HTMLElement>(
    "[data-chat-thread-container-id]",
  )!;
  const editor = (
    await screen.findByText("Draft for Project plan")
  ).closest<HTMLElement>('[contenteditable="true"]')!;
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  return { main, side, newer, user, sidePane };
}
test("chat-continuity-keyboard-001 moves the focused main conversation to its newer neighbor", async () => {
  const { newer, side, user, sidePane } = await splitWorkspace();
  await user.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");
  await screen.findByText("Draft for Release checklist");
  expect(location.pathname).toBe("/chats/" + newer.id);
  expect(new URL(location.href).searchParams.get("sidebar")).toBe(side.id);
  expect(within(sidePane).getByText("Draft for ❓")).toBeVisible();
});
test("chat-continuity-keyboard-002 sets and clears the main chat icon from its composer", async () => {
  const { main, user } = await splitWorkspace();
  for (const [key, title] of [
    ["[Digit1]", "✅ Project plan"],
    ["[Digit0]", "Project plan"],
  ] as const) {
    await user.keyboard("{Control>}{Shift>}" + key + "{/Shift}{/Control}");
    await waitFor(() => {
      expect(
        continuitySidebarLink(main.id)
          .querySelector('[data-slot="sidebar-thread-title"]')
          ?.textContent?.trim(),
      ).toBe(title);
    });
    expect(screen.queryByLabelText("Search emoji")).toBeNull();
  }
});

async function newChat() {
  let server: ComposerDraftResponse = {
    draftUserMessage: null,
    draftAttachments: null,
  };
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, server);
  });
  context.mocks.api(composerDraftContract.patch, ({ body, respond }) => {
    server = {
      draftUserMessage: body.draftUserMessage,
      draftAttachments: body.draftAttachments ?? null,
    };
    return respond(204);
  });
  await setupPage({ context, path: "/" });
  return {
    editor: await findComposerEditor(),
    saved: () => {
      return server;
    },
  };
}
test("chat-whitespace-drafts-003 meaningful whitespace is preserved until the member clears the draft", async () => {
  const { editor, saved } = await newChat();
  const text = "  Harbor briefing\n\n    Third line";
  await fill(editor, text);
  await waitFor(() => {
    expect(draftPlainText(saved().draftUserMessage)).toBe(text);
  });
  await fill(editor, "  \t");
  await userEvent.keyboard("{Shift>}{Enter}{Enter}{/Shift}");
  await waitFor(() => {
    expect(saved()).toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
  });
  expect(editor).not.toHaveTextContent("Harbor briefing");
});
test("chat-whitespace-drafts-005 a pasted space retains the attached file and the link to the other chat", async () => {
  const one = continuityThread(508, 1, "Port decisions"),
    other = continuityThread(508, 2, "Shipping notes"),
    file = continuityAttachment(508, 1, "manifest.txt");
  const reference = {
    type: "chat_thread" as const,
    threadId: other.id,
    titleSnapshot: "Shipping notes",
  };
  const item = {
    type: "file" as const,
    fileId: file.id,
    filenameSnapshot: file.filename,
    contentType: file.contentType,
  };
  const draft = continuityDraft(
    [{ type: "text", text: " " }, reference, item],
    [file],
  );
  const api = installContinuityWorkspace(context, {
    caseId: 508,
    threads: [one, other],
    drafts: new Map([[one.id, draft]]),
  });
  await setupPage({ context, path: "/chats/" + one.id, ...api.pageOptions });
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor).toHaveTextContent("Shipping notes");
  });
  await screen.findByText("manifest.txt");
  const user = userEvent.setup();
  await user.click(editor);
  await user.paste(" ");
  await waitFor(() => {
    const update = api.draftPatches
      .filter((p) => {
        return p.threadId === one.id;
      })
      .at(-1);
    expect(update?.draftUserMessage?.parts).toStrictEqual(
      expect.arrayContaining([reference, item]),
    );
    expect(update?.draftAttachments).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: file.id, filename: "manifest.txt" }),
      ]),
    );
  });
  expect(editor).toHaveTextContent("Shipping notes");
  expect(screen.getByText("manifest.txt")).toBeInTheDocument();
});

test("The member workspace saves a blank draft after whitespace-only input", async () => {
  const saved = context.mocks.deferred<ComposerDraftResponse>();
  const blank = { draftUserMessage: null, draftAttachments: null };
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, blank);
  });
  context.mocks.api(composerDraftContract.patch, ({ body, respond }) => {
    saved.resolve({
      draftUserMessage: body.draftUserMessage,
      draftAttachments: body.draftAttachments ?? null,
    });
    return respond(204);
  });
  await setupPage({ context, path: "/" });
  const editor = await findComposerEditor();
  expect(editor.textContent).toBe("");
  await fill(editor, "  \t ");
  await expect(saved.promise).resolves.toStrictEqual(blank);
  await expect(findAction("button", "Send")).resolves.toBeDisabled();
});

test.each(["deliver", "withhold"] as const)(
  "The edited draft stays visible when the cancelled save is set to %s",
  async (delivery) => {
    const prior = context.mocks.deferred<AbortSignal>();
    const finish = context.mocks.deferred<void>();
    const boundary = context.mocks.deferred<boolean>();
    const saved = context.mocks.deferred<string>();
    context.mocks.api(
      composerDraftContract.patch,
      async ({ body, request, respond }) => {
        const content = draftPlainText(body.draftUserMessage);
        if (content === "old" && !prior.settled()) {
          prior.resolve(request.signal);
          await finish.promise;
          boundary.resolve(request.signal.aborted);
        }
        if (content === "new" && !saved.settled()) {
          saved.resolve(content);
        }
        return respond(204);
      },
    );
    await setupPage({ context, path: "/" });
    const editor = await findComposerEditor();
    await fill(editor, "old");
    const signal = await prior.promise;
    await fill(editor, "new");
    await expect(saved.promise).resolves.toBe("new");
    expect(signal.aborted).toBeTruthy();
    if (delivery === "deliver") {
      finish.resolve();
      await boundary.promise;
    }
    expect(boundary.settled()).toBe(delivery === "deliver");
    expect(editor).toHaveTextContent("new");
    if (!finish.settled()) {
      finish.resolve();
    }
  },
);
