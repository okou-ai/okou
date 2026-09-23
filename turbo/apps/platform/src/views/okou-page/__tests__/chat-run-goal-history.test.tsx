import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  context,
  creditUsage,
  expectTextOrder,
  findWorkHistoryToggle,
  installRunChat,
  promptEvent,
  queryWorkHistoryToggles,
  readyChat,
  RUN_PATH,
  usageEvent,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000201";
const RUN_B = "a0000000-0000-4000-a000-000000000202";
const RUN_C = "a0000000-0000-4000-a000-000000000203";
const RUN_D = "a0000000-0000-4000-a000-000000000204";

function createdAt(minute: number, second = 0): string {
  return `2026-08-01T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

function goalContinuationEvent(args: {
  readonly id: string;
  readonly runId: string;
  readonly runGroupId: string;
  readonly seqId: number;
  readonly brief: string;
  readonly model: string;
  readonly createdAt: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "user",
    eventType: "input.prompt",
    content: null,
    runId: args.runId,
    runGroupId: args.runGroupId,
    seqId: args.seqId,
    createdAt: args.createdAt,
    userMessage: {
      version: 1,
      parts: [
        { type: "goal", goalBrief: args.brief },
        { type: "model", selectedModel: args.model },
      ],
    },
  };
}

function inRunGroup(
  event: MockChatEventInput,
  runGroupId: string,
): MockChatEventInput {
  return { ...event, runGroupId };
}

test("A runless message stays outside later work history", async () => {
  const groupId = "e0000000-0000-4000-a000-000000000299";
  installRunChat({
    chatEvents: [
      {
        id: "runless-welcome",
        eventType: "output.message",
        runId: undefined,
        content: "The complete welcome before any run",
        createdAt: createdAt(0),
        seqId: 1,
      },
      goalContinuationEvent({
        id: "later-work-input",
        runId: RUN_A,
        runGroupId: groupId,
        seqId: 2,
        brief: "Continue the actual task",
        model: "gpt-5.6-sol",
        createdAt: createdAt(1),
      }),
      inRunGroup(
        assistantEvent({
          id: "later-work-output",
          runId: RUN_A,
          seqId: 3,
          text: "The actual work result",
          createdAt: createdAt(1, 20),
        }),
        groupId,
      ),
      inRunGroup(
        completedEvent({
          id: "later-work-completed",
          runId: RUN_A,
          seqId: 4,
          createdAt: createdAt(1, 21),
        }),
        groupId,
      ),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await expect(
    screen.findByText("The complete welcome before any run"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Continue the actual task")).toBeVisible();
  expect(screen.getByText("The actual work result")).toBeVisible();
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(0);
  expect(screen.getAllByText(/^Worked for /u)).toHaveLength(1);
});

test("Review goal continuations as one work history", async () => {
  const goalGroupId = "e0000000-0000-4000-a000-000000000211";
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "goal-work-trigger",
        runId: RUN_A,
        seqId: 1,
        text: "Review the launch readiness",
        model: "gpt-5.6-sol",
        createdAt: createdAt(0),
      }),
      assistantEvent({
        id: "goal-work-initial",
        runId: RUN_A,
        seqId: 2,
        text: "Checked the initial launch evidence",
        createdAt: createdAt(0, 20),
      }),
      completedEvent({
        id: "goal-work-trigger-complete",
        runId: RUN_A,
        seqId: 3,
        createdAt: createdAt(0, 21),
      }),
      usageEvent({
        id: "goal-work-trigger-usage",
        runId: RUN_A,
        seqId: 4,
        usage: creditUsage(2, [], createdAt(0, 22)),
      }),
      goalContinuationEvent({
        id: "goal-work-first-continuation",
        runId: RUN_B,
        runGroupId: goalGroupId,
        seqId: 5,
        brief: "Keep checking launch readiness",
        model: "gpt-5.6-sol",
        createdAt: createdAt(1),
      }),
      inRunGroup(
        assistantEvent({
          id: "goal-work-middle",
          runId: RUN_B,
          seqId: 6,
          text: "Validated the regional rollout",
          createdAt: createdAt(1, 20),
        }),
        goalGroupId,
      ),
      inRunGroup(
        completedEvent({
          id: "goal-work-first-complete",
          runId: RUN_B,
          seqId: 7,
          createdAt: createdAt(1, 21),
        }),
        goalGroupId,
      ),
      inRunGroup(
        usageEvent({
          id: "goal-work-first-usage",
          runId: RUN_B,
          seqId: 8,
          usage: creditUsage(3, [], createdAt(1, 22)),
        }),
        goalGroupId,
      ),
      goalContinuationEvent({
        id: "goal-work-second-continuation",
        runId: RUN_C,
        runGroupId: goalGroupId,
        seqId: 9,
        brief: "Finish checking launch readiness",
        model: "gpt-5.6-sol",
        createdAt: createdAt(2),
      }),
      inRunGroup(
        assistantEvent({
          id: "goal-work-final",
          runId: RUN_C,
          seqId: 10,
          text: "The launch is ready in every region",
          createdAt: createdAt(2, 20),
        }),
        goalGroupId,
      ),
      inRunGroup(
        completedEvent({
          id: "goal-work-final-complete",
          runId: RUN_C,
          seqId: 11,
          createdAt: createdAt(2, 21),
        }),
        goalGroupId,
      ),
      inRunGroup(
        usageEvent({
          id: "goal-work-final-usage",
          runId: RUN_C,
          seqId: 12,
          usage: creditUsage(5, [], createdAt(2, 22)),
        }),
        goalGroupId,
      ),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  expect(screen.getByText("Review the launch readiness")).toBeVisible();
  expect(screen.getByText("The launch is ready in every region")).toBeVisible();
  expect(screen.getByLabelText("Credit usage 10")).toBeVisible();
  expect(screen.queryByText("Checked the initial launch evidence")).toBeNull();
  expect(screen.queryByText("Validated the regional rollout")).toBeNull();
  expect(screen.queryByText("Keep checking launch readiness")).toBeNull();
  expect(screen.queryByText("Finish checking launch readiness")).toBeNull();

  click(await findWorkHistoryToggle("collapsed"));
  await expect(
    screen.findByText("Checked the initial launch evidence"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Validated the regional rollout")).toBeVisible();
  expect(screen.queryByText("Keep checking launch readiness")).toBeNull();
  expect(screen.queryByText("Finish checking launch readiness")).toBeNull();
  expectTextOrder(
    "Review the launch readiness",
    "Checked the initial launch evidence",
    "Validated the regional rollout",
    "The launch is ready in every region",
  );
});

const WAITING_GOAL_GROUP_ID = "e0000000-0000-4000-a000-000000000214";

async function renderWaitingGoalContinuation(currentRunGroupId: string) {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "waiting-goal-trigger",
        runId: RUN_A,
        seqId: 1,
        text: "Keep checking the release",
        model: "gpt-5.6-sol",
        createdAt: createdAt(0),
      }),
      assistantEvent({
        id: "waiting-goal-trigger-work",
        runId: RUN_A,
        seqId: 2,
        text: "Started checking the release",
        createdAt: createdAt(0, 20),
      }),
      completedEvent({
        id: "waiting-goal-trigger-complete",
        runId: RUN_A,
        seqId: 3,
        createdAt: createdAt(0, 21),
      }),
      goalContinuationEvent({
        id: "waiting-goal-first-continuation",
        runId: RUN_B,
        runGroupId: WAITING_GOAL_GROUP_ID,
        seqId: 4,
        brief: "Continue checking the release",
        model: "gpt-5.6-sol",
        createdAt: createdAt(1),
      }),
      inRunGroup(
        assistantEvent({
          id: "waiting-goal-latest-answer",
          runId: RUN_B,
          seqId: 5,
          text: "The latest release gate passed",
          createdAt: createdAt(1, 20),
        }),
        WAITING_GOAL_GROUP_ID,
      ),
      inRunGroup(
        completedEvent({
          id: "waiting-goal-first-complete",
          runId: RUN_B,
          seqId: 6,
          createdAt: createdAt(1, 21),
        }),
        WAITING_GOAL_GROUP_ID,
      ),
      goalContinuationEvent({
        id: "waiting-goal-current-continuation",
        runId: RUN_C,
        runGroupId: currentRunGroupId,
        seqId: 7,
        brief: "Continue checking the release",
        model: "gpt-5.6-sol",
        createdAt: createdAt(2),
      }),
      {
        id: "waiting-goal-queued-automation",
        role: "user",
        eventType: "input.automation",
        content: null,
        runId: undefined,
        seqId: 8,
        createdAt: createdAt(2, 1),
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "release-followup",
              automationBrief: "Queued release follow-up",
            },
          ],
        },
      },
    ],
    activeRunIds: [RUN_C],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const latestAnswer = await screen.findByText(
    "The latest release gate passed",
  );
  const previousAssistantGroup = latestAnswer.closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  const thinkingIndicator = document.querySelector<HTMLElement>(
    "[data-thinking-indicator]",
  );
  if (!previousAssistantGroup || !thinkingIndicator) {
    throw new Error("Expected the active goal in an assistant response");
  }

  return { previousAssistantGroup, thinkingIndicator };
}

test("Keep a waiting goal continuation grouped with queued automation", async () => {
  const { previousAssistantGroup, thinkingIndicator } =
    await renderWaitingGoalContinuation(WAITING_GOAL_GROUP_ID);

  await expect(
    screen.findByRole("listitem", { name: "Pending automation event" }),
  ).resolves.toBeVisible();
  expect(previousAssistantGroup).toContainElement(thinkingIndicator);
  expect(
    queryAllByRoleFast("link").filter((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    }),
  ).toHaveLength(1);
  expect(screen.getByText(/^Working for /u)).toBeVisible();
});

test("Keep a waiting different goal in a separate assistant group", async () => {
  const { previousAssistantGroup, thinkingIndicator } =
    await renderWaitingGoalContinuation("e0000000-0000-4000-a000-000000000215");

  expect(previousAssistantGroup).not.toContainElement(thinkingIndicator);
  expect(
    queryAllByRoleFast("link").filter((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    }),
  ).toHaveLength(2);
});

test("Keep a cancelled goal continuation beside its latest answer", async () => {
  const goalGroupId = "e0000000-0000-4000-a000-000000000212";
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "cancelled-goal-trigger",
        runId: RUN_A,
        seqId: 1,
        text: "Investigate the deployment",
        model: "gpt-5.6-sol",
        createdAt: createdAt(0),
      }),
      assistantEvent({
        id: "cancelled-goal-initial",
        runId: RUN_A,
        seqId: 2,
        text: "Checked the deployment logs",
        createdAt: createdAt(0, 20),
      }),
      completedEvent({
        id: "cancelled-goal-trigger-complete",
        runId: RUN_A,
        seqId: 3,
        createdAt: createdAt(0, 21),
      }),
      goalContinuationEvent({
        id: "cancelled-goal-luna-continuation",
        runId: RUN_B,
        runGroupId: goalGroupId,
        seqId: 4,
        brief: "Continue the deployment investigation with Luna",
        model: "gpt-5.6-luna",
        createdAt: createdAt(1),
      }),
      inRunGroup(
        assistantEvent({
          id: "cancelled-goal-latest-answer",
          runId: RUN_B,
          seqId: 5,
          text: "The latest deployment evidence is preserved",
          createdAt: createdAt(1, 20),
        }),
        goalGroupId,
      ),
      goalContinuationEvent({
        id: "cancelled-goal-sol-continuation",
        runId: RUN_C,
        runGroupId: goalGroupId,
        seqId: 6,
        brief: "Continue the deployment investigation with Sol",
        model: "gpt-5.6-sol",
        createdAt: createdAt(2),
      }),
      {
        id: "cancelled-goal-interrupt",
        role: "user",
        eventType: "control.interrupt",
        content: null,
        interruptsRunId: RUN_C,
        runGroupId: goalGroupId,
        seqId: 7,
        createdAt: createdAt(2, 10),
      },
      inRunGroup(
        cancelledEvent({
          id: "cancelled-goal-terminal",
          runId: RUN_C,
          seqId: 8,
        }),
        goalGroupId,
      ),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const latestAnswer = screen.getByText(
    "The latest deployment evidence is preserved",
  );
  const paused = screen.getByText("Run paused — resume anytime.");
  const assistantGroup = latestAnswer.closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  if (!assistantGroup) {
    throw new Error("Expected the retained answer in an assistant response");
  }
  expect(assistantGroup).toContainElement(paused);
  expect(
    queryAllByRoleFast("link", assistantGroup).filter((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    }),
  ).toHaveLength(1);
  expect(screen.queryByText("Model changed to GPT 5.6 Luna")).toBeNull();
  expect(screen.queryByText("Model changed to GPT 5.6 Sol")).toBeNull();
  expect(
    screen.queryByText("Continue the deployment investigation with Luna"),
  ).toBeNull();
  expect(
    screen.queryByText("Continue the deployment investigation with Sol"),
  ).toBeNull();

  click(await findWorkHistoryToggle("collapsed"));
  await expect(
    screen.findByText("Checked the deployment logs"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Model changed to GPT 5.6 Luna")).toBeVisible();
  expect(screen.getByText("Model changed to GPT 5.6 Sol")).toBeVisible();
  expectTextOrder(
    "Checked the deployment logs",
    "Model changed to GPT 5.6 Luna",
    "The latest deployment evidence is preserved",
    "Model changed to GPT 5.6 Sol",
    "Run paused — resume anytime.",
  );
});

test("Start a fresh work history after interrupting a goal continuation", async () => {
  const goalGroupId = "e0000000-0000-4000-a000-000000000213";
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "interrupted-goal-trigger",
        runId: RUN_A,
        seqId: 1,
        text: "Review the first rollout",
        model: "gpt-5.6-sol",
      }),
      assistantEvent({
        id: "interrupted-goal-hidden-work",
        runId: RUN_A,
        seqId: 2,
        text: "Checked the first rollout logs",
      }),
      completedEvent({
        id: "interrupted-goal-trigger-complete",
        runId: RUN_A,
        seqId: 3,
      }),
      goalContinuationEvent({
        id: "interrupted-goal-continuation",
        runId: RUN_B,
        runGroupId: goalGroupId,
        seqId: 4,
        brief: "Keep reviewing the first rollout",
        model: "gpt-5.6-sol",
        createdAt: createdAt(0, 4),
      }),
      inRunGroup(
        assistantEvent({
          id: "interrupted-goal-answer",
          runId: RUN_B,
          seqId: 5,
          text: "The first rollout evidence is ready",
        }),
        goalGroupId,
      ),
      {
        id: "interrupted-goal-control",
        role: "user",
        eventType: "control.interrupt",
        content: null,
        interruptsRunId: RUN_B,
        runGroupId: goalGroupId,
        seqId: 6,
        createdAt: createdAt(0, 6),
      },
      inRunGroup(
        cancelledEvent({
          id: "interrupted-goal-cancelled",
          runId: RUN_B,
          seqId: 7,
        }),
        goalGroupId,
      ),
      promptEvent({
        id: "fresh-work-trigger",
        runId: RUN_D,
        seqId: 8,
        text: "Review the replacement rollout",
        model: "gpt-5.6-sol",
      }),
      assistantEvent({
        id: "fresh-work-hidden",
        runId: RUN_D,
        seqId: 9,
        text: "Checked the replacement rollout logs",
      }),
      assistantEvent({
        id: "fresh-work-final",
        runId: RUN_D,
        seqId: 10,
        text: "The replacement rollout is healthy",
      }),
      completedEvent({
        id: "fresh-work-complete",
        runId: RUN_D,
        seqId: 11,
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const workHistories = document.querySelectorAll(
    "[data-chat-run-work-history]",
  );
  expect(workHistories).toHaveLength(2);
  expect(screen.queryByText("Checked the first rollout logs")).toBeNull();
  expect(screen.queryByText("Checked the replacement rollout logs")).toBeNull();
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(2);
});
