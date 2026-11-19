import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityAttachment,
  continuityDraft,
  continuitySidebarLink,
  continuityThread,
  draftPlainText,
  installContinuityWorkspace,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";
import {
  chatListAuth,
  fastButton,
  installActiveChatBoundaries,
  installChatListAgent,
  installChatListRunModels,
  installChatListStream,
} from "./chat-list-test-helpers.ts";

const context = testContext();

async function messageComposer(): Promise<HTMLElement> {
  const composer = await waitFor(currentMessageComposer);
  expect(composer).toHaveAccessibleName("Message");
  return composer;
}

function currentMessageComposer(): HTMLElement {
  const composer = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="textbox"][aria-label="Message"]',
    ),
  ).find((candidate) => {
    return !candidate.closest('[aria-hidden="true"], [hidden], [inert]');
  });
  if (!composer) {
    throw new Error("Expected the message composer");
  }
  return composer;
}

async function openConversation(threadId: string): Promise<void> {
  await waitFor(() => {
    expect(continuitySidebarLink(threadId)).toBeVisible();
  });
  const link = continuitySidebarLink(threadId);
  click(link);
  await waitFor(() => {
    expect(continuitySidebarLink(threadId)).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      document.querySelector(`[data-chat-thread-container-id="${threadId}"]`),
    ).toBeVisible();
  });
}

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected the composer file input");
  }
  return input;
}

test("Text typed while a saved draft loads is kept over the older draft", async () => {
  const auth = chatListAuth(302);
  const delayedDraft = context.mocks.deferred<void>();
  const oldAttachment = continuityAttachment(2, 1, "older-notes.txt");
  let draftResponseCompleted = false;
  installChatListAgent(context);
  installChatListRunModels(context);
  installChatListStream(context, { caseId: 2, snapshot: [] });
  installActiveChatBoundaries(context);
  context.mocks.api(agentDraftContract.get, async ({ respond }) => {
    await delayedDraft.promise;
    draftResponseCompleted = true;
    return respond(
      200,
      textContinuityDraft("Older server draft", [oldAttachment]),
    );
  });
  context.mocks.api(agentDraftContract.patch, ({ respond }) => {
    return respond(204);
  });

  const page = await startPage({
    context,
    path: "/agents/c7000000-0000-4000-a000-000000000001/chat",
    auth,
  });

  const composer = await messageComposer();
  await userEvent.type(composer, "Fresh work typed locally");
  expect(composer).toHaveTextContent("Fresh work typed locally");
  delayedDraft.resolve();
  await page.ready;

  await waitFor(() => {
    expect(draftResponseCompleted).toBeTruthy();
  });
  expect(currentMessageComposer()).toHaveTextContent(
    "Fresh work typed locally",
  );
  expect(currentMessageComposer()).not.toHaveTextContent("Older server draft");
  expect(document.body).not.toHaveTextContent("older-notes.txt");
});

test("Removing an attachment from a restored rich draft keeps its other content", async () => {
  const thread = continuityThread(3, 1, "Rich draft conversation");
  const referenced = continuityThread(3, 2, "Referenced launch chat");
  const attachment = continuityAttachment(3, 1, "launch-research.txt");
  const draft = continuityDraft(
    [
      { type: "text", text: "Draft opening paragraph" },
      {
        type: "chat_thread",
        threadId: referenced.id,
        titleSnapshot: referenced.title ?? "Referenced launch chat",
      },
      {
        type: "template",
        titleSnapshot: "Launch presentation",
        template: {
          type: "presentation",
          selection: { templateId: "launch-grid" },
        },
      },
      {
        type: "feedback",
        quote: "Preserve the launch date",
        note: [{ type: "text", text: "Check the final milestone" }],
      },
      {
        type: "file",
        fileId: attachment.id,
        filenameSnapshot: attachment.filename,
        contentType: attachment.contentType,
      },
    ],
    [attachment],
  );
  const workspace = installContinuityWorkspace(context, {
    caseId: 3,
    threads: [thread, referenced],
    drafts: new Map([[thread.id, draft]]),
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await messageComposer();
  await waitFor(() => {
    expect(composer).toHaveTextContent("Draft opening paragraph");
    expect(fastButton("Remove launch-research.txt")).toBeVisible();
  });

  await userEvent.click(fastButton("Remove launch-research.txt"));
  const saved = await waitFor(() => {
    const patch = workspace.draftPatches.find((candidate) => {
      return (
        candidate.threadId === thread.id && candidate.draftAttachments === null
      );
    });
    if (!patch) {
      throw new Error("Expected the saved draft without its attachment");
    }
    return patch;
  });
  expect(document.body).not.toHaveTextContent("launch-research.txt");
  const restoredText = composer.textContent ?? "";
  const order = [
    "Draft opening paragraph",
    "Referenced launch chat",
    "Launch presentation",
    "Preserve the launch date",
    "Check the final milestone",
  ].map((text) => {
    return restoredText.indexOf(text);
  });
  expect(order).not.toContain(-1);
  expect(
    [...order].sort((left, right) => {
      return left - right;
    }),
  ).toStrictEqual(order);
  expect(draftPlainText(saved.draftUserMessage)).toContain(
    "Draft opening paragraph",
  );
  expect(saved.draftUserMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "chat_thread",
        threadId: referenced.id,
      }),
      expect.objectContaining({
        type: "feedback",
        quote: "Preserve the launch date",
        note: [{ type: "text", text: "Check the final milestone" }],
      }),
    ]),
  );
});

test("A typed draft is restored after visiting a neighboring conversation", async () => {
  const target = continuityThread(4, 1, "Draft persistence target");
  const neighbor = continuityThread(4, 2, "Draft persistence neighbor");
  const workspace = installContinuityWorkspace(context, {
    caseId: 4,
    threads: [target, neighbor],
  });
  await setupPage({
    context,
    path: `/chats/${target.id}`,
    ...workspace.pageOptions,
  });
  await fill(await messageComposer(), "Unsent launch checklist");
  // Readiness only: let the draft save before leaving the conversation.
  await waitFor(() => {
    const saved = workspace.draftPatches.some((patch) => {
      return draftPlainText(patch.draftUserMessage).includes(
        "Unsent launch checklist",
      );
    });
    if (!saved) {
      throw new Error("Waiting for the draft save");
    }
  });

  await openConversation(neighbor.id);
  await openConversation(target.id);
  await waitFor(() => {
    expect(currentMessageComposer()).toHaveTextContent(
      "Unsent launch checklist",
    );
  });
});

test("Sending a revised restored draft sends only its current text and attachment", async () => {
  const thread = continuityThread(5, 1, "Draft ready to send");
  const originalAttachment = continuityAttachment(5, 1, "outdated-brief.txt");
  const workspace = installContinuityWorkspace(context, {
    caseId: 5,
    threads: [thread],
    drafts: new Map([
      [
        thread.id,
        textContinuityDraft("Original release brief", [originalAttachment]),
      ],
    ]),
  });
  const freshFile = new File(["latest brief"], "latest-brief.txt", {
    type: "text/plain",
  });
  context.mocks.upload.success({
    id: "f7000000-0000-4000-a000-000000000501",
    filename: freshFile.name,
    contentType: freshFile.type,
    size: freshFile.size,
    url: "https://cdn.vm7.io/chat-continuity/5/latest-brief.txt",
  });
  let sentPrompt: string | undefined;
  let sentAttachmentNames: string[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (body.userMessage === undefined) {
      throw new Error("Expected a user message send");
    }
    sentPrompt = body.prompt;
    sentAttachmentNames = body.userMessage.parts.flatMap((part) => {
      return part.type === "file" ? [part.filenameSnapshot] : [];
    });
    return respond(201, {
      threadId: body.threadId ?? thread.id,
      createdAt: "2026-08-05T04:00:00.000Z",
    });
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await messageComposer();
  await waitFor(() => {
    expect(composer).toHaveTextContent("Original release brief");
    expect(document.body).toHaveTextContent("outdated-brief.txt");
  });
  await userEvent.click(fastButton("Remove outdated-brief.txt"));
  await fill(composer, "Revised release brief");
  await userEvent.upload(composerFileInput(), freshFile);
  await waitFor(() => {
    expect(fastButton("Remove latest-brief.txt")).toBeVisible();
    expect(fastButton("Send")).toBeEnabled();
  });
  await userEvent.click(fastButton("Send"));

  await waitFor(() => {
    expect(sentPrompt).toBe("Revised release brief");
    expect(sentAttachmentNames).toStrictEqual(["latest-brief.txt"]);
  });
  const sentTurn = await waitFor(() => {
    const turn = Array.from(
      document.querySelectorAll<HTMLElement>('[data-role="user"]'),
    ).find((candidate) => {
      return candidate.textContent?.includes("Revised release brief") === true;
    });
    expect(turn).toBeDefined();
    return turn;
  });
  expect(sentTurn).toHaveTextContent("latest-brief.txt");
  expect(document.body).not.toHaveTextContent("outdated-brief.txt");
  await waitFor(() => {
    expect(currentMessageComposer().textContent?.trim()).toBe("");
    expect(
      workspace.draftPatches.some((patch) => {
        return (
          patch.threadId === thread.id &&
          patch.draftUserMessage === null &&
          patch.draftAttachments === null
        );
      }),
    ).toBeTruthy();
  });
});
