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

test.each([6])(
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
