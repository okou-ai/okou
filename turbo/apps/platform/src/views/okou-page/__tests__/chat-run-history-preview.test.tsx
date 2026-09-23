import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  findLink,
  findWorkHistoryToggle,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const RUN_ID = "a0000000-0000-4000-a000-000000000294";

async function setupRunWithOutputCount(count: number): Promise<void> {
  installRunChat({
    activeRunIds: [RUN_ID],
    chatEvents: [
      promptEvent({
        id: "preview-input",
        runId: RUN_ID,
        seqId: 1,
        text: "Check every step",
      }),
      ...Array.from({ length: count }, (_, index) => {
        return assistantEvent({
          id: `preview-${String(index)}`,
          runId: RUN_ID,
          seqId: index + 2,
          text: `Step ${String(index + 1)}`,
        });
      }),
    ],
  });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();
}

test("Show no history messages without assistant output", async () => {
  await setupRunWithOutputCount(0);

  expect(
    document.querySelector("[data-chat-run-work-history-list]"),
  ).toBeNull();
  expect(queryButton("Expand work history")).toBeNull();
});

test("Show no history toggle when the only output is the main result", async () => {
  await setupRunWithOutputCount(1);

  const main = screen.getByText("Step 1").closest("[data-chat-run-work-main]");
  if (!main) {
    throw new Error("Expected the main result container");
  }
  expect(queryButton("Copy message", main)).toBeVisible();
  expect(queryButton("Expand work history")).toBeNull();
  expect(
    document.querySelector("[data-chat-run-work-history-list]"),
  ).toBeNull();
});

test.each([2, 6])(
  "Hide all collapsed history and expand every message with %s outputs",
  async (count) => {
    await setupRunWithOutputCount(count);

    for (let index = 1; index < count; index += 1) {
      expect(screen.queryByText(`Step ${String(index)}`)).toBeNull();
    }
    expect(
      document.querySelector("[data-chat-run-work-history-list]"),
    ).toBeNull();
    const main = screen
      .getByText(`Step ${String(count)}`)
      .closest("[data-chat-run-work-main]");
    if (!main) {
      throw new Error("Expected the main result container");
    }
    expect(queryButton("Copy message", main)).toBeVisible();

    const expand = await findWorkHistoryToggle("collapsed");
    expect(expand).toHaveAttribute("aria-expanded", "false");
    click(expand);

    const collapse = await findWorkHistoryToggle("expanded");
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    for (let index = 1; index < count; index += 1) {
      const message = screen.getByText(`Step ${String(index)}`);
      expect(message).toBeVisible();
      expect(
        message.closest("[data-chat-run-work-history-list]"),
      ).toBeVisible();
      expect(message.closest("button")).toBeNull();
    }
    expect(screen.getByText(`Step ${String(count)}`)).toBeVisible();
    expect(queryButton("Copy message", main)).toBeVisible();
    expect(
      document.querySelector(
        "[data-chat-run-status-tail] [data-thinking-indicator]",
      ),
    ).toBeVisible();

    click(collapse);
    await waitFor(() => {
      expect(
        document.querySelector("[data-chat-run-work-history-list]"),
      ).toBeNull();
    });
    for (let index = 1; index < count; index += 1) {
      expect(screen.queryByText(`Step ${String(index)}`)).toBeNull();
    }
    expect(screen.getByText(`Step ${String(count)}`)).toBeVisible();
    expect(queryButton("Copy message", main)).toBeVisible();
    expect(
      document.querySelector(
        "[data-chat-run-status-tail] [data-thinking-indicator]",
      ),
    ).toBeVisible();
  },
);

test("Hide the empty history step count from the work summary", async () => {
  await setupRunWithOutputCount(1);

  const workSummary = document.querySelector("[data-chat-run-work]");
  expect(workSummary).toBeVisible();
  expect(workSummary).not.toHaveTextContent("0 steps");
  expect(workSummary).not.toHaveTextContent("·");
});

test("Keep work history open and keyboard focus in place when another output arrives", async () => {
  const events = [
    promptEvent({
      id: "focused-history-input",
      runId: RUN_ID,
      seqId: 1,
      text: "Check every step",
    }),
    assistantEvent({
      id: "focused-history-first",
      runId: RUN_ID,
      seqId: 2,
      text: "Checked the dependencies",
    }),
    assistantEvent({
      id: "focused-history-second",
      runId: RUN_ID,
      seqId: 3,
      text: "Checked the boundaries",
    }),
    assistantEvent({
      id: "focused-history-third",
      runId: RUN_ID,
      seqId: 4,
      text: "Checked the interactions",
    }),
    assistantEvent({
      id: "focused-history-fourth",
      runId: RUN_ID,
      seqId: 5,
      text: "Checked the responsive layout",
    }),
    assistantEvent({
      id: "focused-history-fifth",
      runId: RUN_ID,
      seqId: 6,
      text: "Checked the final details",
    }),
  ];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID] });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();
  const showAll = await findWorkHistoryToggle("collapsed");
  click(showAll);
  showAll.focus();

  events.push(
    assistantEvent({
      id: "focused-history-sixth",
      runId: RUN_ID,
      seqId: 7,
      text: "The checks are complete",
    }),
  );
  publishRunUpdate();

  await expect(
    screen.findByText("The checks are complete"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Checked the dependencies")).toBeVisible();
  expect(screen.getByText("Checked the boundaries")).toBeVisible();
  await expect(findWorkHistoryToggle("expanded")).resolves.toHaveFocus();
});

test("Render a card-only history output without message folding", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "action-preview-input",
        runId: RUN_ID,
        seqId: 1,
        text: "Review the available plans",
      }),
      assistantEvent({
        id: "action-preview-card",
        runId: RUN_ID,
        seqId: 2,
        text: "[Compare plans](/?settings=billing&billingView=plans)",
      }),
      assistantEvent({
        id: "action-preview-result",
        runId: RUN_ID,
        seqId: 3,
        text: "The comparison is ready",
      }),
      completedEvent({
        id: "action-preview-complete",
        runId: RUN_ID,
        seqId: 4,
      }),
    ],
  });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();

  expect(screen.getByText("The comparison is ready")).toBeVisible();
  expect(screen.queryByTestId("plan-upgrade-card")).toBeNull();
  click(await findWorkHistoryToggle("collapsed"));

  const card = await screen.findByTestId("plan-upgrade-card");
  expect(card).toBeVisible();
  expect(card.closest("[data-chat-run-work-history-list]")).toBeVisible();
  expect(queryButton("Collapse work history")).toBeVisible();
});

test("Render Markdown and media history like the main body after a run completes", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "rich-preview-input",
        runId: RUN_ID,
        seqId: 1,
        text: "Prepare the report",
      }),
      ...[
        "## Review\n\nChecked **dependencies** and `tests`.",
        "![Dependency chart](https://example.com/dependencies.png)",
        "![report.pdf](https://cdn.vm7.io/artifacts/history-preview/report/report.pdf)",
        "The review is ready",
      ].map((text, index) => {
        return assistantEvent({
          id: `rich-preview-${index}`,
          runId: RUN_ID,
          seqId: index + 2,
          text,
        });
      }),
      completedEvent({ id: "preview-terminal", runId: RUN_ID, seqId: 6 }),
    ],
  });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();

  expect(screen.getByText("The review is ready")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Review" })).toBeNull();
  expect(screen.queryByAltText("Dependency chart")).toBeNull();
  click(await findWorkHistoryToggle("collapsed"));
  await expect(
    screen.findByRole("heading", { name: "Review" }),
  ).resolves.toBeVisible();

  const historyBody = document.querySelector<HTMLElement>(
    '[data-chat-scroll-anchor-event-id="rich-preview-0"]',
  );
  if (!historyBody) {
    throw new Error("Expected the history message body");
  }
  expect(historyBody).toHaveTextContent(
    "Review Checked dependencies and tests.",
  );
  expect(screen.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(screen.findByAltText("Dependency chart")).resolves.toBeVisible();
  await expect(
    findLink("Open pdf preview for report.pdf"),
  ).resolves.toBeVisible();
  expect(queryButton("Collapse work history")).toBeVisible();
});
