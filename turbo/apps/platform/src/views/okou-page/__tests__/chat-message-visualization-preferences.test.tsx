import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";
const context = testContext();

test("chat-message-visualization-preferences-001 reads the format and chart choices on each saved request", async () => {
  const selected = (output: string, charts: string) => {
    return (
      "# Visualization Selection\n- User-selected output format: " +
      output +
      "\n- User-selected chart types: " +
      charts
    );
  };
  const legacy = (output: string, charts: string) => {
    return (
      "# Visualization\n- Preferred output format: " +
      output +
      "\n- Preferred chart types: " +
      charts
    );
  };
  const saved = [
    {
      request: "Present the margin analysis",
      note:
        legacy("presentation", "bar, line, pie") +
        "\n\n" +
        selected("presentation", "bar, line, pie"),
      label: "Presentation · Bar +2",
    },
    {
      request: "Create the board slides",
      note: selected("presentation", ""),
      label: "Presentation",
    },
    {
      request: "Compare the two series",
      note: selected("none", "line, pie"),
      label: "Line, Pie",
    },
    {
      request: "Review the entire portfolio",
      note: selected(
        "none",
        "bar, line, pie, scatter, area, stacked-bar, heatmap, bubble",
      ),
      label: "Bar +7",
    },
    {
      request: "Deliver the written brief",
      note: selected("report", ""),
      label: "Report",
    },
    {
      request: "Refresh last year's dashboard",
      note: legacy("website", "line, area"),
      label: "Website · Line, Area",
    },
    {
      request: "Reuse last year's chart selection",
      note: legacy("report", "pie, bar"),
      label: "Pie, Bar",
    },
    {
      request: "Use the original defaults",
      note: "# Presentation Generation Defaults\n- Slide count: Auto",
      label: "",
    },
    {
      request: "Clear the explicit choices",
      note: legacy("report", "") + "\n\n" + selected("none", ""),
      label: "",
    },
  ];
  mockAttachmentChat(context, {
    chatEvents: saved.map(({ request, note }) => {
      return {
        role: "user",
        content: null,
        createdAt: "2026-10-06T14:00:00Z",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: request },
            { type: "additional_info", text: note },
          ],
        },
      };
    }),
  });
  await setupPage({ context, path: "/chats/" + ATTACHMENT_THREAD_ID });
  for (const { request, label } of saved) {
    const prompt = await screen.findByText(request);
    const turn = prompt.closest<HTMLElement>('[data-role="user"]')!;
    const summaries = within(turn).queryAllByRole("group");
    expect(
      summaries.map((group) => {
        return group.textContent;
      }),
    ).toStrictEqual(label ? [label] : []);
  }
  const portfolio = screen
    .getByText("Review the entire portfolio")
    .closest<HTMLElement>('[data-role="user"]')!;
  expect(within(portfolio).getByRole("group")).toHaveAccessibleName(
    "Charts: Bar chart, Line chart, Pie chart, Scatter plot, Area chart, Stacked bar chart, Heatmap, Bubble chart",
  );
  expect(
    screen
      .getByText("Present the margin analysis")
      .closest('[data-role="user"]'),
  ).not.toHaveTextContent(
    /# Visualization|(?:Preferred|User-selected) (?:output format|chart types)/,
  );
});
