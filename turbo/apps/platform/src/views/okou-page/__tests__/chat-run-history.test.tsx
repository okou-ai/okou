import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  creditUsage,
  expectTextOrder,
  findButton,
  findLink,
  findWorkHistoryToggle,
  installRunChat,
  promptEvent,
  queryButton,
  queryWorkHistoryToggles,
  readyChat,
  RUN_PATH,
  thinkingEvent,
  usageEvent,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000201";
const RUN_B = "a0000000-0000-4000-a000-000000000202";

function createdAt(minute: number, second = 0): string {
  return `2026-08-01T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

function buttonsNamed(name: string): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return button.getAttribute("aria-label") === name;
  });
}

function buttonNamedIn(name: string, container: HTMLElement): HTMLElement {
  const button = buttonsNamed(name).find((candidate) => {
    return container.contains(candidate);
  });
  if (!button) {
    throw new Error(`Expected button named "${name}" in container`);
  }
  return button;
}

function workMessage(index: number): string {
  return `Work message ${String(index + 1)}`;
}

function workMessageEvents(count: number): MockChatEventInput[] {
  return Array.from({ length: count }, (_, index) => {
    return assistantEvent({
      id: `work-message-${String(index + 1)}`,
      runId: RUN_A,
      seqId: index + 2,
      text: workMessage(index),
      createdAt: createdAt(10, (index + 1) * 5),
    });
  });
}

function activeWorkChatEvents(messageCount: number): MockChatEventInput[] {
  return [
    promptEvent({
      id: "active-work-user",
      runId: RUN_A,
      seqId: 1,
      text: "Prepare the deployment review",
      createdAt: createdAt(10),
    }),
    ...workMessageEvents(messageCount),
  ];
}

function assistantGroupFor(element: Element): HTMLElement {
  const group = element.closest<HTMLElement>('[data-role="assistant"]');
  if (!group) {
    throw new Error("Expected content inside one assistant response");
  }
  return group;
}

function viewAgentProfileLinks(): HTMLElement[] {
  return queryAllByRoleFast("link").filter((link) => {
    return link.getAttribute("aria-label") === "View agent profile";
  });
}

async function setupCompletedConversationPhases(): Promise<void> {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "phase-a-user",
        runId: RUN_A,
        seqId: 1,
        text: "Plan phase one",
        createdAt: createdAt(0),
      }),
      assistantEvent({
        id: "phase-a-work-1",
        runId: RUN_A,
        seqId: 2,
        text: "Collected requirements",
        createdAt: createdAt(0, 20),
      }),
      assistantEvent({
        id: "phase-a-answer-1",
        runId: RUN_A,
        seqId: 3,
        text: "Phase one outline",
        createdAt: createdAt(0, 40),
      }),
      promptEvent({
        id: "phase-a-followup",
        runId: RUN_A,
        seqId: 4,
        text: "Include rollback steps",
        createdAt: createdAt(1),
      }),
      assistantEvent({
        id: "phase-a-work-2",
        runId: RUN_A,
        seqId: 5,
        text: "Compared rollback options",
        createdAt: createdAt(1, 20),
      }),
      assistantEvent({
        id: "phase-a-final",
        runId: RUN_A,
        seqId: 6,
        text: "Phase one final plan",
        createdAt: createdAt(2),
      }),
      completedEvent({
        id: "phase-a-complete",
        runId: RUN_A,
        seqId: 7,
        createdAt: createdAt(2, 1),
      }),
      promptEvent({
        id: "phase-b-user",
        runId: RUN_B,
        seqId: 8,
        text: "Plan phase two",
        createdAt: createdAt(3),
      }),
      assistantEvent({
        id: "phase-b-work",
        runId: RUN_B,
        seqId: 9,
        text: "Checked launch dependencies",
        createdAt: createdAt(3, 20),
      }),
      assistantEvent({
        id: "phase-b-final",
        runId: RUN_B,
        seqId: 10,
        text: "Phase two final plan",
        createdAt: createdAt(5),
      }),
      completedEvent({
        id: "phase-b-complete",
        runId: RUN_B,
        seqId: 11,
        createdAt: createdAt(5, 1),
      }),
      usageEvent({
        id: "phase-b-usage",
        runId: RUN_B,
        seqId: 12,
        usage: creditUsage(7, [
          {
            kind: "connector",
            credits: 7,
            providers: [{ provider: "slack", credits: 7 }],
          },
        ]),
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
}

test("Summarize completed work by conversation phase", async () => {
  await setupCompletedConversationPhases();
  expect(
    assistantGroupFor(screen.getByText("Phase one outline")),
  ).toHaveTextContent("Worked for 1m");
  expect(
    assistantGroupFor(screen.getByText("Phase one final plan")),
  ).toHaveTextContent("Worked for 1m");
  expect(screen.getByText("Worked for 2m")).toBeVisible();
  expect(screen.getByText("Phase one outline")).toBeVisible();
  expect(screen.getByText("Phase one final plan")).toBeVisible();
  expect(screen.getByText("Phase two final plan")).toBeVisible();
  expect(screen.queryByText("Collected requirements")).toBeNull();
  expect(screen.queryByText("Compared rollback options")).toBeNull();
  expect(screen.queryByText("Checked launch dependencies")).toBeNull();
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(3);
});

test("Expand the first completed conversation phase", async () => {
  await setupCompletedConversationPhases();
  click(
    buttonNamedIn(
      "Expand work history",
      assistantGroupFor(screen.getByText("Phase one outline")),
    ),
  );
  await expect(
    screen.findByText("Collected requirements"),
  ).resolves.toBeVisible();
  expect(screen.queryByText("Compared rollback options")).toBeNull();
  expect(screen.queryByText("Checked launch dependencies")).toBeNull();
  expectTextOrder(
    "Plan phase one",
    "Collected requirements",
    "Phase one outline",
    "Include rollback steps",
    "Phase one final plan",
  );
});

test.each([
  {
    label: "one output message",
    messageCount: 1,
    showsHistoryStatus: true,
    canExpandHistory: false,
  },
  {
    label: "multiple output messages",
    messageCount: 5,
    showsHistoryStatus: true,
    canExpandHistory: true,
  },
])(
  "Project an active run with $label",
  async ({ messageCount, showsHistoryStatus, canExpandHistory }) => {
    installRunChat({
      activeRunIds: [RUN_A],
      chatEvents: activeWorkChatEvents(messageCount),
    });

    await setupPage({
      context,
      path: RUN_PATH,
    });

    await readyChat();
    const thinking = document.querySelector<HTMLElement>(
      "[data-thinking-indicator]",
    );
    expect(thinking).toBeVisible();
    expect(screen.queryAllByText(/^Working(?: for)? /u)).toHaveLength(
      showsHistoryStatus ? 1 : 0,
    );
    expect(queryWorkHistoryToggles("collapsed")).toHaveLength(
      canExpandHistory ? 1 : 0,
    );

    const main = screen.getByText(workMessage(messageCount - 1));
    expect(main).toBeVisible();

    for (let index = 0; index < messageCount - 1; index += 1) {
      expect(screen.queryByText(workMessage(index))).toBeNull();
    }
    expect(assistantGroupFor(main)).toContainElement(thinking);

    if (!canExpandHistory) {
      return;
    }

    click(await findWorkHistoryToggle("collapsed"));
    const firstHistoryMessage = await screen.findByText(workMessage(0));
    const secondHistoryMessage = screen.getByText(workMessage(1));
    expect(assistantGroupFor(firstHistoryMessage)).toBe(
      assistantGroupFor(main),
    );
    expect(assistantGroupFor(secondHistoryMessage)).toBe(
      assistantGroupFor(main),
    );
    expectTextOrder(workMessage(0), workMessage(1), workMessage(2));
  },
);

test("Do not create history before the first output.message", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "status-only-user",
        runId: RUN_A,
        seqId: 1,
        text: "Inspect the release",
        createdAt: createdAt(0),
      }),
      thinkingEvent({
        id: "status-only-thinking",
        runId: RUN_A,
        seqId: 2,
        text: "Reading release evidence",
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  expect(screen.queryByText(/^Working(?: for)? /u)).toBeNull();
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(0);
  expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
});

test("Count one output.message once when Markdown renders multiple child blocks", async () => {
  const artifactUrl =
    "https://cdn.vm7.io/artifacts/run-folding/multi-block/package.pdf";
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "multi-block-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare the package",
      }),
      assistantEvent({
        id: "multi-block-output",
        runId: RUN_A,
        seqId: 2,
        text: [
          "Final package",
          "![Package chart](https://example.com/package-chart.png)",
          `![Package](${artifactUrl})`,
          "[Compare plans](/?settings=billing&billingView=plans)",
        ].join("\n\n"),
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  expect(screen.getByText("Final package")).toBeVisible();
  await expect(screen.findByAltText("Package chart")).resolves.toBeVisible();
  await expect(
    findLink("Open pdf preview for package.pdf"),
  ).resolves.toBeVisible();
  await expect(screen.findByTestId("plan-upgrade-card")).resolves.toBeVisible();
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(0);
  expect(screen.queryAllByText(/^Working(?: for)? /u)).toHaveLength(1);
  expect(viewAgentProfileLinks()).toHaveLength(1);
});

test.each([
  {
    label: "multiple output messages",
    messageCount: 5,
    canExpandHistory: true,
  },
])(
  "Project a completed run with $label",
  async ({ messageCount, canExpandHistory }) => {
    installRunChat({
      chatEvents: [
        ...activeWorkChatEvents(messageCount),
        completedEvent({
          id: "finished-work-complete",
          runId: RUN_A,
          seqId: messageCount + 2,
          createdAt: createdAt(11),
        }),
      ],
    });

    await setupPage({
      context,
      path: RUN_PATH,
    });

    await readyChat();
    expect(screen.getByText(workMessage(messageCount - 1))).toBeVisible();
    expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    expect(screen.queryAllByText(/^Worked(?: for)? /u)).toHaveLength(1);
    expect(queryWorkHistoryToggles("collapsed")).toHaveLength(
      canExpandHistory ? 1 : 0,
    );
    for (let index = 0; index < messageCount - 1; index += 1) {
      expect(screen.queryByText(workMessage(index))).toBeNull();
    }
  },
);

const finalOutputDocuments = [
  {
    label: "an action card",
    content: "[Compare plans](/?settings=billing&billingView=plans)",
    find: () => {
      return screen.findByTestId("plan-upgrade-card");
    },
  },
] as const;

test.each(finalOutputDocuments)(
  "Use the last output.message as the main result when it renders $label",
  async ({ content, find }) => {
    installRunChat({
      activeRunIds: [RUN_A],
      chatEvents: [
        promptEvent({
          id: "document-shape-user",
          runId: RUN_A,
          seqId: 1,
          text: "Prepare the final result",
          createdAt: createdAt(10),
        }),
        assistantEvent({
          id: "document-shape-history",
          runId: RUN_A,
          seqId: 2,
          text: "Earlier output belongs in history",
          createdAt: createdAt(10, 20),
        }),
        assistantEvent({
          id: "document-shape-main",
          runId: RUN_A,
          seqId: 3,
          text: content,
          createdAt: createdAt(10, 40),
        }),
      ],
    });

    await setupPage({
      context,
      path: RUN_PATH,
    });

    await readyChat();
    const main = await find();
    expect(main).toBeVisible();
    expect(viewAgentProfileLinks()).toHaveLength(1);
    expect(screen.queryByText("Earlier output belongs in history")).toBeNull();
    expect(queryWorkHistoryToggles("collapsed")).toHaveLength(1);
    const thinking = document.querySelector<HTMLElement>(
      "[data-thinking-indicator]",
    );
    expect(assistantGroupFor(main)).toContainElement(thinking);
  },
);

test("Keep result actions visible alongside running progress", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "exclusive-tail-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare a result",
      }),
      assistantEvent({
        id: "exclusive-tail-result",
        runId: RUN_A,
        seqId: 2,
        text: "The result is still being checked",
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  expect(screen.getByText("The result is still being checked")).toBeVisible();
  expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
  expect(
    document.querySelector('[data-testid="chat-event-actions"]'),
  ).toBeVisible();
});

test("Do not render result actions while waiting for assistant output", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "waiting-actions-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare a result",
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
  expect(
    document.querySelector('[data-testid="chat-event-actions"]'),
  ).toBeNull();
});

test("Render result actions after a run completes", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "completed-actions-user",
        runId: RUN_A,
        seqId: 1,
        text: "Prepare a completed result",
      }),
      assistantEvent({
        id: "completed-actions-result",
        runId: RUN_A,
        seqId: 2,
        text: "The completed result is ready",
      }),
      completedEvent({
        id: "completed-actions-terminal",
        runId: RUN_A,
        seqId: 3,
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const result = screen.getByText("The completed result is ready");
  const assistantGroup = assistantGroupFor(result);
  const mainMessage = result.closest<HTMLElement>("[data-chat-run-work-main]");
  if (!mainMessage) {
    throw new Error("Expected the result inside the main message region");
  }
  expect(assistantGroup.querySelector("[data-thinking-indicator]")).toBeNull();
  const actions = assistantGroup.querySelector<HTMLElement>(
    '[data-testid="chat-event-actions"]',
  );
  if (!actions) {
    throw new Error("Expected the completed result action bar");
  }
  expect(actions).toBeVisible();
  expect(mainMessage).toContainElement(actions);
  expect(
    result.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("Keep interleaved run updates with their own turns", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "interleave-a-user",
        runId: RUN_A,
        seqId: 1,
        text: "Request A",
      }),
      promptEvent({
        id: "interleave-b-user",
        runId: RUN_B,
        seqId: 2,
        text: "Request B",
      }),
      assistantEvent({
        id: "interleave-b-answer",
        runId: RUN_B,
        seqId: 3,
        text: "B final answer",
      }),
      assistantEvent({
        id: "interleave-a-final",
        runId: RUN_A,
        seqId: 4,
        text: "A late final answer",
      }),
      completedEvent({ id: "interleave-a-complete", runId: RUN_A, seqId: 5 }),
      completedEvent({ id: "interleave-b-complete", runId: RUN_B, seqId: 6 }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(screen.getByText("A late final answer")).toBeVisible();
  expectTextOrder(
    "Request A",
    "A late final answer",
    "Request B",
    "B final answer",
  );
});

test("Keep run-budget instructions out of the transcript", async () => {
  const events: MockChatEventInput[] = [
    promptEvent({
      id: "budget-user",
      runId: RUN_A,
      seqId: 1,
      text: "Complete the migration",
    }),
    {
      id: "budget-instruction",
      eventType: "input.budget",
      role: "user",
      content: null,
      runId: RUN_A,
      seqId: 2,
      createdAt: "2026-08-01T10:00:02.000Z",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "text",
            text: "You have 12 minutes left in this run",
          },
        ],
      },
    },
    assistantEvent({
      id: "budget-answer",
      runId: RUN_A,
      seqId: 3,
      text: "The migration is complete.",
    }),
    completedEvent({ id: "budget-complete", runId: RUN_A, seqId: 4 }),
  ];
  installRunChat({ chatEvents: events });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(screen.getByText("Complete the migration")).toBeVisible();
  expect(screen.getByText("The migration is complete.")).toBeVisible();
  expect(
    screen.queryByText("You have 12 minutes left in this run"),
  ).not.toBeInTheDocument();
});

test("Keep usage-only activity out of the conversation", async () => {
  installRunChat({
    chatEvents: [
      usageEvent({
        id: "zero-usage",
        runId: RUN_A,
        seqId: 1,
        usage: creditUsage(0, []),
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  const chat = await readyChat();
  expect(chat).not.toHaveTextContent("Credit usage");
  expect(queryButton("Stop")).toBeNull();
  await expect(findButton("Send")).resolves.toBeVisible();
});

test("Preserve user text that resembles HTML", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "literal-html",
        runId: RUN_A,
        seqId: 1,
        text: "<span> 123 </span>",
      }),
      assistantEvent({
        id: "literal-answer",
        runId: RUN_A,
        seqId: 2,
        text: "I preserved it literally.",
      }),
      completedEvent({ id: "literal-complete", runId: RUN_A, seqId: 3 }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const literalText = screen.getByText("<span> 123 </span>");
  expect(literalText).toBeVisible();
  expect(literalText.textContent).toBe("<span> 123 </span>");
});

test("Replace a stale assistant answer with its correction", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "correction-user",
        runId: RUN_A,
        seqId: 1,
        text: "Revise the launch plan",
      }),
      assistantEvent({
        id: "obsolete-answer",
        runId: RUN_A,
        seqId: 2,
        text: "Obsolete launch plan",
      }),
      {
        id: "revised-answer",
        eventType: "output.message",
        role: "assistant",
        content: "Revised launch plan",
        runId: RUN_A,
        revokesEventId: "obsolete-answer",
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
      },
      completedEvent({ id: "correction-complete", runId: RUN_A, seqId: 4 }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(screen.getByText("Revised launch plan")).toBeVisible();
  expect(screen.queryByText("Obsolete launch plan")).not.toBeInTheDocument();
});
