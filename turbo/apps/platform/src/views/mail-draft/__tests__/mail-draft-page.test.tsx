import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const DRAFT_ID = "a0000000-0000-4000-a000-000000000f01";
const DRAFT_PATH = `/mail/drafts/${DRAFT_ID}`;
const TIMESTAMP = "2026-11-20T08:00:00.000Z";
const UNAVAILABLE = "This email is no longer available.";

function gmailDraft(overrides: Partial<MailDraft> = {}): MailDraft {
  return {
    provider: "gmail",
    version: 3,
    gmailDraftId: "draft-budget",
    gmailThreadId: "thread-budget",
    gmailMessageId: "message-budget",
    status: "draft",
    detailAvailable: true,
    from: "planner@example.com",
    to: ["finance@example.com"],
    cc: [],
    bcc: [],
    references: [],
    attachments: [],
    subject: "Budget review",
    body: "The revised budget is attached.",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  } as MailDraft;
}

function outlookDraft(overrides: Partial<MailDraft> = {}): MailDraft {
  return {
    provider: "outlook",
    version: 3,
    outlookMessageId: "outlook-message-budget",
    outlookConversationId: "outlook-conversation-budget",
    outlookWebLink: "https://outlook.office.test/mail/budget",
    status: "draft",
    detailAvailable: true,
    from: "planner@example.com",
    to: ["finance@example.com"],
    cc: [],
    bcc: [],
    references: [],
    attachments: [],
    subject: "Budget review",
    body: "The revised budget is attached.",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  } as MailDraft;
}

/** The API's copy of the standalone draft; null once it is gone. */
function mockDraft(initial: MailDraft): { draft: MailDraft | null } {
  const server: { draft: MailDraft | null } = { draft: initial };
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    if (!server.draft || params.mailDraftId !== DRAFT_ID) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Mail draft not found" },
      });
    }
    return respond(200, {
      mailDraftId: DRAFT_ID,
      mailDraftUrl: `http://localhost${DRAFT_PATH}`,
      mailDraft: server.draft,
    });
  });
  return server;
}

function button(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

async function findEnabledButton(name: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = button(name);
    expect(found).toBeEnabled();
    return found as HTMLElement;
  });
}

function providerLink(provider: string): HTMLElement | undefined {
  return queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === `Open in ${provider}`;
  });
}

async function openDraftPage(): Promise<void> {
  await setupPage({ context, path: DRAFT_PATH });
}

test("Sending from the standalone page shows the sent email on the same URL", async () => {
  const server = mockDraft(gmailDraft());
  context.mocks.api(mailContract.sendDraft, ({ respond }) => {
    server.draft = gmailDraft({
      status: "sent",
      sentGmailMessageId: "sent-budget",
      sentAt: TIMESTAMP,
    });
    return respond(200, {
      mailDraftId: DRAFT_ID,
      mailDraftUrl: `http://localhost${DRAFT_PATH}`,
      mailDraft: server.draft,
    });
  });
  await openDraftPage();
  await expect(screen.findByText("Budget review")).resolves.toBeInTheDocument();

  click(await findEnabledButton("Send"));

  await waitFor(() => {
    expect(button("Send")).toBeUndefined();
  });
  expect(screen.getByText("Sent")).toBeInTheDocument();
  expect(queryAllByRoleFast("button")).toStrictEqual([]);
  expect(window.location.pathname).toBe(DRAFT_PATH);
  expect(providerLink("Gmail")).toHaveAttribute(
    "href",
    "https://mail.google.com/mail/?authuser=planner%40example.com#all/thread-budget",
  );
});

test("Deleting from the standalone page removes the email without opening a chat", async () => {
  const server = mockDraft(gmailDraft());
  context.mocks.api(mailContract.deleteDraft, ({ respond }) => {
    server.draft = null;
    return respond(204);
  });
  await openDraftPage();
  await expect(screen.findByText("Budget review")).resolves.toBeInTheDocument();

  click(await findEnabledButton("Delete"));

  await expect(screen.findByText(UNAVAILABLE)).resolves.toBeInTheDocument();
  expect(screen.queryByText("Budget review")).not.toBeInTheDocument();
  expect(window.location.pathname).toBe(DRAFT_PATH);
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
});

test("An uncertain Outlook send offers a status check without resending", async () => {
  const server = mockDraft(outlookDraft());
  context.mocks.api(mailContract.sendDraft, ({ respond }) => {
    // Outlook accepted the request but has not confirmed delivery.
    server.draft = outlookDraft({ status: "sending" });
    return respond(200, {
      mailDraftId: DRAFT_ID,
      mailDraftUrl: `http://localhost${DRAFT_PATH}`,
      mailDraft: server.draft,
    });
  });
  await openDraftPage();
  await expect(screen.findByText("Budget review")).resolves.toBeInTheDocument();

  click(await findEnabledButton("Send"));

  await expect(
    screen.findByText(
      "Sending could not be confirmed. Check Outlook before trying again.",
    ),
  ).resolves.toBeInTheDocument();
  const refresh = await findEnabledButton("Refresh status");
  expect(button("Send")).toBeUndefined();

  server.draft = outlookDraft({ status: "sent", sentAt: TIMESTAMP });
  click(refresh);

  await waitFor(() => {
    expect(button("Refresh status")).toBeUndefined();
  });
  expect(screen.getByText("Sent")).toBeInTheDocument();
  expect(button("Send")).toBeUndefined();
  expect(
    screen.queryByText(
      "Sending could not be confirmed. Check Outlook before trying again.",
    ),
  ).not.toBeInTheDocument();
});

test("An inaccessible mail link cannot expose email actions", async () => {
  mockDraft(gmailDraft());

  await setupPage({
    context,
    path: "/mail/drafts/a0000000-0000-4000-a000-000000000f07",
  });

  await expect(screen.findByText(UNAVAILABLE)).resolves.toBeInTheDocument();
  expect(queryAllByRoleFast("button")).toStrictEqual([]);
});

test("A draft whose Gmail access expired reopens once Gmail is reconnected", async () => {
  const server = mockDraft(
    gmailDraft({
      accessStatus: "reconnect",
      reconnectConnectionId: "e0000000-0000-4000-a000-000000000f09",
    }),
  );
  await openDraftPage();

  await expect(
    screen.findByText(
      "You no longer have permission to access this email. Reconnect Gmail to continue.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Budget review")).not.toBeInTheDocument();

  // Gmail is reconnected elsewhere and the API announces the change.
  server.draft = gmailDraft({ accessStatus: "ready" });
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "gmail" });

  await expect(screen.findByText("Budget review")).resolves.toBeInTheDocument();
  expect(
    screen.queryByText(
      "You no longer have permission to access this email. Reconnect Gmail to continue.",
    ),
  ).not.toBeInTheDocument();
});
