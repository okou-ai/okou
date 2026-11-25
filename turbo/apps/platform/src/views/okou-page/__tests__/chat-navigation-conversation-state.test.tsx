import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
const DELETED_ID = "a0000000-0000-4000-a000-000000000e21";
const RECONNECT_ID = "a0000000-0000-4000-a000-000000000e22";
const TIMESTAMP = "2026-11-21T10:00:00.000Z";

function gmailDraft(overrides: Partial<MailDraft>): MailDraft {
  return {
    provider: "gmail",
    version: 3,
    gmailDraftId: "draft-access",
    gmailThreadId: "thread-access",
    gmailMessageId: "message-access",
    status: "draft",
    detailAvailable: true,
    from: "auditor@example.com",
    to: ["security@example.com"],
    cc: [],
    bcc: [],
    references: [],
    attachments: [],
    subject: "Untitled",
    body: "",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  } as MailDraft;
}

test("Explain unavailable email cards in a conversation", async () => {
  const drafts = new Map<string, MailDraft>([
    [
      DELETED_ID,
      gmailDraft({
        status: "deleted",
        detailAvailable: false,
        subject: "Vendor contract follow-up",
      }),
    ],
    [
      RECONNECT_ID,
      gmailDraft({
        subject: "Quarterly access review",
        accessStatus: "reconnect",
        reconnectConnectionId: "e0000000-0000-4000-a000-000000000e23",
      }),
    ],
  ]);
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    const draft = drafts.get(params.mailDraftId);
    if (!draft) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Mail draft not found" },
      });
    }
    return respond(200, {
      mailDraftId: params.mailDraftId,
      mailDraftUrl: `https://app.okou.ai/mail/drafts/${params.mailDraftId}`,
      mailDraft: draft,
    });
  });
  installCapabilityChat({
    events: completedConversation(
      [
        "Both emails from earlier:",
        "",
        `https://app.okou.ai/mail/drafts/${DELETED_ID}`,
        "",
        `https://app.okou.ai/mail/drafts/${RECONNECT_ID}`,
      ].join("\n"),
    ),
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  const deleted = await waitFor(() => {
    const card = document.querySelector<HTMLElement>(
      '[aria-label="Deleted email: Vendor contract follow-up"]',
    );
    expect(card).toBeInTheDocument();
    return card as HTMLElement;
  });
  expect(deleted).toBeVisible();
  expect(deleted).toHaveAttribute("aria-disabled", "true");
  expect(deleted).toHaveTextContent("Deleted");
  const reconnect = await waitFor(() => {
    const card = queryAllByRoleFast("button").find((button) => {
      return (
        button.getAttribute("aria-label") ===
        "Reconnect Gmail to access email: Quarterly access review"
      );
    });
    expect(card).toBeDefined();
    return card as HTMLElement;
  });
  expect(reconnect).toHaveTextContent("Need reconnect");
});
