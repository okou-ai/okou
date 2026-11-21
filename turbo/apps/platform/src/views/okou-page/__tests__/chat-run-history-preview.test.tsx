// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  serveTidalChart,
  surveyOutputs,
  surveyRunId,
  chartUrl,
  formattedObservations,
  reportUrl,
} from "./run-output-history-fixtures.ts";
const context = testContext();
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
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
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
  const viewer = await screen.findByTestId("artifact-dialog-document-frame");
  await waitFor(() => {
    return expect(viewer.querySelector("iframe")).toHaveAttribute(
      "src",
      reportUrl + "#navpanes=0",
    );
  });
});
