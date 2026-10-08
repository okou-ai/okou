import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  context,
  expectTextOrder,
  findButton,
  findEnabledButton,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000301";
const RESULT = "The API review is in progress.";
const STEER = "Focus on the authentication boundary first";
const NEXT_RESULT = "The authentication boundary review is ready.";

function createdAt(second: number): string {
  return `2026-08-01T10:00:${String(second).padStart(2, "0")}.000Z`;
}

function resultEvents(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "initial-request",
      runId: RUN_A,
      seqId: 1,
      text: "Review the API",
      createdAt: createdAt(0),
    }),
    assistantEvent({
      id: "review-artifact",
      runId: RUN_A,
      seqId: 2,
      text: "![Report](https://cdn.vm7.io/artifacts/steer/review/report.pdf)",
      createdAt: createdAt(1),
    }),
    assistantEvent({
      id: "initial-result",
      runId: RUN_A,
      seqId: 3,
      text: RESULT,
      createdAt: createdAt(2),
    }),
  ];
}

function pendingSteer(): MockChatEventInput {
  return promptEvent({
    id: "pending-steer",
    seqId: 4,
    text: STEER,
    createdAt: createdAt(12),
  });
}

function deliveredSteer(): MockChatEventInput {
  return {
    ...promptEvent({
      id: "delivered-steer",
      runId: RUN_A,
      seqId: 5,
      text: STEER,
      createdAt: createdAt(15),
    }),
    revokesEventId: "pending-steer",
  };
}

async function openChat(second: number): Promise<void> {
  mockNow(new Date(createdAt(second)), context.signal);
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();
}

function mainResult(text: string): HTMLElement {
  const main = screen
    .getByText(text)
    .closest<HTMLElement>("[data-chat-run-work-main]");
  if (!main) {
    throw new Error(`Expected a main result for ${text}`);
  }
  return main;
}

function assistantGroup(text: string): HTMLElement {
  const group = mainResult(text).closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  if (!group) {
    throw new Error(`Expected an assistant response for ${text}`);
  }
  return group;
}

function workSummary(text = RESULT): Element | null {
  return assistantGroup(text).querySelector("[data-chat-run-work]");
}

async function expectRetainedResult(): Promise<HTMLElement> {
  const main = mainResult(RESULT);
  expect(main).toBeVisible();
  const relatedArtifacts = await screen.findByTestId(
    "chat-run-related-artifacts-trigger",
  );
  expect(main).toContainElement(relatedArtifacts);
  expect(queryButton("Copy message", main)).toBeVisible();
  return relatedArtifacts;
}

function expectWaitingAfter(text: string): void {
  const waiting = document.querySelector("[data-thinking-indicator]");
  expect(waiting).toBeVisible();
  expect(document.querySelectorAll("[data-thinking-indicator]")).toHaveLength(
    1,
  );
  expect(
    screen.getByText(text).compareDocumentPosition(waiting!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

test("Keep the work boundary and elapsed time stable through steer delivery and completion", async () => {
  const events = [...resultEvents(), pendingSteer()];
  const chat = installRunChat({ chatEvents: events, activeRunIds: [RUN_A] });
  await openChat(12);
  expect(screen.getByText(STEER)).toBeVisible();
  expectWaitingAfter(STEER);
  expect.soft(workSummary()).toHaveTextContent("Worked for 12 sec");

  mockNow(new Date(createdAt(20)), context.signal);
  events.push(
    deliveredSteer(),
    assistantEvent({
      id: "result-after-steer",
      runId: RUN_A,
      seqId: 6,
      text: NEXT_RESULT,
      createdAt: createdAt(18),
    }),
  );
  publishRunUpdate();

  await expect(screen.findByText(NEXT_RESULT)).resolves.toBeVisible();
  expect(screen.getAllByText(STEER)).toHaveLength(1);
  expect(
    screen.queryByRole("listitem", { name: "Queued message" }),
  ).not.toBeInTheDocument();
  await expectRetainedResult();
  expect(queryButton("Copy message", mainResult(NEXT_RESULT))).toBeVisible();
  expectTextOrder(RESULT, STEER, NEXT_RESULT);
  expect.soft(workSummary()).toHaveTextContent("Worked for 12 sec");
  expect(workSummary(NEXT_RESULT)).toHaveTextContent("Working for");

  chat.completeRun();

  await waitFor(() => {
    expect(workSummary(NEXT_RESULT)).toHaveTextContent("Worked for");
  });
  expect.soft(workSummary()).toHaveTextContent("Worked for 12 sec");
  expect.soft(workSummary(NEXT_RESULT)).toHaveTextContent("Worked for 8 sec");
});

test("Keep separate histories, artifacts and actions on both sides of a steer in the same run", async () => {
  const oldHistory = [
    "Started the API review",
    "Checked the dependency graph",
    "Checked the service boundaries",
    "Checked the request gateways",
  ];
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "history-request",
        runId: RUN_A,
        seqId: 1,
        text: "Review the API",
        createdAt: createdAt(0),
      }),
      assistantEvent({
        id: "history-artifact",
        runId: RUN_A,
        seqId: 2,
        text: "![Report](https://cdn.vm7.io/artifacts/steer/review/report.pdf)",
        createdAt: createdAt(1),
      }),
      ...oldHistory.map((text, index) => {
        return assistantEvent({
          id: `history-${String(index)}`,
          runId: RUN_A,
          seqId: index + 3,
          text,
          createdAt: createdAt(index + 2),
        });
      }),
      assistantEvent({
        id: "history-result",
        runId: RUN_A,
        seqId: 7,
        text: RESULT,
        createdAt: createdAt(6),
      }),
      promptEvent({
        id: "history-steer",
        runId: RUN_A,
        seqId: 8,
        text: STEER,
        createdAt: createdAt(12),
      }),
      assistantEvent({
        id: "next-history",
        runId: RUN_A,
        seqId: 9,
        text: "Checked the token validation path",
        createdAt: createdAt(16),
      }),
      assistantEvent({
        id: "next-result",
        runId: RUN_A,
        seqId: 10,
        text: NEXT_RESULT,
        createdAt: createdAt(18),
      }),
    ],
    activeRunIds: [RUN_A],
  });

  await openChat(20);

  const relatedArtifacts = await expectRetainedResult();
  const previousGroup = assistantGroup(RESULT);
  const nextGroup = assistantGroup(NEXT_RESULT);
  expect(previousGroup).not.toBe(nextGroup);
  expect(previousGroup).toContainElement(relatedArtifacts);
  expect(
    previousGroup.querySelector("[data-chat-run-work-history-list]"),
  ).toBeNull();
  for (const text of oldHistory) {
    expect(screen.queryByText(text)).toBeNull();
  }
  expect(screen.queryByText("Checked the token validation path")).toBeNull();
  expect(
    nextGroup.querySelector("[data-chat-run-work-history-list]"),
  ).toBeNull();
  expect(queryButton("Expand work history", nextGroup)).toBeVisible();
  expect(queryButton("Copy message", mainResult(NEXT_RESULT))).toBeVisible();
  expect(screen.getAllByTestId("chat-event-actions")).toHaveLength(2);
  expect(nextGroup).not.toContainElement(relatedArtifacts);
  expect(workSummary()).toHaveTextContent("Worked for");
  expect(workSummary(NEXT_RESULT)).toHaveTextContent("Working for");
  expectWaitingAfter(NEXT_RESULT);
  expectTextOrder(RESULT, STEER, NEXT_RESULT);
});

function textNode(text: string): Text {
  const node = screen.getByText(text).firstChild;
  if (!(node instanceof Text)) {
    throw new Error(`Expected a text node for ${text}`);
  }
  return node;
}

function statusRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    '[data-role="assistant-thinking"]',
  );
  if (!row) {
    throw new Error("Expected a run status row");
  }
  return row;
}

// The user selects the conversation tail, from their message through the run
// status row, as they would before copying it.
function selectFromMessageThroughStatus(text: string): void {
  const row = statusRow();
  const range = document.createRange();
  range.setStart(textNode(text), 0);
  range.setEnd(row, row.childNodes.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectedText(): string {
  return window.getSelection()?.toString().replace(/\s+/gu, " ").trim() ?? "";
}

test("Keep the selected prompt and status row when a run claims the prompt", async () => {
  const events: MockChatEventInput[] = [
    promptEvent({
      id: "queued-request",
      seqId: 1,
      text: "Review the API",
      createdAt: createdAt(0),
    }),
  ];
  installRunChat({ chatEvents: events });
  await openChat(1);
  await expect(findButton("queue...")).resolves.toBeInTheDocument();
  selectFromMessageThroughStatus("Review the API");

  events.push({
    ...promptEvent({
      id: RUN_A,
      runId: RUN_A,
      seqId: 2,
      text: "Review the API",
      createdAt: createdAt(1),
    }),
    revokesEventId: "queued-request",
  });
  publishRunUpdate();

  await expect(screen.findByText("Thinking...")).resolves.toBeInTheDocument();
  expect(queryButton("queue...")).toBeNull();
  expect(screen.getAllByText("Review the API")).toHaveLength(1);
  const selected = selectedText();
  expect(selected.startsWith("Review the API")).toBeTruthy();
  expect(selected.endsWith("Thinking...")).toBeTruthy();
});

test("Keep the selected steer and status row through steer delivery and the first result", async () => {
  const events = [...resultEvents(), pendingSteer()];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_A] });
  await openChat(12);
  expectWaitingAfter(STEER);
  selectFromMessageThroughStatus(STEER);

  mockNow(new Date(createdAt(20)), context.signal);
  events.push(
    deliveredSteer(),
    assistantEvent({
      id: "result-after-steer",
      runId: RUN_A,
      seqId: 6,
      text: NEXT_RESULT,
      createdAt: createdAt(18),
    }),
  );
  publishRunUpdate();

  await expect(screen.findByText(NEXT_RESULT)).resolves.toBeInTheDocument();
  expectWaitingAfter(NEXT_RESULT);
  const selected = selectedText();
  expect(selected.startsWith(STEER)).toBeTruthy();
  expect(selected).toContain(NEXT_RESULT);
  expect(selected.endsWith("Thinking...")).toBeTruthy();
});

test("Stop interrupts the live run and keeps the queued follow-up", async () => {
  const interrupted: string[] = [];
  const recalled: string[] = [];
  installRunChat({
    chatEvents: [...resultEvents(), pendingSteer()],
    activeRunIds: [RUN_A],
    onInterruptEventAppend: ({ interruptsRunId }) => {
      interrupted.push(interruptsRunId);
    },
    onRecallEventAppend: ({ revokesEventId }) => {
      recalled.push(revokesEventId);
    },
  });
  await openChat(12);
  expect(screen.getByText(STEER)).toBeVisible();

  click(await findEnabledButton("Stop"));

  await waitFor(() => {
    expect(interrupted).toStrictEqual([RUN_A]);
  });
  expect(recalled).toStrictEqual([]);
  expect(screen.getByText(STEER)).toBeVisible();
  expect(
    screen.queryByRole("listitem", { name: "Queued message" }),
  ).not.toBeInTheDocument();
});
