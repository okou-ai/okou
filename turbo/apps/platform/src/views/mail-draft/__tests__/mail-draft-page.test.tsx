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

const context = testContext();
const MAIL_ID = "e0000000-0000-4000-a000-000000000901";
const MAIL_PATH = `/mail/drafts/${MAIL_ID}`;

function mailDraft(
  overrides: Partial<Extract<MailDraft, { provider: "gmail" }>> = {},
): Extract<MailDraft, { provider: "gmail" }> {
  return {
    version: 3,
    provider: "gmail",
    from: "sender@example.com",
    fromName: "Example Sender",
    to: ["recipient@example.com"],
    cc: ["reviewer@example.com"],
    bcc: [],
    subject: "Review the invitation",
    body: "Are you available next week?",
    accessStatus: "ready",
    references: [],
    status: "draft",
    detailAvailable: true,
    gmailDraftId: "gmail-draft-901",
    gmailThreadId: "gmail-thread-901",
    gmailMessageId: "gmail-message-901",
    attachments: [],
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function mailResponse(draft: MailDraft) {
  return {
    mailDraftId: MAIL_ID,
    mailDraftUrl: `https://app.okou.ai${MAIL_PATH}`,
    mailDraft: draft,
  };
}

function outlookDraft(): Extract<MailDraft, { provider: "outlook" }> {
  const {
    gmailDraftId: _draftId,
    gmailThreadId: _threadId,
    gmailMessageId: _messageId,
    ...common
  } = mailDraft();
  return {
    ...common,
    provider: "outlook",
    outlookMessageId: "outlook-immutable-901",
    outlookConversationId: "outlook-conversation-901",
    outlookWebLink: "https://outlook.live.com/mail/0/id/outlook-immutable-901",
  };
}

function mockDraft(draft: MailDraft): void {
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    expect(params.mailDraftId).toBe(MAIL_ID);
    return respond(200, mailResponse(draft));
  });
}

function control(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!element) {
    throw new Error(`${name} ${role} was not available`);
  }
  return element;
}

test("Sending from the standalone page shows the sent email on the same URL", async () => {
  const draft = mailDraft();
  mockDraft(draft);
  context.mocks.api(mailContract.sendDraft, ({ params, respond }) => {
    expect(params.mailDraftId).toBe(MAIL_ID);
    return respond(
      200,
      mailResponse({
        ...draft,
        status: "sent",
        sentGmailMessageId: "sent-message-901",
        gmailThreadId: "sent-thread-901",
        sentAt: "2026-09-01T10:05:00.000Z",
      }),
    );
  });

  await setupPage({ context, path: MAIL_PATH });

  const details = await screen.findByRole("region", { name: "Email details" });
  click(control("button", "Send", details));

  await expect(within(details).findByText("Sent")).resolves.toBeInTheDocument();
  expect(queryAllByRoleFast("button", details)).toHaveLength(0);
  expect(control("link", "Open in Gmail", details)).toHaveAttribute(
    "href",
    "https://mail.google.com/mail/?authuser=sender%40example.com#all/sent-thread-901",
  );
  expect(window.location.pathname).toBe(MAIL_PATH);
});

test("Deleting from the standalone page removes the email without opening a chat", async () => {
  mockDraft(mailDraft());
  context.mocks.api(mailContract.deleteDraft, ({ params, respond }) => {
    expect(params.mailDraftId).toBe(MAIL_ID);
    return respond(204);
  });

  await setupPage({ context, path: MAIL_PATH });

  const details = await screen.findByRole("region", { name: "Email details" });
  click(control("button", "Delete", details));

  await expect(
    screen.findByText("This email is no longer available."),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Review the invitation")).not.toBeInTheDocument();
  expect(window.location.pathname).toBe(MAIL_PATH);
  expect(
    screen.queryByRole("textbox", { name: "Message" }),
  ).not.toBeInTheDocument();
});

test("An uncertain Outlook send offers a status check without resending", async () => {
  let current = outlookDraft();
  context.mocks.api(mailContract.getDraft, ({ respond }) => {
    return respond(200, mailResponse(current));
  });
  context.mocks.api(mailContract.sendDraft, ({ respond }) => {
    current = { ...current, status: "sending" };
    return respond(200, mailResponse(current));
  });
  await setupPage({ context, path: MAIL_PATH });

  const details = await screen.findByRole("region", { name: "Email details" });
  click(control("button", "Send", details));

  const refresh = await waitFor(() => {
    return control("button", "Refresh status", details);
  });
  expect(
    within(details).getByText(
      "Sending could not be confirmed. Check Outlook before trying again.",
    ),
  ).toBeInTheDocument();
  current = { ...current, status: "sent", sentAt: "2026-10-29T04:00:00.000Z" };
  click(refresh);

  await expect(within(details).findByText("Sent")).resolves.toBeInTheDocument();
});

test("An inaccessible mail link cannot expose email actions", async () => {
  context.mocks.api(mailContract.getDraft, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Mail draft not found" },
    });
  });

  await setupPage({ context, path: MAIL_PATH });

  await expect(
    screen.findByText("This email is no longer available."),
  ).resolves.toBeInTheDocument();
  expect(queryAllByRoleFast("button", screen.getByRole("main"))).toHaveLength(
    0,
  );
});

test("A draft whose Gmail access expired reopens once Gmail is reconnected", async () => {
  let reconnected = false;
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    expect(params.mailDraftId).toBe(MAIL_ID);
    return respond(
      200,
      mailResponse(
        reconnected
          ? mailDraft()
          : mailDraft({
              accessStatus: "reconnect",
              reconnectConnectionId: "e0000000-0000-4000-a000-000000000902",
            }),
      ),
    );
  });

  await setupPage({ context, path: MAIL_PATH });

  await expect(
    screen.findByText(
      "You no longer have permission to access this email. Reconnect Gmail to continue.",
    ),
  ).resolves.toBeInTheDocument();
  expect(control("button", "Reconnect Gmail")).toBeInTheDocument();
  expect(screen.queryByText("Review the invitation")).not.toBeInTheDocument();

  // The API announces the reconnected Gmail account to the member.
  reconnected = true;
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("connector:changed"),
    ).toBeTruthy();
  });
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "gmail" });

  await expect(
    screen.findByText("Review the invitation"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText(
      "You no longer have permission to access this email. Reconnect Gmail to continue.",
    ),
  ).not.toBeInTheDocument();
});
