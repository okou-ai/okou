import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  findButton,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

test("Keep inline feedback tied to the source email", async () => {
  const mailDraftId = "a0000000-0000-4000-a000-000000000611";
  const mailDraftUrl = `https://app.okou.ai/mail/drafts/${mailDraftId}`;
  const passage = "launch review to Monday morning";
  const body = `Could we move the ${passage}?`;
  const comment = "Rewrite this as a clear scheduling request";
  const subject = "Launch review";
  const timestamp = "2026-08-01T10:00:00.000Z";
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(mailDraftUrl),
    onSend(send) {
      sends.push(send);
    },
  });
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    expect(params.mailDraftId).toBe(mailDraftId);
    return respond(200, {
      mailDraftId,
      mailDraftUrl,
      mailDraft: {
        provider: "gmail",
        version: 3,
        gmailDraftId: "draft-launch",
        gmailThreadId: "thread-launch",
        gmailMessageId: "message-launch",
        status: "draft",
        detailAvailable: true,
        from: "sender@example.com",
        to: ["reviewer@example.com"],
        cc: [],
        bcc: [],
        references: [],
        attachments: [],
        subject,
        body,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  click(await findButton("Open draft email: Launch review"));
  const mail = await screen.findByTestId("mail-draft-sidebar");
  await expect(within(mail).findByText(body)).resolves.toBeInTheDocument();

  await selectPassage(passage);
  const note = await quoteSelectedPassage();
  const user = userEvent.setup({ delay: null });
  await user.type(note, comment);
  click(await findButton("Send"));

  const sent = await waitForSend(sends, 1);
  expect(sent.userMessage?.parts).toContainEqual(
    expect.objectContaining({
      type: "feedback",
      quote: passage,
      note: [{ type: "text", text: comment }],
      source: { type: "mail", id: mailDraftId, status: "draft" },
    }),
  );
  const thread = await readyChat();
  await expect(within(thread).findByText(comment)).resolves.toBeInTheDocument();
  expect(
    within(thread).getByText("Quoted from an email draft"),
  ).toBeInTheDocument();
});
