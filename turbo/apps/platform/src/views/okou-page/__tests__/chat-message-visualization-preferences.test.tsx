import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { buildComposerAdditionalInfo } from "../../../signals/okou-page/composer-additional-info.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const CREATED_AT = "2026-08-20T12:00:00.000Z";

function userEventWith(
  prompt: string,
  runId: string,
  additionalInfo: string | undefined,
) {
  const userMessage = {
    version: 1,
    parts: [
      { type: "text", text: prompt },
      ...(additionalInfo
        ? [{ type: "additional_info" as const, text: additionalInfo }]
        : []),
    ],
  } satisfies UserMessageDocument;
  return {
    id: `message-${runId}`,
    role: "user" as const,
    content: "Conflicting legacy message text",
    userMessage,
    runId,
    createdAt: CREATED_AT,
  };
}

function assertBefore(first: Element, second: Element): void {
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

async function findUserMessage(prompt: string): Promise<HTMLElement> {
  const promptNode = await screen.findByText(prompt);
  const message = promptNode.closest<HTMLElement>('[data-role="user"]');
  if (!message) {
    throw new Error(`User message not found for "${prompt}"`);
  }
  return message;
}

test("Sent visualization choices are grouped, concise, and only shown when selected", async () => {
  const selected = buildComposerAdditionalInfo(null, "auto", {
    output: "presentation",
    charts: ["bar", "line", "pie"],
  });
  const outputOnly = buildComposerAdditionalInfo(null, "auto", {
    output: "presentation",
    charts: [],
  });
  const chartOnlyPreferences = buildComposerAdditionalInfo(null, "auto", {
    output: null,
    charts: ["bar", "line"],
  });
  const chartsOnly = chartOnlyPreferences
    ? `${chartOnlyPreferences}\n- Preferred output format: report`
    : undefined;
  const emptyPreferences = buildComposerAdditionalInfo(null, "auto", {
    output: null,
    charts: [],
  });
  const emptyPreferencesWithDefault = emptyPreferences
    ? `${emptyPreferences}\n- Preferred output format: report`
    : undefined;
  const longChartList = [
    "bar",
    "line",
    "pie",
    "scatter",
    "area",
    "stacked-bar",
    "heatmap",
    "bubble",
  ] as const;
  const longListInfo = buildComposerAdditionalInfo(null, "auto", {
    output: null,
    charts: longChartList,
  });
  const explicitReport = buildComposerAdditionalInfo(null, "auto", {
    output: "report",
    charts: [],
  });
  const legacyVisualizationInfo = [
    "# Visualization",
    "The user wants a visualized result for this run.",
    "- Preferred output format: website",
    "- Preferred chart types: bar, line",
  ].join("\n");
  const legacyReportDefaultInfo = [
    "# Visualization",
    "The user wants a visualized result for this run.",
    "- Preferred output format: report",
    "- Preferred chart types: bar, line",
  ].join("\n");
  const presentationDefaults = buildComposerAdditionalInfo(
    "presentation",
    "auto",
    undefined,
  );

  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      userEventWith(
        "Create a comparison visual.",
        "d0000000-0000-4000-a000-000000000061",
        selected,
      ),
      userEventWith(
        "Make a slide deck.",
        "d0000000-0000-4000-a000-000000000062",
        outputOnly,
      ),
      userEventWith(
        "Use a bar or line chart.",
        "d0000000-0000-4000-a000-000000000063",
        chartsOnly,
      ),
      userEventWith(
        "Summarize many chart options.",
        "d0000000-0000-4000-a000-000000000064",
        longListInfo,
      ),
      userEventWith(
        "Use the presentation defaults.",
        "d0000000-0000-4000-a000-000000000065",
        presentationDefaults,
      ),
      userEventWith(
        "Summarize without selections.",
        "d0000000-0000-4000-a000-000000000066",
        emptyPreferencesWithDefault,
      ),
      userEventWith(
        "Write a report.",
        "d0000000-0000-4000-a000-000000000067",
        explicitReport,
      ),
      userEventWith(
        "Use a website visual.",
        "d0000000-0000-4000-a000-000000000068",
        legacyVisualizationInfo,
      ),
      userEventWith(
        "Use the default report with charts.",
        "d0000000-0000-4000-a000-000000000069",
        legacyReportDefaultInfo,
      ),
    ],
  });

  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
  });

  const selectedMessage = await findUserMessage("Create a comparison visual.");
  const selectedSummary = within(selectedMessage).getByRole("group", {
    name: "Presentation, Charts: Bar chart, Line chart, Pie chart",
  });
  expect(selectedSummary).toHaveAttribute(
    "data-structured-visualization-preferences",
    "",
  );
  expect(selectedSummary).toHaveTextContent("Presentation");
  expect(selectedSummary).toHaveTextContent("Charts");
  expect(selectedMessage).not.toHaveTextContent("Preferred output format");
  expect(selectedMessage).not.toHaveTextContent("Preferred chart types");
  expect(selectedMessage).not.toHaveTextContent("User-selected output format");
  expect(selectedMessage).not.toHaveTextContent(
    "The user wants a visualized result for this run",
  );
  const outputLabel = selectedSummary.querySelector(
    "[data-structured-visualization-output]",
  );
  const chartLabels = selectedSummary.querySelector(
    "[data-structured-visualization-chart-labels]",
  );
  if (!outputLabel || !chartLabels) {
    throw new Error("Visualization summary should preserve the selected order");
  }
  assertBefore(outputLabel, chartLabels);
  expect(chartLabels).toHaveTextContent("Bar, Line, Pie");

  const outputOnlyMessage = await findUserMessage("Make a slide deck.");
  expect(
    within(outputOnlyMessage).getByRole("group", { name: "Presentation" }),
  ).toBeInTheDocument();

  const chartsOnlyMessage = await findUserMessage("Use a bar or line chart.");
  expect(
    within(chartsOnlyMessage).getByRole("group", {
      name: "Charts: Bar chart, Line chart",
    }),
  ).toBeInTheDocument();

  const fullChartNames = [
    "Bar chart",
    "Line chart",
    "Pie chart",
    "Scatter plot",
    "Area chart",
    "Stacked bar chart",
    "Heatmap",
    "Bubble chart",
  ].join(", ");
  const longListMessage = await findUserMessage(
    "Summarize many chart options.",
  );
  const longListSummary = within(longListMessage).getByRole("group", {
    name: `Charts: ${fullChartNames}`,
  });
  expect(longListSummary).toBeInTheDocument();
  expect(
    longListSummary.querySelector(
      "[data-structured-visualization-chart-labels]",
    ),
  ).toHaveAttribute("title", fullChartNames);

  const defaultsMessage = await findUserMessage(
    "Use the presentation defaults.",
  );
  expect(
    defaultsMessage.querySelector(
      "[data-structured-visualization-preferences]",
    ),
  ).toBeNull();
  expect(defaultsMessage).not.toHaveTextContent(
    "Presentation Generation Defaults",
  );
  expect(defaultsMessage).not.toHaveTextContent("Slide count: Auto");

  const emptyMessage = await findUserMessage("Summarize without selections.");
  expect(
    emptyMessage.querySelector("[data-structured-visualization-preferences]"),
  ).toBeNull();

  const reportMessage = await findUserMessage("Write a report.");
  expect(
    within(reportMessage).getByRole("group", { name: "Report" }),
  ).toBeInTheDocument();

  const legacyMessage = await findUserMessage("Use a website visual.");
  expect(
    within(legacyMessage).getByRole("group", {
      name: "Website, Charts: Bar chart, Line chart",
    }),
  ).toBeInTheDocument();

  const defaultReportMessage = await findUserMessage(
    "Use the default report with charts.",
  );
  expect(
    within(defaultReportMessage).getByRole("group", {
      name: "Charts: Bar chart, Line chart",
    }),
  ).toBeInTheDocument();
});
