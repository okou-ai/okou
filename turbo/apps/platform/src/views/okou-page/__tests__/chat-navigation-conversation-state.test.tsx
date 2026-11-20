import { screen, waitFor } from "@testing-library/react";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();

interface RunAssociation {
  readonly id: string;
}

function textDocument(text: string): UserMessageDocument {
  return { version: 1, parts: [{ type: "text", text }] };
}

function promptRow(
  caseId: number,
  sequence: number,
  threadId: string,
  text: string,
  run: RunAssociation,
): ChatEventRow {
  return continuityEventRow(caseId, sequence, threadId, "input.prompt", {
    payload: { userMessage: textDocument(text) },
    runId: run.id,
  });
}

function outputRow(
  caseId: number,
  sequence: number,
  threadId: string,
  content: string,
  run: RunAssociation,
): ChatEventRow {
  return continuityEventRow(caseId, sequence, threadId, "output.message", {
    payload: { content },
    runId: run.id,
  });
}

function completedRow(
  caseId: number,
  sequence: number,
  threadId: string,
  runId: string,
): ChatEventRow {
  return continuityEventRow(caseId, sequence, threadId, "run.completed", {
    runId,
  });
}

function mailDraft(
  subject: string,
  status: "draft" | "deleted",
  detailAvailable: boolean,
  accessStatus: "ready" | "reconnect",
): MailDraft {
  return {
    version: 3,
    provider: "gmail",
    from: "assistant@example.com",
    to: ["reader@example.com"],
    cc: [],
    bcc: [],
    subject,
    body: "",
    accessStatus,
    references: [],
    status,
    detailAvailable,
    gmailDraftId: `gmail-draft-${subject}`,
    gmailThreadId: `gmail-thread-${subject}`,
    gmailMessageId: `gmail-message-${subject}`,
    createdAt: "2026-08-23T08:00:00.000Z",
    updatedAt: "2026-08-23T08:00:00.000Z",
    attachments: [],
  };
}

test("Explain unavailable email cards in a conversation", async () => {
  const thread = continuityThread(32, 1, "Unavailable email cards");
  const runId = "b1000000-0000-4000-a000-000000000032";
  const deletedDraftId = "c1000000-0000-4000-a000-000000000321";
  const reconnectDraftId = "c1000000-0000-4000-a000-000000000322";
  const rows = [
    promptRow(32, 1, thread.id, "Review both drafts", { id: runId }),
    outputRow(
      32,
      2,
      thread.id,
      [
        `[Deleted launch note](https://app.okou.ai/mail/drafts/${deletedDraftId})`,
        `[Quarterly access review](https://app.okou.ai/mail/drafts/${reconnectDraftId})`,
      ].join("\n\n"),
      { id: runId },
    ),
    completedRow(32, 3, thread.id, runId),
  ];
  const workspace = installContinuityWorkspace(context, {
    caseId: 32,
    threads: [thread],
    chatEventRows: rows,
  });
  const drafts = new Map<string, MailDraft>([
    [
      deletedDraftId,
      mailDraft("Archived launch note", "deleted", false, "ready"),
    ],
    [
      reconnectDraftId,
      mailDraft("Quarterly access review", "draft", true, "reconnect"),
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

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const deletedCard = await screen.findByLabelText(
    "Deleted email: Archived launch note",
  );
  expect(deletedCard).toBeVisible();
  expect(deletedCard).toHaveAttribute("aria-disabled", "true");
  expect(deletedCard).toHaveTextContent("Deleted");

  await waitFor(() => {
    expect(
      fastButton("Reconnect Gmail to access email: Quarterly access review"),
    ).toBeVisible();
  });
  const reconnectCard = fastButton(
    "Reconnect Gmail to access email: Quarterly access review",
  );
  expect(reconnectCard).toHaveTextContent("Need reconnect");
});
