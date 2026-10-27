import { FeatureSwitchKey } from "@okouai/core";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockOnboardingConnectorCatalog,
  onboardingSourceItem,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();

function action(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

async function chooseIndustry(name: string): Promise<void> {
  const label = (await screen.findByText(name)).closest("label");
  if (!label) {
    throw new Error(`Expected industry choice "${name}"`);
  }
  click(within(label).getByRole("radio"));
  await waitFor(() => {
    return expect(action("Continue")).toBeEnabled();
  });
  click(action("Continue"));
}

function catalog(includeDrive = true): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockOnboardingConnectorCatalog(context, [
    ...(includeDrive
      ? [
          onboardingSourceItem({
            slug: "google-drive",
            label: "Google Drive",
            description: "Manage Drive files",
            hasAccount: false,
          }),
        ]
      : []),
    onboardingSourceItem({
      slug: "google-ads",
      label: "Google Ads",
      description: "Review ad performance",
      hasAccount: false,
    }),
    onboardingSourceItem({
      slug: "gmail",
      label: "Gmail",
      description: "Manage email",
      hasAccount: false,
    }),
  ]);
}

test("changing the selected industry updates its outcome without connecting a source", async () => {
  catalog();
  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: { [FeatureSwitchKey.OnboardingSourceOutcomes]: true },
  });
  await chooseIndustry("Design & creative");

  const creative = await screen.findByRole("figure", {
    name: /Illustrative Creative brief prepared from Google Drive/u,
  });
  expect(
    within(creative).getByText("Refill skincare launch"),
  ).toBeInTheDocument();
  expect(within(creative).getByText("Client brief")).toBeInTheDocument();
  expect(action("Continue")).toBeDisabled();

  click(action("Back"));
  await chooseIndustry("Marketing & content");
  const campaign = await screen.findByRole("figure", {
    name: /Illustrative Campaign summary prepared from Google Ads/u,
  });
  expect(within(campaign).getByText("ROAS")).toBeInTheDocument();
  expect(screen.queryByText("Refill skincare launch")).not.toBeInTheDocument();
  expect(action("Continue")).toBeDisabled();
});

test("the original source step remains available when outcome guidance is disabled", async () => {
  catalog();
  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: { [FeatureSwitchKey.OnboardingSourceOutcomes]: false },
  });
  await chooseIndustry("Design & creative");
  await expect(
    screen.findByRole("heading", { name: "Connect a work tool" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("figure")).not.toBeInTheDocument();
  expect(screen.getByText("Manage Drive files")).toBeInTheDocument();
  expect(action("Continue")).toBeDisabled();
});

test("an unavailable featured source does not advertise an outcome for that source", async () => {
  catalog(false);
  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: { [FeatureSwitchKey.OnboardingSourceOutcomes]: true },
  });
  await chooseIndustry("Design & creative");
  await expect(
    screen.findByRole("heading", { name: "Connect a work tool" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("figure")).not.toBeInTheDocument();
  expect(screen.getByText("Gmail")).toBeInTheDocument();
  expect(action("Continue")).toBeDisabled();
});

test("a phone can expand the example while the connection requirement stays in place", async () => {
  catalog();
  context.mocks.browser.matchMedia((query) => {
    return query === "(width < 640px)";
  });
  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: { [FeatureSwitchKey.OnboardingSourceOutcomes]: true },
  });
  await chooseIndustry("Design & creative");
  const summary = await screen.findByText("See an example of what you can get");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  click(summary);
  await waitFor(() => {
    return expect(summary.closest("details")).toHaveAttribute("open");
  });
  await expect(
    screen.findByRole("figure", {
      name: /Illustrative Creative brief prepared from Google Drive/u,
    }),
  ).resolves.toBeInTheDocument();
  expect(action("Continue")).toBeDisabled();
  expect(screen.getByText("Permissions and privacy")).toBeInTheDocument();
});
