import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { buildComposerAdditionalInfo } from "../../../signals/okou-page/composer-additional-info.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const CREATED_AT = "2026-08-20T12:00:00.000Z";
const SUMMARY = "[data-structured-visualization-preferences]";

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

function userMessage(prompt: string): HTMLElement {
  const message = screen
    .getByText(prompt)
    .closest<HTMLElement>('[data-role="user"]');
  if (!message) {
    throw new Error(`User message not found for "${prompt}"`);
  }
  return message;
}

function summaryText(prompt: string): string | null {
  const groups = within(userMessage(prompt)).getAllByRole("group");
  expect(groups).toHaveLength(1);
  return groups[0]?.textContent ?? null;
}

function withReportDefault(info: string | undefined): string | undefined {
  return info ? `${info}\n- Preferred output format: report` : undefined;
}

function legacyInfo(output: "website" | "report"): string {
  return [
    "# Visualization",
    "The user wants a visualized result for this run.",
    `- Preferred output format: ${output}`,
    "- Preferred chart types: bar, line",
  ].join("\n");
}

test("Sent visualization choices are grouped, concise, and only shown when selected", async () => {
  const messages: [string, string | undefined][] = [
    [
      "Create a comparison visual.",
      buildComposerAdditionalInfo(null, "auto", {
        output: "presentation",
        charts: ["bar", "line", "pie"],
      }),
    ],
    [
      "Make a slide deck.",
      buildComposerAdditionalInfo(null, "auto", {
        output: "presentation",
        charts: [],
      }),
    ],
    [
      "Use a bar or line chart.",
      withReportDefault(
        buildComposerAdditionalInfo(null, "auto", {
          output: null,
          charts: ["bar", "line"],
        }),
      ),
    ],
    [
      "Summarize many chart options.",
      buildComposerAdditionalInfo(null, "auto", {
        output: null,
        charts: [
          "bar",
          "line",
          "pie",
          "scatter",
          "area",
          "stacked-bar",
          "heatmap",
          "bubble",
        ],
      }),
    ],
    [
      "Use the presentation defaults.",
      buildComposerAdditionalInfo("presentation", "auto", undefined),
    ],
    [
      "Summarize without selections.",
      withReportDefault(
        buildComposerAdditionalInfo(null, "auto", { output: null, charts: [] }),
      ),
    ],
    [
      "Write a report.",
      buildComposerAdditionalInfo(null, "auto", {
        output: "report",
        charts: [],
      }),
    ],
    ["Use a website visual.", legacyInfo("website")],
    ["Use the default report with charts.", legacyInfo("report")],
  ];
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: messages.map(([prompt, info], index) => {
      return userEventWith(
        prompt,
        `d0000000-0000-4000-a000-00000000006${index + 1}`,
        info,
      );
    }),
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });
  await screen.findByText("Use the default report with charts.");

  const selected = userMessage("Create a comparison visual.");
  expect(summaryText("Create a comparison visual.")).toBe(
    "Presentation · Bar +2",
  );
  for (const raw of [
    "Preferred output format",
    "Preferred chart types",
    "User-selected output format",
    "The user wants a visualized result for this run",
  ]) {
    expect(selected).not.toHaveTextContent(raw);
  }
  expect(summaryText("Make a slide deck.")).toBe("Presentation");
  expect(summaryText("Use a bar or line chart.")).toBe("Bar, Line");
  expect(summaryText("Summarize many chart options.")).toBe("Bar +7");
  expect(summaryText("Write a report.")).toBe("Report");
  expect(summaryText("Use a website visual.")).toBe("Website · Bar, Line");
  expect(summaryText("Use the default report with charts.")).toBe("Bar, Line");

  expect(
    userMessage("Use the presentation defaults.").querySelector(SUMMARY),
  ).toBeNull();
  expect(
    userMessage("Summarize without selections.").querySelector(SUMMARY),
  ).toBeNull();
});
