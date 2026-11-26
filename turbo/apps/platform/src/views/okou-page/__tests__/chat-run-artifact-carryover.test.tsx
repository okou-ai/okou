// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  serveTidalChart,
  surveyOutputs,
  surveyRunId,
  formattedObservations,
  chartUrl,
  reportUrl,
} from "./run-output-history-fixtures.ts";
const context = testContext();
const summary = "The field review is complete.";
async function enterRun(
  options: Parameters<typeof mockArtifactConversation>[1],
) {
  mockArtifactConversation(context, options);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
  });
}
test("chat-run-artifact-carryover-001 the final actions carry the historical report while its source stays folded", async () => {
  await enterRun({
    catalog: [],
    chatEvents: surveyOutputs([
      "Received soundings",
      "[Report](" + reportUrl + ")",
      summary,
    ]),
  });
  await expect(screen.findByText(summary)).resolves.toBeVisible();
  const trigger = await findAction("button", "1 artifact");
  expect(trigger.closest('[data-testid="chat-event-actions"]')).toBeVisible();
  expect(queryAction("link", "Report")).toBeNull();
  expect(screen.queryByText("Received soundings")).toBeNull();
  click(trigger);
  const list = await screen.findByTestId("chat-run-related-artifacts-dialog");
  await expect(
    findAction("button", "Preview Report", list),
  ).resolves.toBeVisible();
  click(await findAction("button", "Close", list));
  click(await findAction("button", "Expand work history"));
  await expect(findAction("link", "Report")).resolves.toHaveAttribute(
    "href",
    reportUrl,
  );
  click(await findAction("link", "Report"));
  const viewer = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(viewer.querySelector("iframe")).toHaveAttribute(
      "src",
      reportUrl + "#navpanes=0",
    );
  });
});
test("chat-run-artifact-carryover-009 formatted history keeps an inline chart and a plan card separate from downloadable artifacts", async () => {
  serveTidalChart(context);
  await enterRun({
    catalog: [],
    chatEvents: surveyOutputs([
      formattedObservations,
      "[Compare plans](https://app.okou.ai/?settings=billing&billingView=plans)",
      summary,
    ]),
  });
  click(await findAction("button", "Expand work history"));
  await expect(
    screen.findByRole("heading", { name: "Tidal observations" }),
  ).resolves.toBeVisible();
  expect(
    screen.getByText("north station", { selector: "strong" }),
  ).toBeVisible();
  expect(screen.getByAltText("Tidal range chart")).toBeVisible();
  expect(screen.getByAltText("Tidal range chart")).toHaveAttribute(
    "src",
    chartUrl,
  );
  await expect(screen.findByTestId("plan-upgrade-card")).resolves.toBeVisible();
  expect(screen.queryByTestId("chat-run-related-artifacts-trigger")).toBeNull();
});
test("chat-run-artifact-carryover-010 a replacement message removes the obsolete PDF from the delivered run", async () => {
  const events = surveyOutputs(["[Obsolete report](" + reportUrl + ")"]);
  events.push({
    id: "correction",
    role: "assistant",
    runId: surveyRunId,
    revokesEventId: "survey-output-0",
    content: "The obsolete report was withdrawn.",
    createdAt: "2026-09-15T08:08:00Z",
  });
  await enterRun({ catalog: [], chatEvents: events });
  await expect(
    screen.findByText("The obsolete report was withdrawn."),
  ).resolves.toBeVisible();
  expect(document.querySelector('a[href="' + reportUrl + '"]')).toBeNull();
  expect(screen.queryByTestId("chat-run-related-artifacts-trigger")).toBeNull();
  expect(screen.queryByLabelText("Expand work history")).toBeNull();
});

test("chat-run-history-preview-002 six outputs retain the active result and thinking indicator through a history toggle", async () => {
  const steps = Array.from({ length: 6 }, (_, i) => {
    return "Step " + (i + 1);
  });
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: surveyOutputs(steps),
    activeRunIds: [surveyRunId],
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
  });
  const result = await screen.findByText("Step 6");
  for (const label of steps.slice(0, 5)) {
    expect(screen.queryByText(label)).toBeNull();
  }
  click(await findAction("button", "Expand work history"));
  for (const label of steps) {
    await expect(screen.findByText(label)).resolves.toBeVisible();
  }
  expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
  click(await findAction("button", "Collapse work history"));
  expect(result).toBeVisible();
  for (const label of steps.slice(0, 5)) {
    expect(screen.queryByText(label)).toBeNull();
  }
  await expect(findAction("button", "Copy message")).resolves.toBeVisible();
  expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
});
test("chat-run-history-preview-003 completed history renders its formatted finding, chart and PDF beside the final answer", async () => {
  serveTidalChart(context);
  const chatEvents = surveyOutputs([
    formattedObservations,
    "[Download soundings](" + reportUrl + ")",
    "The survey is complete",
  ]);
  mockArtifactConversation(context, { catalog: [], chatEvents });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
  });
  click(await findAction("button", "Expand work history"));
  await expect(
    screen.findByRole("heading", { name: "Tidal observations" }),
  ).resolves.toBeVisible();
  expect(
    screen.getByText("north station", { selector: "strong" }),
  ).toBeVisible();
  expect(screen.getByAltText("Tidal range chart")).toBeVisible();
  expect(screen.getByAltText("Tidal range chart")).toHaveAttribute(
    "src",
    chartUrl,
  );
  await expect(
    findAction("link", "Download soundings"),
  ).resolves.toHaveAttribute("href", reportUrl);
  expect(screen.getByText("The survey is complete")).toBeVisible();
  click(await findAction("link", "Download soundings"));
  const viewer = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(viewer.querySelector("iframe")).toHaveAttribute(
      "src",
      reportUrl + "#navpanes=0",
    );
  });
});
