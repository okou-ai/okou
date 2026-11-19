import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { changeChatIndicators } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  createChatRunFixtures,
  expectTextOrder,
  findEnabledButton,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_ID = "a0000000-0000-4000-a000-000000000601";
const SECOND = 1000;

function isoAt(time: number): string {
  return new Date(time).toISOString();
}

function artifactUrl(name: string): string {
  return `https://cdn.vm7.io/artifacts/run-steer/${name}/${name}.pdf`;
}

function userTurnCount(text: string): number {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-role="user"]'),
  ).filter((turn) => {
    return turn.textContent?.includes(text) === true;
  }).length;
}

function queuedMessageRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[role="listitem"][aria-label="Queued message"]',
  );
}

function statusRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    '[data-role="assistant-thinking"]',
  );
  if (!row) {
    throw new Error("Run status row is not visible");
  }
  return row;
}

function resultActions(text: string): HTMLElement {
  const actions = screen
    .getByText(text)
    .closest<HTMLElement>("[data-chat-run-work-main]")
    ?.querySelector<HTMLElement>('[data-testid="chat-event-actions"]');
  if (!actions) {
    throw new Error(`${text} has no result actions`);
  }
  return actions;
}

function workDuration(text: string): string | null | undefined {
  return screen
    .getByText(text)
    .closest<HTMLElement>('[data-role="assistant"]')
    ?.querySelector("[data-chat-run-work] time")?.textContent;
}

function selectionText(): string {
  return (document.getSelection()?.toString() ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function selectFromPromptThroughStatus(prompt: string): void {
  const turn = Array.from(
    document.querySelectorAll<HTMLElement>('[data-role="user"]'),
  ).find((candidate) => {
    return candidate.textContent?.includes(prompt) === true;
  });
  const walker = turn
    ? document.createTreeWalker(turn, NodeFilter.SHOW_TEXT)
    : null;
  let start: Node | null = walker?.nextNode() ?? null;
  while (start && !start.textContent?.includes(prompt)) {
    start = walker?.nextNode() ?? null;
  }
  if (!start) {
    throw new Error(`${prompt} text is not rendered`);
  }
  const end = statusRow();
  const range = document.createRange();
  range.setStart(start, start.textContent?.indexOf(prompt) ?? 0);
  range.setEnd(end, end.childNodes.length);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function openRunChat(
  chatEvents: MockChatEventInput[],
  activeRunIds: string[],
): Promise<void> {
  installRunChat({ chatEvents, activeRunIds });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
}

test("Keep the work boundary and elapsed time stable through steer delivery and completion", async () => {
  const runStart = now() - 30 * SECOND;
  const chatEvents: MockChatEventInput[] = [
    promptEvent({
      id: "api-request",
      runId: RUN_ID,
      seqId: 1,
      text: "Review the API",
      createdAt: isoAt(runStart),
    }),
    assistantEvent({
      id: "api-notes",
      runId: RUN_ID,
      seqId: 2,
      text: `Saved the API review notes.\n\n[API review](${artifactUrl("api-review")})`,
      createdAt: isoAt(runStart + 6 * SECOND),
    }),
    assistantEvent({
      id: "api-result",
      runId: RUN_ID,
      seqId: 3,
      text: "API review result",
      createdAt: isoAt(runStart + 10 * SECOND),
    }),
    {
      ...promptEvent({
        id: "error-codes-steer",
        seqId: 4,
        text: "Also check the error codes",
        createdAt: isoAt(runStart + 12 * SECOND),
      }),
      runId: undefined,
    },
  ];
  const activeRunIds = [RUN_ID];
  await openRunChat(chatEvents, activeRunIds);
  await expect(screen.findByText("API review result")).resolves.toBeVisible();
  expect(userTurnCount("Also check the error codes")).toBe(1);

  chatEvents.push(
    {
      ...promptEvent({
        id: "error-codes-delivered",
        runId: RUN_ID,
        seqId: 5,
        text: "Also check the error codes",
        createdAt: isoAt(runStart + 12 * SECOND),
      }),
      revokesEventId: "error-codes-steer",
    },
    assistantEvent({
      id: "error-code-notes",
      runId: RUN_ID,
      seqId: 6,
      text: `Saved the error code table.\n\n[Error codes](${artifactUrl("error-codes")})`,
      createdAt: isoAt(runStart + 14 * SECOND),
    }),
    assistantEvent({
      id: "error-code-result",
      runId: RUN_ID,
      seqId: 7,
      text: "Error code review result",
      createdAt: isoAt(runStart + 16 * SECOND),
    }),
  );
  publishRunUpdate();
  await expect(
    screen.findByText("Error code review result"),
  ).resolves.toBeVisible();
  expect(workDuration("API review result")).toBe("Worked for 12 sec");

  chatEvents.push(
    completedEvent({
      id: "steer-run-complete",
      runId: RUN_ID,
      seqId: 8,
      createdAt: isoAt(runStart + 20 * SECOND),
    }),
  );
  activeRunIds.splice(0);
  publishRunUpdate();
  changeChatIndicators();

  await waitFor(() => {
    expect(workDuration("Error code review result")).toBe("Worked for 8 sec");
  });
  expect(workDuration("API review result")).toBe("Worked for 12 sec");
  expectTextOrder(
    "API review result",
    "Also check the error codes",
    "Error code review result",
  );
  expect(userTurnCount("Also check the error codes")).toBe(1);
  expect(queuedMessageRow()).toBeNull();
  for (const result of ["API review result", "Error code review result"]) {
    const actions = resultActions(result);
    expect(queryButton("Copy message", actions)).toBeVisible();
    expect(
      within(actions).getByTestId("chat-run-related-artifacts-trigger"),
    ).toHaveAccessibleName("1 artifact");
  }
  expect(resultActions("API review result")).not.toBe(
    resultActions("Error code review result"),
  );
});

test("Keep the selected prompt and status row when a run claims the prompt", async () => {
  const chatEvents: MockChatEventInput[] = [
    {
      ...promptEvent({ id: "queued-review", seqId: 1, text: "Review the API" }),
      runId: undefined,
    },
  ];
  const activeRunIds: string[] = [];
  await openRunChat(chatEvents, activeRunIds);
  await waitFor(() => {
    expect(statusRow()).toHaveTextContent("Waiting in queue...");
  });
  selectFromPromptThroughStatus("Review the API");
  expect(selectionText()).toMatch(/^Review the API.*Waiting in queue\.\.\.$/u);

  chatEvents.push({
    ...promptEvent({
      id: "claimed-review",
      runId: RUN_ID,
      seqId: 2,
      text: "Review the API",
    }),
    revokesEventId: "queued-review",
  });
  activeRunIds.push(RUN_ID);
  publishRunUpdate();
  changeChatIndicators();

  await waitFor(() => {
    expect(statusRow()).toHaveTextContent("Thinking...");
  });
  expect(queryButton("queue...")).toBeNull();
  expect(userTurnCount("Review the API")).toBe(1);
  expect(selectionText()).toMatch(/^Review the API.*Thinking\.\.\.$/u);
});

test("Stop interrupts the live run and keeps the queued follow-up", async () => {
  const chatEvents: MockChatEventInput[] = [
    promptEvent({
      id: "rollout-request",
      runId: RUN_ID,
      seqId: 1,
      text: "Draft the rollout",
    }),
    assistantEvent({
      id: "rollout-progress",
      runId: RUN_ID,
      seqId: 2,
      text: "Rollout outline in progress",
    }),
    {
      ...promptEvent({
        id: "appendix-steer",
        seqId: 3,
        text: "Add the appendix",
      }),
      runId: undefined,
    },
  ];
  const activeRunIds = [RUN_ID];
  const sends: {
    readonly interruptsRunId?: string;
    readonly revokesEventId?: string;
  }[] = [];
  installRunChat({ chatEvents, activeRunIds });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    sends.push({
      ...("interruptsRunId" in body && body.interruptsRunId
        ? { interruptsRunId: body.interruptsRunId }
        : {}),
      ...("revokesEventId" in body && body.revokesEventId
        ? { revokesEventId: body.revokesEventId }
        : {}),
    });
    if ("interruptsRunId" in body && body.interruptsRunId) {
      chatEvents.push(
        {
          id: body.clientEventId ?? "rollout-interrupt",
          role: "user",
          content: null,
          interruptsRunId: body.interruptsRunId,
          seqId: 4,
          createdAt: "2026-08-01T10:00:04.000Z",
        },
        cancelledEvent({ id: "rollout-cancelled", runId: RUN_ID, seqId: 5 }),
      );
      activeRunIds.splice(0);
      publishRunUpdate();
      changeChatIndicators();
    }
    return respond(201, {
      threadId: body.threadId ?? "",
      createdAt: "2026-08-01T10:00:04.000Z",
    });
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await expect(
    screen.findByText("Rollout outline in progress"),
  ).resolves.toBeVisible();

  click(await findEnabledButton("Stop"));

  await waitFor(() => {
    expect(sends).toStrictEqual([{ interruptsRunId: RUN_ID }]);
  });
  await waitFor(() => {
    expect(queryButton("Stop")).toBeNull();
  });
  expect(userTurnCount("Add the appendix")).toBe(1);
  expect(screen.getByText("Add the appendix")).toBeVisible();
  expect(queuedMessageRow()).toBeNull();
  expect(queryButton("queue...")).toBeNull();
});
