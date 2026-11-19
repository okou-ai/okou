import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  findButton,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

import {
  getNamedButton,
  getNamedLink,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

test("Send, revisit, and delete mail drafts from chat", async () => {
  const approvalId = "a0000000-0000-4000-a000-000000000617";
  const vendorId = "a0000000-0000-4000-a000-000000000618";
  const time = "2026-08-01T10:00:00.000Z";
  const url = (id: string) => {
    return `https://app.okou.ai/mail/drafts/${id}`;
  };
  const draft = (subject: string, id: string): MailDraft => {
    return {
      provider: "gmail",
      version: 3,
      gmailDraftId: `draft-${id}`,
      gmailThreadId: `thread-${id}`,
      gmailMessageId: `message-${id}`,
      status: "draft",
      detailAvailable: true,
      from: "sender@example.com",
      to: ["reviewer@example.com"],
      cc: [],
      bcc: [],
      references: [],
      attachments: [],
      subject,
      body: `Please review ${subject.toLowerCase()}.`,
      createdAt: time,
      updatedAt: time,
    };
  };
  const drafts = new Map([
    [approvalId, draft("Launch approval", "approval")],
    [vendorId, draft("Vendor follow-up", "vendor")],
  ]);
  installCapabilityChat({
    events: completedConversation(`${url(approvalId)}\n\n${url(vendorId)}`),
  });
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    const mailDraft = drafts.get(params.mailDraftId);
    if (!mailDraft) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Draft not found" },
      });
    }
    return respond(200, {
      mailDraftId: params.mailDraftId,
      mailDraftUrl: url(params.mailDraftId),
      mailDraft,
    });
  });
  context.mocks.api(mailContract.sendDraft, ({ params, respond }) => {
    const mailDraft = drafts.get(params.mailDraftId);
    if (params.mailDraftId !== approvalId || mailDraft?.provider !== "gmail") {
      throw new Error("Expected the approval draft to be sent");
    }
    const sent = {
      ...mailDraft,
      status: "sent" as const,
      sentAt: time,
      sentGmailMessageId: "sent-approval",
    };
    drafts.set(approvalId, sent);
    return respond(200, {
      mailDraftId: approvalId,
      mailDraftUrl: url(approvalId),
      mailDraft: sent,
    });
  });
  context.mocks.api(mailContract.deleteDraft, ({ params, respond }) => {
    expect(params.mailDraftId).toBe(vendorId);
    drafts.delete(vendorId);
    return respond(204);
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  const open = async (button: string, body: string) => {
    click(await findButton(button));
    const panel = await screen.findByTestId("mail-draft-sidebar");
    await expect(within(panel).findByText(body)).resolves.toBeInTheDocument();
    return panel;
  };

  const approval = await open(
    "Open draft email: Launch approval",
    "Please review launch approval.",
  );
  click(getNamedButton("Send", approval));
  const sentCard = await findButton("Open sent email: Launch approval");
  expect(getNamedLink("Open in Gmail", approval)).toHaveAttribute(
    "href",
    "https://mail.google.com/mail/?authuser=sender%40example.com#all/thread-approval",
  );

  await open(
    "Open draft email: Vendor follow-up",
    "Please review vendor follow-up.",
  );
  const revisited = await open(
    "Open sent email: Launch approval",
    "Please review launch approval.",
  );
  expect(getNamedLink("Open in Gmail", revisited)).toHaveAttribute(
    "href",
    "https://mail.google.com/mail/?authuser=sender%40example.com#all/thread-approval",
  );
  const vendor = await open(
    "Open draft email: Vendor follow-up",
    "Please review vendor follow-up.",
  );
  expect(getNamedButton("Send", vendor)).toBeEnabled();
  click(getNamedButton("Delete", vendor));

  await waitFor(() => {
    expect(screen.queryByTestId("mail-draft-sidebar")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").find((button) => {
        return button.getAttribute("aria-label")?.includes("Vendor follow-up");
      }),
    ).toBeUndefined();
  });
  expect(sentCard).toBeInTheDocument();
});
