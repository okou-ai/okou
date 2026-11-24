import { mailContract } from "@okouai/api-contracts/contracts/mail";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import userEvent from "@testing-library/user-event";
import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import {
  createChatRunFixtures,
  findButton,
  findEnabledButton,
  RUN_PATH,
  assistantEvent,
  completedEvent,
  promptEvent,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const context = testContext();

test("chat-capability-feedback-002 sending a quoted comment preserves the existing text and attachment", async () => {
  const file = "review-notes.txt",
    passage = "Inspect the staged delivery.",
    note = "Mention the alternate route.",
    message = "Here is my review.";
  const sent = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    chatEvents: completedConversation(passage),
    onSendRequest(body) {
      sent.resolve(body.userMessage);
    },
  });
  context.mocks.upload.success({
    id: "review-file",
    filename: file,
    contentType: "text/plain",
    size: 6,
    url: "https://cdn.vm7.io/review-notes.txt",
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await screen.findByText(passage);
  const user = userEvent.setup({ delay: null });
  await user.type(await screen.findByLabelText("Message"), message);
  await user.upload(
    await screen.findByLabelText("Attach", { selector: "input" }),
    new File(["review"], file, { type: "text/plain" }),
  );
  await screen.findByText(file);
  await selectPassage(passage);
  click(await findButton("Quote"));
  await user.type(
    await screen.findByRole("textbox", {
      name: "Ask or comment on this quote",
    }),
    note,
  );
  click(await findEnabledButton("Send"));
  const submission = await sent.promise;
  expect(
    submission?.parts
      .filter((part) => {
        return part.type === "text";
      })
      .map((part) => {
        return part.text.trim();
      }),
  ).toContain(message);
  expect(submission?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "file",
        fileId: "review-file",
        filenameSnapshot: file,
      }),
      expect.objectContaining({
        type: "feedback",
        quote: passage,
        note: [{ type: "text", text: note }],
      }),
    ]),
  );
  await screen.findByText(note);
});

test("chat-capability-feedback-submission-001 sending a quoted correction clears the editor and posts it to this chat", async () => {
  const runId = crypto.randomUUID(),
    passage = "Inspect the east loading dock",
    comment = "Please use the west loading dock.";
  const unavailable = "retired-dispatch-model";
  const submission = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    onSendRequest(body) {
      if ((body.threadId ?? body.clientThreadId) === RUN_THREAD_ID) {
        submission.resolve(body.userMessage);
      }
    },
    selectedModel: unavailable,
    chatEvents: [
      promptEvent({
        id: runId,
        runId,
        seqId: 1,
        text: "Check the dispatch instructions",
      }),
      assistantEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 2,
        text: passage,
      }),
      completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }),
    ],
  });
  context.mocks.data.userModelPreference({
    selectedModel: unavailable,
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: null,
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  const source = await screen.findByText(passage);
  const transcript = source.closest<HTMLElement>("[data-message-container]")!;
  await selectPassage(passage);
  click(await findButton("Quote"));
  const note = await screen.findByRole("textbox", {
    name: "Ask or comment on this quote",
  });
  // The note shares a contenteditable with the quote. Select-all would replace both.
  await userEvent.setup({ delay: null }).type(note, comment);
  click(await findEnabledButton("Send"));
  const document = await submission.promise;
  const feedback = document?.parts.find((part) => {
    return part.type === "feedback";
  });
  expect(feedback?.quote).toBe(passage);
  expect(feedback?.note).toStrictEqual([{ type: "text", text: comment }]);
  const posted = await within(transcript).findByText(comment);
  const row = posted.closest<HTMLElement>("[data-chat-scroll-anchor-event-id]");
  expect(row).toBeInTheDocument();
  expect(row).toHaveTextContent(passage);
  expect(posted).toBeVisible();
  await waitFor(() => {
    return expect(
      screen.queryByRole("textbox", { name: "Ask or comment on this quote" }),
    ).toBeNull();
  });
});

test("chat-capability-mail-feedback-001 sending a draft quote keeps its mail source and comment together", async () => {
  const id = crypto.randomUUID(),
    run = crypto.randomUUID(),
    url = "https://app.okou.ai/mail/drafts/" + id;
  const passage = "launch review to Monday morning",
    comment = "Rewrite this as a clear scheduling request";
  const sent = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    onSendRequest(body) {
      if ((body.threadId ?? body.clientThreadId) === RUN_THREAD_ID) {
        sent.resolve(body.userMessage);
      }
    },
    chatEvents: [
      promptEvent({
        id: run,
        runId: run,
        seqId: 1,
        text: "Prepare the launch email",
      }),
      assistantEvent({
        id: crypto.randomUUID(),
        runId: run,
        seqId: 2,
        text: url,
      }),
      completedEvent({ id: crypto.randomUUID(), runId: run, seqId: 3 }),
    ],
  });
  context.mocks.api(mailContract.getDraft, ({ respond }) => {
    return respond(200, {
      mailDraftId: id,
      mailDraftUrl: url,
      mailDraft: {
        provider: "gmail",
        gmailDraftId: "draft-launch",
        gmailThreadId: "launch-thread",
        gmailMessageId: "draft-message",
        version: 3,
        from: "dispatch@example.org",
        to: ["team@example.org"],
        cc: [],
        bcc: [],
        subject: "Proposed launch review",
        body: "Move the " + passage + ".",
        references: [],
        status: "draft",
        detailAvailable: true,
        createdAt: "2026-09-01T12:00:00Z",
        updatedAt: "2026-09-01T12:00:00Z",
        attachments: [],
      },
    });
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  click(await screen.findByText("Proposed launch review"));
  await screen.findByText("Move the " + passage + ".");
  await selectPassage(passage);
  click(await findButton("Quote"));
  const editor = await screen.findByRole("textbox", {
    name: "Ask or comment on this quote",
  });
  await userEvent.setup({ delay: null }).type(editor, comment);
  click(await findEnabledButton("Send"));
  const feedback = (await sent.promise)?.parts.find((p) => {
    return p.type === "feedback";
  });
  expect(feedback).toMatchObject({
    quote: passage,
    note: [{ type: "text", text: comment }],
    source: { type: "mail", id, status: "draft" },
  });
  const posted = await screen.findByText(comment);
  const row = posted.closest<HTMLElement>(
    "[data-chat-scroll-anchor-event-id]",
  )!;
  expect(
    within(row).getByText("Quoted from an email draft"),
  ).toBeInTheDocument();
});
