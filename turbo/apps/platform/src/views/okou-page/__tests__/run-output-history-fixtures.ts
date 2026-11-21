import { HttpResponse } from "msw";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
export const surveyRunId = "660ac925-16f0-4725-a475-c8d66e8c3ab4";
export function surveyOutputs(messages: string[]): MockChatEventInput[] {
  return [
    {
      role: "user",
      content: "Review the survey",
      runId: surveyRunId,
      createdAt: "2026-09-15T08:00:00Z",
    },
    ...messages.map((content, i) => {
      return {
        role: "assistant" as const,
        runId: surveyRunId,
        id: "survey-output-" + i,
        createdAt: new Date(Date.UTC(2026, 8, 15, 8, i + 1)).toISOString(),
        content,
      };
    }),
  ];
}
export const chartUrl = "https://charts.example.test/tidal-range.svg";
export const formattedObservations =
  "## Tidal observations\n\nThe **north station** was active.\n\n![Tidal range chart](" +
  chartUrl +
  ")";
export const reportUrl =
  "https://cdn.okou.io/artifacts/coastal/survey/soundings.pdf";

export function serveTidalChart(context: TestContext) {
  context.mocks.http.get(chartUrl, () => {
    return new HttpResponse(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 70"><title>Tidal range</title><path d="M5 60 L30 30 L55 15 L80 48 L105 28" stroke="navy" fill="none"/></svg>',
      { headers: { "Content-Type": "image/svg+xml" } },
    );
  });
}
