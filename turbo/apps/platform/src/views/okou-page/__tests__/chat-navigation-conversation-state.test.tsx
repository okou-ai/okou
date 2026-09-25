import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();

function textDocument(text: string): UserMessageDocument {
  return { version: 1, parts: [{ type: "text", text }] };
}

function promptRow(
  caseId: number,
  sequence: number,
  threadId: string,
  text: string,
  runId: string,
): ChatEventRow {
  return continuityEventRow(caseId, sequence, threadId, "input.prompt", {
    payload: { userMessage: textDocument(text) },
    runId,
  });
}

function outputRow(
  caseId: number,
  sequence: number,
  threadId: string,
  content: string,
  runId: string,
): ChatEventRow {
  return continuityEventRow(caseId, sequence, threadId, "output.message", {
    payload: { content },
    runId,
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

function threadContainer(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!container) {
    throw new Error(`Expected chat pane ${threadId}`);
  }
  return container;
}

function scrollContainer(threadId: string): HTMLElement {
  const scroller = threadContainer(threadId).querySelector<HTMLElement>(
    "[data-scroll-container]",
  );
  if (!scroller) {
    throw new Error(`Expected scroll container for ${threadId}`);
  }
  return scroller;
}

function eventAnchor(container: ParentNode, eventId: string): HTMLElement {
  const anchor = container.querySelector<HTMLElement>(
    `[data-chat-scroll-anchor-event-id="${eventId}"]`,
  );
  if (!anchor) {
    throw new Error(`Expected scroll anchor for ${eventId}`);
  }
  return anchor;
}

function installReadingPositionGeometry(
  container: HTMLElement,
  scroller: HTMLElement,
  eventId: string,
): void {
  const originalGetBoundingClientRect =
    HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function getReadingPositionRect(this: HTMLElement): DOMRect {
      if (this === scroller) {
        return new DOMRect(0, 0, 720, 400);
      }
      if (this.dataset.chatScrollAnchorEventId === eventId) {
        const insertedFoldRows = container.querySelectorAll(
          "[data-chat-run-work]",
        ).length;
        return new DOMRect(
          0,
          620 + insertedFoldRows * 40 - scroller.scrollTop,
          720,
          40,
        );
      }
      if (Object.hasOwn(this.dataset, "chatScrollAnchorEventId")) {
        return new DOMRect(0, 600, 720, 40);
      }
      return originalGetBoundingClientRect.call(this);
    },
  );
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

test("Keep an empty conversation ready for its first message", async () => {
  const thread = continuityThread(31, 1, "Empty conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 31,
    threads: [thread],
    chatEventRows: [],
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const invitation = await screen.findByText(
    "Send a message to start the conversation",
  );
  const composer = await screen.findByRole("textbox", { name: "Message" });
  expect(invitation).toBeVisible();
  expect(composer).toBeVisible();

  const scroller = scrollContainer(thread.id);
  expect(scroller.scrollTop).toBe(0);
  expect(
    scroller.querySelector("[data-chat-scroll-anchor-event-id]"),
  ).toBeNull();
  expect(scroller.querySelector("[data-scroll-to-bottom]")).toBeNull();
});

test("Explain unavailable email cards in a conversation", async () => {
  const thread = continuityThread(32, 1, "Unavailable email cards");
  const runId = "b1000000-0000-4000-a000-000000000032";
  const deletedDraftId = "c1000000-0000-4000-a000-000000000321";
  const reconnectDraftId = "c1000000-0000-4000-a000-000000000322";
  const rows = [
    promptRow(32, 1, thread.id, "Review both drafts", runId),
    outputRow(
      32,
      2,
      thread.id,
      [
        `[Deleted launch note](https://app.okou.ai/mail/drafts/${deletedDraftId})`,
        `[Quarterly access review](https://app.okou.ai/mail/drafts/${reconnectDraftId})`,
      ].join("\n\n"),
      runId,
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
  expect(reconnectCard).toBeVisible();
  expect(reconnectCard).toHaveTextContent("Need reconnect");
});

test("Keep the work being read expanded as conversation groups change", async () => {
  const thread = continuityThread(33, 1, "Protected reading position");
  const firstRunId = "b1000000-0000-4000-a000-000000000331";
  const laterRunId = "b1000000-0000-4000-a000-000000000332";
  const responseBeingRead = outputRow(
    33,
    2,
    thread.id,
    "Response the reader is reviewing",
    firstRunId,
  );
  let rows = [
    promptRow(33, 1, thread.id, "Investigate the rollout", firstRunId),
    responseBeingRead,
    outputRow(33, 3, thread.id, "Current rollout conclusion", firstRunId),
  ];
  const workspace = installContinuityWorkspace(context, {
    caseId: 33,
    threads: [thread],
    chatEventRows: rows,
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  await screen.findByRole("textbox", { name: "Message" });
  await screen.findByText("Current rollout conclusion");
  click(fastButton("Expand work history"));
  const visibleResponse = await screen.findByText(
    "Response the reader is reviewing",
  );
  expect(visibleResponse).toBeVisible();
  expect(screen.getByText("Current rollout conclusion")).toBeVisible();
  const container = threadContainer(thread.id);
  const scroller = scrollContainer(thread.id);
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1600 },
    clientHeight: { configurable: true, value: 400 },
  });
  installReadingPositionGeometry(container, scroller, responseBeingRead.id);
  scroller.scrollTop = 500;
  fireEvent.scroll(scroller);
  await waitFor(() => {
    expect(container.querySelector("[data-scroll-to-bottom]")).toBeVisible();
  });

  const initialResponseTop = eventAnchor(
    container,
    responseBeingRead.id,
  ).getBoundingClientRect().top;
  rows = [
    ...rows,
    promptRow(33, 4, thread.id, "Continue the rollout work", laterRunId),
    outputRow(33, 5, thread.id, "Later rollout response", laterRunId),
  ];
  workspace.setChatEventRows(rows);
  createChatEvent(thread.id);

  await waitFor(() => {
    expect(screen.getByText("Later rollout response")).toBeVisible();
    expect(fastButton("Collapse work history", container)).toBeVisible();
  });
  const workHistory = fastButton("Collapse work history", container);
  expect(workHistory).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Response the reader is reviewing")).toBeVisible();
  expect(
    eventAnchor(container, responseBeingRead.id).getBoundingClientRect().top,
  ).toBe(initialResponseTop);
  expect(scroller.scrollTop).toBe(540);

  rows = [...rows, completedRow(33, 6, thread.id, laterRunId)];
  workspace.setChatEventRows(rows);
  createChatEvent(thread.id);

  await waitFor(() => {
    const laterResponse = screen
      .getByText("Later rollout response")
      .closest('[data-role="assistant"]');
    expect(laterResponse).toHaveTextContent("Worked for");
    expect(fastButton("Collapse work history", container)).toBeVisible();
  });
  const completedWork = fastButton("Collapse work history", container);
  expect(completedWork).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Response the reader is reviewing")).toBeVisible();
  expect(
    eventAnchor(container, responseBeingRead.id).getBoundingClientRect().top,
  ).toBe(initialResponseTop);
  expect(scroller.scrollTop).toBe(540);
});
