import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { pathname, search } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const draftStorage = localStorageSignals("onboarding:sources-first-draft");
const stepStorage = localStorageSignals("onboarding:sources-first-step");
const SOURCES_FIRST_ON = {
  [FeatureSwitchKey.OnboardingSourcesFirst]: true,
} as const;

// A fresh app receives browser storage from its previous lifetime, including
// foreign or invalid progress that cannot be created through the current UI.
function seedProgress(
  step: string,
  identity = { orgId: "org_default", userId: "test-user-123" },
): void {
  context.store.set(stepStorage.set$, JSON.stringify({ ...identity, step }));
  context.store.set(
    draftStorage.set$,
    JSON.stringify({
      version: 2,
      ...identity,
      industry: "marketing",
      experienced: false,
      provider: null,
      startingPromptDraft: "Draft my launch plan",
      startingPromptKey: "marketing:gmail",
      recommendationJobId: null,
      recommendationStartedAt: null,
    }),
  );
}

function getButtonByName(name: string): HTMLElement {
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

test.each([ROUTES.home, ROUTES.onboarding])(
  "Reopening %s resumes the saved step and still allows Back",
  async (path) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    mockOnboardingConnectorCatalog(context, []);
    seedProgress("sources");

    await setupPage({
      context,
      locale: "en-US",
      path: `${path}?prompt=Launch+plan&redeemCode=LAUNCH50`,
      featureSwitches: SOURCES_FIRST_ON,
    });

    await screen.findByRole("heading", { name: "Connect a work tool" });
    expect(pathname()).toBe(ROUTES.onboardingSources);
    expect(new URLSearchParams(search()).get("prompt")).toBe("Launch plan");
    expect(new URLSearchParams(search()).get("redeemCode")).toBe("LAUNCH50");

    click(getButtonByName("Back"));

    await screen.findByRole("heading", {
      name: "What kind of work do you do?",
    });
    expect(pathname()).toBe(ROUTES.onboarding);
    expect(getButtonByName("Continue")).toBeEnabled();

    click(getButtonByName("Continue"));

    await screen.findByRole("heading", { name: "Connect a work tool" });
  },
);

test("An explicit step URL takes precedence over saved progress", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockOnboardingConnectorCatalog(context, []);
  seedProgress("ready");

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingSources,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await screen.findByRole("heading", { name: "Connect a work tool" });
  expect(pathname()).toBe(ROUTES.onboardingSources);
});

test("Resuming a later step rechecks its connected-source requirement", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockOnboardingConnectorCatalog(context, []);
  seedProgress("ready");

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await screen.findByRole("heading", { name: "What kind of work do you do?" });
  expect(pathname()).toBe(ROUTES.onboarding);
});

test.each([
  { step: "team", isAdmin: false },
  { step: "skills", isAdmin: true },
])(
  "A saved $step step must belong to the current flow",
  async ({ step, isAdmin }) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin,
    });
    mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
    seedProgress(step);

    await setupPage({
      context,
      locale: "en-US",
      path: ROUTES.onboarding,
      featureSwitches: SOURCES_FIRST_ON,
    });

    await screen.findByRole("heading", {
      name: "How would you like to start with Okou?",
    });
    expect(pathname()).toBe(ROUTES.onboardingExperience);
  },
);

test.each([
  { orgId: "org_other", userId: "test-user-123", step: "sources" },
  { orgId: "org_default", userId: "another-user", step: "sources" },
  { orgId: "org_default", userId: "test-user-123", step: "unknown-step" },
])(
  "Unusable progress starts at the first step: %j",
  async ({ step, ...identity }) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    seedProgress(step, identity);

    await setupPage({
      context,
      locale: "en-US",
      path: ROUTES.onboarding,
      featureSwitches: SOURCES_FIRST_ON,
    });

    await screen.findByRole("heading", {
      name: "What kind of work do you do?",
    });
    expect(pathname()).toBe(ROUTES.onboarding);
  },
);

test.each([ROUTES.home, ROUTES.onboarding])(
  "Reopening %s after server-side completion opens chat instead of saved progress",
  async (path) => {
    seedProgress("ready");

    await setupPage({ context, path, featureSwitches: SOURCES_FIRST_ON });

    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeInTheDocument();
  },
);

test("A failed completion keeps the ready step and edited request available for retry", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  seedProgress("ready");
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not finish onboarding",
      },
    });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await screen.findByRole("heading", {
    name: "Start with a task that matters",
  });
  click(getButtonByName("Start with Okou"));

  await screen.findByText("Could not finish onboarding");
  expect(pathname()).toBe(ROUTES.onboardingReady);
  expect(screen.getByLabelText("Your starting prompt")).toHaveValue(
    "Draft my launch plan",
  );
  await waitFor(() => {
    expect(getButtonByName("Start with Okou")).toBeEnabled();
  });
});
