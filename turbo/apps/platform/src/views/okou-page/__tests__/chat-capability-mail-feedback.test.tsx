import { mailContract } from "@okouai/api-contracts/contracts/mail";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { selectPassage } from "./chat-capability-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findButton,
  findEnabledButton,
  promptEvent,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const context = testContext();

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
