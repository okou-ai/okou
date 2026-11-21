// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { test, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse } from "msw";
import { strToU8, zipSync, unzipSync, strFromU8 } from "fflate";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fetchResource } from "../../../lib/resource-fetch.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  artifactSummary,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
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
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
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
  const viewer = await screen.findByTestId("artifact-dialog-document-frame");
  await waitFor(() => {
    return expect(viewer.querySelector("iframe")).toHaveAttribute(
      "src",
      reportUrl + "#navpanes=0",
    );
  });
});
test("chat-run-artifact-carryover-002 the labeled evidence image opens above its related list", async () => {
  const imageUrl = "https://cdn.okou.io/artifacts/coastal/survey/transect.png";
  await enterRun({
    catalog: [],
    chatEvents: surveyOutputs([
      "[Supporting evidence](" + imageUrl + ")",
      "Checked the sample",
      summary,
    ]),
  });
  click(await findAction("button", "1 artifact"));
  const list = await screen.findByTestId("chat-run-related-artifacts-dialog");
  const row = await findAction("button", "Preview Supporting evidence", list);
  expect(row).toHaveTextContent("Supporting evidence");
  click(row);
  const box = await screen.findByTestId("attachment-lightbox");
  expect(box).toBeVisible();
  expect(list).toBeVisible();
  expect(box.querySelector("img")).toHaveAttribute("src", imageUrl);
});
test("chat-run-artifact-carryover-004 a carried archive downloads above the list while an unavailable sidebar is open", async () => {
  const archive = "https://cdn.okou.io/artifacts/coastal/survey/archive.zip",
    entry = "soundings.txt",
    data = "Tide station 17";
  const bytes = zipSync({ [entry]: strToU8(data) });
  context.mocks.http.get(archive, () => {
    return new HttpResponse(Uint8Array.from(bytes), {
      headers: { "Content-Type": "application/zip" },
    });
  });
  const browser = context.mocks.browser.blobDownload();
  const unavailable = artifactSummary(
    crypto.randomUUID(),
    "file",
    "Previous expedition",
  );
  await enterRun({
    catalog: [unavailable],
    chatEvents: surveyOutputs([
      "[Archive](" + archive + ")",
      "Packed field files",
      summary,
    ]),
  });
  await openResourceArtifact(unavailable.title);
  const sidebar = await screen.findByTestId(
    "thread-sidebar-artifact-unavailable",
  );
  await expect(
    within(sidebar).findByText("This artifact is no longer available."),
  ).resolves.toBeVisible();
  click(await findAction("button", "1 artifact"));
  const list = await screen.findByTestId("chat-run-related-artifacts-dialog");
  click(await findAction("button", "Preview Archive", list));
  const box = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(box).findByText("No inline preview available for this file."),
  ).resolves.toBeVisible();
  expect(list).toBeVisible();
  click(await findAction("button", "Download", box));
  await waitFor(() => {
    return expect(browser.downloads[0]?.filename).toBe("archive.zip");
  });
  const saved = browser.downloads[0]!;
  expect(saved.url).toBe(archive);
  // Follow the captured native destination against the local delivery service.
  const response = await fetchResource(saved.url, {}, context.signal);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(
    strFromU8(unzipSync(new Uint8Array(await response.arrayBuffer()))[entry]!),
  ).toBe(data);
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
