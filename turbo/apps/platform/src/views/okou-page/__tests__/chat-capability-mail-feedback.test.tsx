import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  context,
  installCapabilityChat,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

const MAIL_DRAFT_ID = "e0000000-0000-4000-a000-000000000811";
const SENT_MAIL_ID = "gmail-sent-message-811";
const MAIL_SUBJECT = "Launch approval email";
const MAIL_PASSAGE = "Move the launch review to Monday morning.";
const MAIL_CARD = `[${MAIL_SUBJECT}](/mail/drafts/${MAIL_DRAFT_ID})`;

function mailFixture(status: "draft" | "sent"): MailDraft {
  return {
    version: 3,
    provider: "gmail",
    from: "owner@example.com",
    fromName: "Launch Owner",
    to: ["reviewer@example.com"],
    cc: [],
    bcc: [],
    subject: MAIL_SUBJECT,
    body: MAIL_PASSAGE,
    accessStatus: "ready",
    references: [],
    status,
    detailAvailable: true,
    gmailDraftId: "gmail-draft-811",
    gmailThreadId: "gmail-thread-811",
    gmailMessageId: "gmail-message-811",
    ...(status === "sent"
      ? {
          sentGmailMessageId: SENT_MAIL_ID,
          sentAt: "2026-08-01T10:02:00.000Z",
        }
      : {}),
    attachments: [],
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:02:00.000Z",
  };
}

function mockMail(status: "draft" | "sent"): void {
  const draft = mailFixture(status);
  context.mocks.api(mailContract.getDraft, ({ respond }) => {
    return respond(200, {
      mailDraftId: MAIL_DRAFT_ID,
      mailDraftUrl: `https://app.okou.ai/mail/drafts/${MAIL_DRAFT_ID}`,
      mailDraft: draft,
    });
  });
}

async function openMailDetails(): Promise<HTMLElement> {
  const openEmail = await waitFor(() => {
    const button = queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-label")?.includes(MAIL_SUBJECT);
    });
    if (!button) {
      throw new Error("Mail card action was not available");
    }
    return button;
  });
  click(openEmail);
  const sidebar = await screen.findByRole("complementary", {
    name: "Email details",
  });
  expect(within(sidebar).getByText(MAIL_PASSAGE)).toBeVisible();
  return sidebar;
}

async function sendMailFeedback(
  sends: CapturedChatSend[],
  comment: string,
): Promise<CapturedChatSend> {
  await selectPassage("launch review to Monday morning");
  const editor = await quoteSelectedPassage();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  await user.paste(comment);
  const composer = editor.closest<HTMLElement>("[data-chat-composer]");
  if (!composer) {
    throw new Error("Owning mail feedback composer was not available");
  }
  const send = queryAllByRoleFast("button", composer).find((candidate) => {
    return candidate.getAttribute("aria-label") === "Send";
  });
  if (!send) {
    throw new Error("Mail feedback send action was not available");
  }
  click(send);
  return await waitForSend(sends, 1);
}

test("Keep inline feedback tied to the source email", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(MAIL_CARD),
    onSend(send) {
      sends.push(send);
    },
  });
  mockMail("draft");

  await setupPage({ locale: "en-US", context, path: RUN_PATH });

  await readyChat();
  await openMailDetails();
  const comment = "Rewrite this as a clear scheduling request.";
  const sent = await sendMailFeedback(sends, comment);

  expect(sent.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "feedback",
        quote: "launch review to Monday morning",
        note: [{ type: "text", text: comment }],
        source: { type: "mail", id: MAIL_DRAFT_ID, status: "draft" },
      }),
    ]),
  );
  const submittedComment = await screen.findByText(comment);
  expect(submittedComment).toBeVisible();
  expect(screen.getByText("Quoted from an email draft")).toBeVisible();
  expect(screen.queryByText(new RegExp(MAIL_DRAFT_ID, "u"))).toBeNull();
});
