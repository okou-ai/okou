import { expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  mockOnboardingConnectorCatalog,
  onboardingSourceItem,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
test("onboarding-source-outcome-001 switching industries replaces the Drive brief with Ads results while both sources are disconnected", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockOnboardingConnectorCatalog(context, [
    onboardingSourceItem({
      slug: "google-drive",
      label: "Google Drive",
      description: "Browse documents",
      hasAccount: false,
    }),
    onboardingSourceItem({
      slug: "google-ads",
      label: "Google Ads",
      description: "Review advertising",
      hasAccount: false,
    }),
  ]);
  await setupPage({ context, path: "/onboarding" });
  click(await screen.findByText("Design & creative"));
  click(await findAction("button", "Continue"));
  const brief = await screen.findByRole("figure", {
    name: /Creative brief prepared from Google Drive/i,
  });
  expect(within(brief).getByText("Client brief")).toBeVisible();
  expect(within(brief).getByText("Refill skincare launch")).toBeVisible();
  expect(getAction("button", "Continue")).toBeDisabled();
  click(await findAction("button", "Back"));
  click(await screen.findByText("Marketing & content"));
  click(await findAction("button", "Continue"));
  const report = await screen.findByRole("figure", {
    name: /Campaign summary prepared from Google Ads/i,
  });
  expect(within(report).getByText("ROAS")).toBeVisible();
  expect(within(report).getByText("4.1×")).toBeVisible();
  expect(
    screen.queryByRole("figure", {
      name: /Creative brief prepared from Google Drive/i,
    }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Refill skincare launch")).not.toBeInTheDocument();
  expect(getAction("button", "Continue")).toBeDisabled();
});
