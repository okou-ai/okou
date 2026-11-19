import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  AGENT_ID,
  chatScrollContainer,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  creditUsage,
  expectTextOrder,
  findWorkHistoryToggle,
  promptEvent,
  publishRunUpdate,
  queryButton,
  queryWorkHistoryToggles,
  readyChat,
  RUN_PATH,
  usageEvent,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const PHASE_ONE_RUN_ID = "a0000000-0000-4000-a000-000000000301";
const PHASE_TWO_RUN_ID = "a0000000-0000-4000-a000-000000000302";
const ACTIVE_RUN_ID = "a0000000-0000-4000-a000-000000000303";
const EARLIER_RUN_ID = "a0000000-0000-4000-a000-000000000304";
const COMPLETED_RUN_ID = "a0000000-0000-4000-a000-000000000305";

const MINUTE = 60_000;

function isoAt(time: number): string {
  return new Date(time).toISOString();
}

function workStatusLabels(prefix: "Working for" | "Worked for"): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-chat-run-work] time"),
  ).filter((element) => {
    return element.textContent?.startsWith(prefix) === true;
  });
}

function thinkingIndicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-thinking-indicator]");
}

function agentProfileLinks(): HTMLElement[] {
  return queryAllByRoleFast("link").filter((link) => {
    return link.getAttribute("aria-label") === "View agent profile";
  });
}

function resultActions(): HTMLElement[] {
  return screen.queryAllByTestId("chat-event-actions");
}

async function openRunChat(
  chatEvents: MockChatEventInput[],
  options: {
    readonly activeRunIds?: string[];
    readonly featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  } = {},
): Promise<HTMLElement> {
  installRunChat({
    chatEvents,
    ...(options.activeRunIds === undefined
      ? {}
      : { activeRunIds: options.activeRunIds }),
  });
  await setupPage({
    context,
    path: RUN_PATH,
    ...(options.featureSwitches === undefined
      ? {}
      : { featureSwitches: options.featureSwitches }),
  });
  return readyChat();
}

function twoPhaseConversation(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "phase-one-request",
      runId: PHASE_ONE_RUN_ID,
      seqId: 1,
      text: "Plan phase one",
      createdAt: "2026-08-01T10:00:00.000Z",
    }),
    assistantEvent({
      id: "phase-one-requirements",
      runId: PHASE_ONE_RUN_ID,
      seqId: 2,
      text: "Collected requirements",
      createdAt: "2026-08-01T10:00:30.000Z",
    }),
    assistantEvent({
      id: "phase-one-outline",
      runId: PHASE_ONE_RUN_ID,
      seqId: 3,
      text: "Phase one outline",
      createdAt: "2026-08-01T10:01:00.000Z",
    }),
    promptEvent({
      id: "phase-one-follow-up",
      runId: PHASE_ONE_RUN_ID,
      seqId: 4,
      text: "Tighten phase one",
      createdAt: "2026-08-01T10:01:00.000Z",
    }),
    assistantEvent({
      id: "phase-one-dependencies",
      runId: PHASE_ONE_RUN_ID,
      seqId: 5,
      text: "Checked dependencies",
      createdAt: "2026-08-01T10:01:30.000Z",
    }),
    assistantEvent({
      id: "phase-one-final-plan",
      runId: PHASE_ONE_RUN_ID,
      seqId: 6,
      text: "Phase one final plan",
      createdAt: "2026-08-01T10:02:00.000Z",
    }),
    completedEvent({
      id: "phase-one-complete",
      runId: PHASE_ONE_RUN_ID,
      seqId: 7,
      createdAt: "2026-08-01T10:02:00.000Z",
    }),
    promptEvent({
      id: "phase-two-request",
      runId: PHASE_TWO_RUN_ID,
      seqId: 8,
      text: "Plan phase two",
      createdAt: "2026-08-01T10:03:00.000Z",
    }),
    assistantEvent({
      id: "phase-two-rollout",
      runId: PHASE_TWO_RUN_ID,
      seqId: 9,
      text: "Drafted the rollout",
      createdAt: "2026-08-01T10:04:00.000Z",
    }),
    assistantEvent({
      id: "phase-two-outline",
      runId: PHASE_TWO_RUN_ID,
      seqId: 10,
      text: "Phase two outline",
      createdAt: "2026-08-01T10:05:00.000Z",
    }),
    completedEvent({
      id: "phase-two-complete",
      runId: PHASE_TWO_RUN_ID,
      seqId: 11,
      createdAt: "2026-08-01T10:05:00.000Z",
    }),
  ];
}

function fiveOutputRun(runId: string): MockChatEventInput[] {
  return [
    promptEvent({
      id: `${runId}-request`,
      runId,
      seqId: 1,
      text: "Prepare the launch review",
    }),
    ...[1, 2, 3, 4, 5].map((index) => {
      return assistantEvent({
        id: `${runId}-output-${index.toString()}`,
        runId,
        seqId: index + 1,
        text: `Launch review output ${index.toString()}`,
      });
    }),
  ];
}

test("Expand the first completed conversation phase", async () => {
  await openRunChat(twoPhaseConversation());
  await waitFor(() => {
    expect(queryWorkHistoryToggles("collapsed")).toHaveLength(3);
  });
  expect(screen.queryByText("Collected requirements")).toBeNull();

  const firstAnswer = screen.getByText("Phase one outline");
  const firstGroup = firstAnswer.closest<HTMLElement>(
    '[data-role="assistant"]',
  );
  if (!firstGroup) {
    throw new Error("Phase one answer has no assistant group");
  }
  click(await findWorkHistoryToggle("collapsed", firstGroup));

  await expect(
    screen.findByText("Collected requirements"),
  ).resolves.toBeVisible();
  expectTextOrder(
    "Plan phase one",
    "Collected requirements",
    "Phase one outline",
  );
  expect(screen.queryByText("Checked dependencies")).toBeNull();
  expect(screen.queryByText("Drafted the rollout")).toBeNull();
});

test("Project an active run with one output message", async () => {
  await openRunChat(
    [
      promptEvent({
        id: "single-output-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Draft the agenda",
      }),
      assistantEvent({
        id: "single-output",
        runId: ACTIVE_RUN_ID,
        seqId: 2,
        text: "Agenda draft in progress",
      }),
    ],
    { activeRunIds: [ACTIVE_RUN_ID] },
  );

  await expect(
    screen.findByText("Agenda draft in progress"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(thinkingIndicator()).toBeVisible();
  });
  expect(workStatusLabels("Working for")).toHaveLength(1);
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(0);
  expect(queryWorkHistoryToggles("expanded")).toHaveLength(0);
});

test("Exclude initial queue wait from active and completed work for input.prompt", async () => {
  const currentTime = now();
  const earlierStart = currentTime - 3 * 60 * MINUTE;
  const deliveredAt = currentTime - 72 * MINUTE;
  const queuedAt = deliveredAt - 60 * MINUTE - 40_000;
  const chatEvents: MockChatEventInput[] = [
    promptEvent({
      id: "earlier-request",
      runId: EARLIER_RUN_ID,
      seqId: 1,
      text: "Audit the earlier release",
      createdAt: isoAt(earlierStart),
    }),
    assistantEvent({
      id: "earlier-answer",
      runId: EARLIER_RUN_ID,
      seqId: 2,
      text: "Earlier release audited",
      createdAt: isoAt(earlierStart + 84 * MINUTE),
    }),
    completedEvent({
      id: "earlier-complete",
      runId: EARLIER_RUN_ID,
      seqId: 3,
      createdAt: isoAt(earlierStart + 84 * MINUTE),
    }),
    {
      ...promptEvent({
        id: "queued-request",
        seqId: 4,
        text: "Audit the current release",
        createdAt: isoAt(queuedAt),
      }),
      runId: undefined,
    },
    {
      ...promptEvent({
        id: "delivered-request",
        runId: ACTIVE_RUN_ID,
        seqId: 5,
        text: "Audit the current release",
        createdAt: isoAt(deliveredAt),
      }),
      revokesEventId: "queued-request",
    },
    assistantEvent({
      id: "current-answer",
      runId: ACTIVE_RUN_ID,
      seqId: 6,
      text: "Current release audit in progress",
      createdAt: isoAt(deliveredAt + 30 * MINUTE),
    }),
  ];
  const activeRunIds = [ACTIVE_RUN_ID];
  await openRunChat(chatEvents, { activeRunIds });

  await waitFor(() => {
    expect(workStatusLabels("Working for")).toHaveLength(1);
  });
  expect(workStatusLabels("Working for")[0]).toHaveTextContent(
    "Working for 1 hr 12 min",
  );
  expect(workStatusLabels("Worked for")).toHaveLength(1);
  expect(workStatusLabels("Worked for")[0]).toHaveTextContent(
    "Worked for 1 hr 24 min",
  );

  chatEvents.push(
    completedEvent({
      id: "current-complete",
      runId: ACTIVE_RUN_ID,
      seqId: 7,
      createdAt: isoAt(deliveredAt + 72 * MINUTE),
    }),
  );
  activeRunIds.splice(0);
  publishRunUpdate();

  await waitFor(() => {
    expect(workStatusLabels("Working for")).toHaveLength(0);
  });
  expect(
    workStatusLabels("Worked for").map((label) => {
      return label.textContent;
    }),
  ).toStrictEqual(["Worked for 1 hr 24 min", "Worked for 1 hr 12 min"]);
});

test("Do not create history before the first output.message", async () => {
  await openRunChat(
    [
      promptEvent({
        id: "waiting-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Collect the meeting notes",
      }),
    ],
    { activeRunIds: [ACTIVE_RUN_ID] },
  );

  await waitFor(() => {
    expect(thinkingIndicator()).toBeVisible();
  });
  expect(workStatusLabels("Working for")).toHaveLength(0);
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(0);
  expect(queryWorkHistoryToggles("expanded")).toHaveLength(0);
});

test("Count one output.message once when Markdown renders multiple child blocks", async () => {
  await openRunChat(
    [
      promptEvent({
        id: "rich-output-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Share the quarterly materials",
      }),
      assistantEvent({
        id: "rich-output",
        runId: ACTIVE_RUN_ID,
        seqId: 2,
        text: [
          "Quarterly materials are ready.",
          "![Revenue chart](https://example.com/revenue-chart.png)",
          "[Quarterly report](https://example.com/quarterly-report.pdf)",
          "[Compare plans](/?settings=billing&billingView=plans)",
        ].join("\n\n"),
      }),
    ],
    { activeRunIds: [ACTIVE_RUN_ID] },
  );

  await expect(
    screen.findByText("Quarterly materials are ready."),
  ).resolves.toBeVisible();
  expect(screen.getByAltText("Revenue chart")).toBeVisible();
  expect(
    queryAllByRoleFast("link").find((link) => {
      return link.textContent === "Quarterly report";
    }),
  ).toHaveAttribute("href", "https://example.com/quarterly-report.pdf");
  expect(screen.getByTestId("plan-upgrade-card")).toBeVisible();
  await waitFor(() => {
    expect(workStatusLabels("Working for")).toHaveLength(1);
  });
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(0);
  expect(queryWorkHistoryToggles("expanded")).toHaveLength(0);
  expect(agentProfileLinks()).toHaveLength(1);
});

test("With Agent name on replies, a reply opens with its agent's name, linked to the agent's profile", async () => {
  await openRunChat(
    [
      promptEvent({
        id: "named-reply-request",
        runId: COMPLETED_RUN_ID,
        seqId: 1,
        text: "Summarize the standup",
      }),
      assistantEvent({
        id: "named-reply",
        runId: COMPLETED_RUN_ID,
        seqId: 2,
        text: "Standup summary",
      }),
      completedEvent({
        id: "named-reply-complete",
        runId: COMPLETED_RUN_ID,
        seqId: 3,
      }),
    ],
    { featureSwitches: { [FeatureSwitchKey.ChatReplyNameLine]: true } },
  );

  const answer = await screen.findByText("Standup summary");
  const reply = answer.closest<HTMLElement>('[data-role="assistant"]');
  if (!reply) {
    throw new Error("Reply has no assistant group");
  }
  const nameLink = await waitFor(() => {
    const link = queryAllByRoleFast("link", reply).find((candidate) => {
      return candidate.textContent?.trim() === "Run Agent";
    });
    expect(link).toBeVisible();
    return link!;
  });
  expect(nameLink).toHaveAttribute("href", `/agents/${AGENT_ID}`);
  expect(
    nameLink.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(agentProfileLinks()).toHaveLength(0);
});

test("Project a completed run with multiple output messages", async () => {
  await openRunChat([
    ...fiveOutputRun(COMPLETED_RUN_ID),
    completedEvent({
      id: "five-output-complete",
      runId: COMPLETED_RUN_ID,
      seqId: 7,
    }),
  ]);

  await expect(
    screen.findByText("Launch review output 5"),
  ).resolves.toBeVisible();
  expect(thinkingIndicator()).toBeNull();
  expect(workStatusLabels("Worked for")).toHaveLength(1);
  expect(workStatusLabels("Working for")).toHaveLength(0);
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(1);
  for (const index of [1, 2, 3, 4]) {
    expect(
      screen.queryByText(`Launch review output ${index.toString()}`),
    ).toBeNull();
  }
});

test("Use the last output.message as the main result when it renders an action card", async () => {
  await openRunChat(
    [
      promptEvent({
        id: "action-card-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Find a plan for the team",
      }),
      assistantEvent({
        id: "action-card-research",
        runId: ACTIVE_RUN_ID,
        seqId: 2,
        text: "Reviewed the current usage",
      }),
      assistantEvent({
        id: "action-card-output",
        runId: ACTIVE_RUN_ID,
        seqId: 3,
        text: "[Compare plans](/?settings=billing&billingView=plans)",
      }),
    ],
    { activeRunIds: [ACTIVE_RUN_ID] },
  );

  const card = await screen.findByTestId("plan-upgrade-card");
  expect(card).toBeVisible();
  expect(card.closest("[data-chat-run-work-main]")).not.toBeNull();
  await waitFor(() => {
    expect(thinkingIndicator()).toBeVisible();
  });
  expect(screen.queryByText("Reviewed the current usage")).toBeNull();
  expect(agentProfileLinks()).toHaveLength(1);
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(1);
});

test("Do not render result actions while waiting for assistant output", async () => {
  await openRunChat(
    [
      promptEvent({
        id: "actions-waiting-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Prepare the board update",
      }),
    ],
    { activeRunIds: [ACTIVE_RUN_ID] },
  );

  await waitFor(() => {
    expect(thinkingIndicator()).toBeVisible();
  });
  expect(resultActions()).toHaveLength(0);
});

test("Keep run-budget instructions out of the transcript", async () => {
  await openRunChat([
    promptEvent({
      id: "budget-request",
      runId: COMPLETED_RUN_ID,
      seqId: 1,
      text: "Draft the release checklist",
    }),
    {
      id: "budget-instruction",
      role: "user",
      eventType: "input.budget",
      content: null,
      runId: COMPLETED_RUN_ID,
      seqId: 2,
      createdAt: "2026-08-01T10:00:02.000Z",
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "You have 12 minutes left in this run" }],
      },
    },
    assistantEvent({
      id: "budget-answer",
      runId: COMPLETED_RUN_ID,
      seqId: 3,
      text: "Release checklist drafted",
    }),
    completedEvent({
      id: "budget-complete",
      runId: COMPLETED_RUN_ID,
      seqId: 4,
    }),
  ]);

  await expect(
    screen.findByText("Release checklist drafted"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Draft the release checklist")).toBeVisible();
  expect(screen.queryByText("You have 12 minutes left in this run")).toBeNull();
});

test("Keep usage-only activity out of the conversation", async () => {
  const thread = await openRunChat([
    usageEvent({
      id: "usage-only",
      runId: COMPLETED_RUN_ID,
      seqId: 1,
      usage: creditUsage(0, []),
    }),
  ]);

  await waitFor(() => {
    expect(queryButton("Send")).toBeVisible();
  });
  expect(queryButton("Stop")).toBeNull();
  expect(queryButton("Credit usage")).toBeNull();
  expect(within(thread).queryByText(/credit/iu)).toBeNull();
});

test("Preserve user text that resembles HTML", async () => {
  await openRunChat([
    promptEvent({
      id: "html-like-request",
      runId: COMPLETED_RUN_ID,
      seqId: 1,
      text: "<span> 123 </span>",
    }),
    assistantEvent({
      id: "html-like-answer",
      runId: COMPLETED_RUN_ID,
      seqId: 2,
      text: "Received the literal text",
    }),
    completedEvent({
      id: "html-like-complete",
      runId: COMPLETED_RUN_ID,
      seqId: 3,
    }),
  ]);

  const submitted = await screen.findByText("<span> 123 </span>", {
    normalizer: (text) => {
      return text;
    },
  });
  expect(submitted).toBeVisible();
  expect(submitted.textContent).toBe("<span> 123 </span>");
});

test("Show working dots on scroll-to-bottom while the thread works", async () => {
  await openRunChat([...fiveOutputRun(ACTIVE_RUN_ID)], {
    activeRunIds: [ACTIVE_RUN_ID],
  });
  await expect(
    screen.findByText("Launch review output 5"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(thinkingIndicator()).toBeVisible();
  });

  const scroller = chatScrollContainer();
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 2400 },
    clientHeight: { configurable: true, value: 600 },
  });
  scroller.scrollTop = 800;
  fireEvent.scroll(scroller);

  const button = await waitFor(() => {
    const control = queryButton("Scroll to bottom");
    expect(control).toBeVisible();
    return control!;
  });
  expect(button).toHaveAttribute("data-working");
  expect(
    button.querySelectorAll("[data-scroll-to-bottom-working-dot]"),
  ).toHaveLength(3);
});
