import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
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
import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
import {
  CAPABILITY_AGENT_ID,
  completedConversation,
  context,
  FIRST_CAPABILITY_RUN_ID,
  installCapabilityChat,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import { threadListSnapshot } from "./chat-test-helpers.ts";

const MAIL_DRAFT_ID = "e0000000-0000-4000-a000-000000000811";
const SENT_MAIL_ID = "gmail-sent-message-811";
const MAIL_OWNER_THREAD_ID = "b0000000-0000-4000-a000-000000000817";
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
  expect(screen.getByText(new RegExp(MAIL_DRAFT_ID, "u"))).toBeVisible();
});

test("Keep inline feedback tied to the sent source email", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(MAIL_CARD),
    onSend(send) {
      sends.push(send);
    },
  });
  mockMail("sent");

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await openMailDetails();
  const comment = "Rewrite this sent passage for the follow-up.";
  const sent = await sendMailFeedback(sends, comment);

  expect(sent.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "feedback",
        quote: "launch review to Monday morning",
        note: [{ type: "text", text: comment }],
        source: {
          type: "mail",
          id: MAIL_DRAFT_ID,
          status: "sent",
          sentId: SENT_MAIL_ID,
        },
      }),
    ]),
  );
  const sentIdentity = await screen.findByText(new RegExp(SENT_MAIL_ID, "u"));
  expect(sentIdentity).toBeVisible();
});

function configureSplitMailChats(): void {
  const leftEvents = completedConversation(
    "The left chat has an independent composer.",
  );
  const rightEvents: MockChatEventInput[] = [
    {
      id: "mail-owner-user",
      role: "user",
      runId: FIRST_CAPABILITY_RUN_ID,
      seqId: 1,
      content: "Open the linked mail draft",
      createdAt: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "mail-owner-assistant",
      role: "assistant",
      runId: FIRST_CAPABILITY_RUN_ID,
      seqId: 2,
      content: MAIL_CARD,
      createdAt: "2026-08-01T10:00:01.000Z",
    },
  ];
  const rows = new Map([
    [
      RUN_THREAD_ID,
      mockChatEventRows(normalizeMockChatEvents(leftEvents, RUN_THREAD_ID)),
    ],
    [
      MAIL_OWNER_THREAD_ID,
      mockChatEventRows(
        normalizeMockChatEvents(rightEvents, MAIL_OWNER_THREAD_ID),
      ),
    ],
  ]);
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threadListSnapshot([
        {
          id: RUN_THREAD_ID,
          title: "Independent chat",
          agent: { id: CAPABILITY_AGENT_ID, avatarUrl: null },
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:02:00.000Z",
        },
        {
          id: MAIL_OWNER_THREAD_ID,
          title: "Mail owner chat",
          agent: { id: CAPABILITY_AGENT_ID, avatarUrl: null },
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:01:00.000Z",
        },
      ]),
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      const threadRows = rows.get(params.threadId) ?? [];
      return respond(
        200,
        chatEventRowsResponse(
          threadRows.filter((row) => {
            return row.seqId > query.sinceSeqId;
          }),
          query,
        ),
      );
    },
  );
}

test("Keep mail feedback in the chat that owns the email", async () => {
  installCapabilityChat({
    events: completedConversation("The left chat has an independent composer."),
  });
  configureSplitMailChats();
  mockMail("draft");

  await setupPage({
    context,
    path: `${RUN_PATH}?sidebar=${MAIL_OWNER_THREAD_ID}`,
  });

  const composers = await screen.findAllByRole("textbox", { name: "Message" });
  expect(composers).toHaveLength(2);
  await openMailDetails();
  await selectPassage("launch review to Monday morning");
  await quoteSelectedPassage();

  const currentComposers = screen.getAllByRole("textbox", { name: "Message" });
  expect(currentComposers).toHaveLength(2);
  const owningComposer = currentComposers.find((composer) => {
    return (
      composer.closest<HTMLElement>("[data-chat-thread-container-id]")?.dataset
        .chatThreadContainerId === MAIL_OWNER_THREAD_ID
    );
  });
  const independentComposer = currentComposers.find((composer) => {
    return composer !== owningComposer;
  });
  if (!owningComposer || !independentComposer) {
    throw new Error("Both chat composers were not available");
  }
  expect(
    within(owningComposer).getByRole("textbox", {
      name: "What should change about this?",
    }),
  ).toBeVisible();
  expect(
    within(independentComposer).queryByRole("textbox", {
      name: "What should change about this?",
    }),
  ).not.toBeInTheDocument();
});
