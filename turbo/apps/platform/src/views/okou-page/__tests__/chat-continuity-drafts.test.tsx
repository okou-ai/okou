import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
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
} from "./chat-continuity-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

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
    { type: "text", text: "Opening paragraph" },
    {
      type: "chat_thread",
      threadId: reference.id,
      titleSnapshot: reference.title!,
    },
    {
      type: "template",
      titleSnapshot: "Deck style",
      template: { type: "presentation", selection: { templateId: "planning" } },
    },
    {
      type: "feedback",
      quote: "The opportunity",
      note: [{ type: "text", text: "Keep this context" }],
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
    drafts: new Map([[first.id, continuityDraft([...parts], [file])]]),
  });
  await setupPage({
    context,
    path: "/chats/" + first.id,
    ...workspace.pageOptions,
  });
  click(await findFastControl("button", "Remove launch-research.txt"));
  const editor = await findComposerEditor();
  expect(editor.textContent).toMatch(
    /Opening paragraph.*Research notes.*Deck style.*The opportunity.*Keep this context/s,
  );
  await waitFor(() => {
    return expect(
      workspace.draftPatches.at(-1)?.draftUserMessage?.parts,
    ).toStrictEqual(expect.arrayContaining([parts[0], parts[1], parts[3]]));
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
