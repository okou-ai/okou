import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

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

test("An external mail link requires sign-in and preserves its destination", async () => {
  await startPage({
    context,
    path: MAIL_PATH,
    host: "app.okou.ai",
    auth: null,
  });

  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in");
  });
  const signInQuery = new URLSearchParams(window.location.hash.split("?")[1]);
  expect(signInQuery.get("redirect_url")).toBe(
    `https://app.okou.ai${MAIL_PATH}`,
  );
  expect(screen.queryByText("Review the invitation")).not.toBeInTheDocument();
});

test("An external mail link opens the complete email and its attachments without a chat", async () => {
  mockDraft(
    mailDraft({
      bodyHtml: "<p>Are you <strong>available next week</strong>?</p>",
      attachments: [
        {
          filename: "invitation.txt",
          contentType: "text/plain",
          size: 32,
          partId: "invitation",
        },
      ],
    }),
  );
  context.mocks.http.get(
    `*/api/mail/drafts/${MAIL_ID}/attachments/invitation`,
    () => {
      return new HttpResponse("Details for the intro call", {
        headers: { "Content-Type": "application/octet-stream" },
      });
    },
  );

  await setupPage({ context, path: MAIL_PATH, host: "app.okou.ai" });

  const details = await screen.findByRole("region", { name: "Email details" });
  expect(within(details).getByRole("heading")).toHaveTextContent(
    "Review the invitation",
  );
  expect(within(details).getByText("Example Sender")).toBeInTheDocument();
  expect(
    within(details).getByText(/recipient@example.com/u),
  ).toBeInTheDocument();
  expect(
    within(details).getByText(/reviewer@example.com/u),
  ).toBeInTheDocument();
  expect(within(details).getByText("available next week")).toBeInTheDocument();
  expect(control("link", "Open in Gmail", details)).toHaveAttribute(
    "href",
    "https://mail.google.com/mail/?authuser=sender%40example.com#drafts?compose=gmail-message-901",
  );
  expect(
    screen.queryByLabelText("Close email details"),
  ).not.toBeInTheDocument();

  const attachment = await waitFor(() => {
    return control("button", "Open text preview for invitation.txt", details);
  });
  click(attachment);

  const preview = await screen.findByRole("dialog", {
    name: "invitation.txt preview",
  });
  await expect(
    within(preview).findByText("Details for the intro call"),
  ).resolves.toBeInTheDocument();
  click(control("button", "Close", preview));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe(MAIL_PATH);
});

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
});

test("An accepted Outlook send appears as sent immediately on the standalone page", async () => {
  const confirmation = createDeferredPromise<void>(context.signal);
  let current = outlookDraft();
  context.mocks.api(mailContract.getDraft, ({ respond }) => {
    return respond(200, mailResponse(current));
  });
  context.mocks.api(mailContract.sendDraft, async ({ respond }) => {
    await confirmation.promise;
    current = {
      ...current,
      status: "sent",
      sentAt: "2026-10-29T04:00:00.000Z",
    };
    return respond(200, mailResponse(current));
  });
  await setupPage({ context, path: MAIL_PATH });

  const details = await screen.findByRole("region", { name: "Email details" });
  click(control("button", "Send", details));
  expect(control("button", "Send", details)).toBeDisabled();

  confirmation.resolve();

  await expect(within(details).findByText("Sent")).resolves.toBeInTheDocument();
  expect(control("link", "Open in Outlook", details)).toHaveAttribute(
    "href",
    current.outlookWebLink,
  );
  expect(window.location.pathname).toBe(MAIL_PATH);
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

test("A deleted draft is identified without exposing Send or Delete", async () => {
  mockDraft(mailDraft({ status: "deleted" }));

  await setupPage({ context, path: MAIL_PATH });

  await expect(
    screen.findByText("This draft was deleted."),
  ).resolves.toBeInTheDocument();
  expect(queryAllByRoleFast("button", screen.getByRole("main"))).toHaveLength(
    0,
  );
});

test("A draft whose Gmail access expired offers reconnection", async () => {
  mockDraft(
    mailDraft({
      accessStatus: "reconnect",
      reconnectConnectionId: "e0000000-0000-4000-a000-000000000902",
    }),
  );

  await setupPage({ context, path: MAIL_PATH });

  await expect(
    screen.findByText(
      "You no longer have permission to access this email. Reconnect Gmail to continue.",
    ),
  ).resolves.toBeInTheDocument();
  expect(control("button", "Reconnect Gmail")).toBeInTheDocument();
  expect(screen.queryByText("Review the invitation")).not.toBeInTheDocument();
});

test("Email content retains links and image descriptions without native hover hints", async () => {
  mockDraft(
    mailDraft({
      bodyHtml:
        '<p title="Paragraph hint">Review the invitation</p><a href="https://example.com/reply" title="Link hint">Reply online</a><img src="https://example.com/logo.png" alt="Company logo" title="Image hint">',
    }),
  );
  await setupPage({ context, path: MAIL_PATH, host: "app.okou.ai" });

  const link = await screen.findByText("Reply online", { selector: "a" });
  expect(link).toHaveAttribute("href", "https://example.com/reply");
  expect(link).not.toHaveAttribute("title");
  const image = screen.getByRole("img", { name: "Company logo" });
  expect(image).not.toHaveAttribute("title");
  expect(document.querySelector('[title="Paragraph hint"]')).toBeNull();
});
