import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { mockOnboardingConnectorCatalog } from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const PREVIEW_HOST = "pr-40584-app-okou-app-preview.vm0.workers.dev";
const INDUSTRY_QUESTION = "What kind of work do you do?";

function mockOnboardingNeeded(isAdmin = true): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: !isAdmin,
    isAdmin,
  });
  mockOnboardingConnectorCatalog(context, []);
}

function buttonsNamed(name: string): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return button.textContent?.trim() === name;
  });
}

function buttonNamed(name: string): HTMLElement {
  const button = buttonsNamed(name)[0];
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

test.each([
  { host: PREVIEW_HOST, isAdmin: true },
  { host: "staging-app-okou-app-preview.vm0.workers.dev", isAdmin: false },
  { host: "app-okou-app-preview.vm0.workers.dev", isAdmin: true },
  { host: "pr-40584-app.omby.ai", isAdmin: true },
])(
  "A preview visitor can skip unanswered onboarding on $host",
  async ({ host, isAdmin }) => {
    mockOnboardingNeeded(isAdmin);
    await setupPage({ context, host, path: ROUTES.onboarding });

    expect(
      screen.getByRole("heading", { name: INDUSTRY_QUESTION }),
    ).toBeInTheDocument();
    expect(buttonNamed("Continue")).toBeDisabled();
    expect(buttonNamed("Skip")).toBeEnabled();

    click(buttonNamed("Skip"));

    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toMatch(/^\/agents\/[^/]+\/chat$/u);
    expect(
      screen.queryByRole("heading", { name: INDUSTRY_QUESTION }),
    ).not.toBeInTheDocument();
  },
);

test.each(["app.okou.ai", "okou.ai", "localhost", "127.0.0.1"])(
  "Onboarding does not offer the preview shortcut on %s",
  async (host) => {
    mockOnboardingNeeded();
    await setupPage({ context, host, path: ROUTES.onboarding });

    expect(
      screen.getByRole("heading", { name: INDUSTRY_QUESTION }),
    ).toBeInTheDocument();
    expect(buttonsNamed("Skip")).toHaveLength(0);
    expect(buttonNamed("Continue")).toBeDisabled();
  },
);

test("Skipping sources in a preview continues onboarding", async () => {
  mockOnboardingNeeded();
  await setupPage({
    context,
    host: PREVIEW_HOST,
    path: ROUTES.onboardingSources,
  });

  expect(
    screen.getByRole("heading", { name: "Connect a work tool" }),
  ).toBeInTheDocument();
  click(buttonNamed("Skip"));

  await screen.findByRole("dialog", {
    name: "Okou works better with your tools",
  });
  expect(pathname()).toBe(ROUTES.onboardingSources);
  click(buttonNamed("Skip for now"));

  await screen.findByRole("heading", {
    name: "How would you like to start with Okou?",
  });
  expect(pathname()).toBe(ROUTES.onboardingExperience);
});

test("Skip waits for completion and remains retryable after a failure", async () => {
  mockOnboardingNeeded();
  const completion = context.mocks.deferred<void>();
  let unavailable = true;
  context.mocks.api(
    onboardingCompleteContract.complete,
    async ({ respond, withSignal }) => {
      await withSignal(completion.promise);
      if (unavailable) {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not complete onboarding",
          },
        });
      }
      context.mocks.data.onboardingStatus({
        needsOnboarding: false,
        onboardingComplete: true,
      });
      return respond(200, {
        needsOnboarding: false,
        onboardingComplete: true,
      });
    },
  );
  await setupPage({ context, host: PREVIEW_HOST, path: ROUTES.onboarding });

  click(buttonNamed("Skip"));

  await waitFor(() => {
    for (const button of buttonsNamed("Skip")) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");
    }
  });
  expect(pathname()).toBe(ROUTES.onboarding);
  expect(buttonNamed("Continue")).toBeDisabled();

  completion.resolve();
  await expect(
    screen.findByText("Could not complete onboarding"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(buttonNamed("Skip")).toBeEnabled();
  });
  expect(pathname()).toBe(ROUTES.onboarding);

  unavailable = false;
  click(buttonNamed("Skip"));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toMatch(/^\/agents\/[^/]+\/chat$/u);
});

test("Skipping a preview prompt handoff opens the app without running the prompt", async () => {
  mockOnboardingNeeded();
  await setupPage({
    context,
    host: PREVIEW_HOST,
    path: `${ROUTES.onboarding}?prompt=Draft+the+launch+plan&redeemCode=PREVIEW`,
  });

  expect(
    screen.getByRole("heading", { name: "Make this task your own" }),
  ).toBeInTheDocument();
  click(buttonNamed("Skip"));

  const composer = await screen.findByRole("textbox", { name: "Message" });
  expect(composer).toHaveTextContent(/^$/u);
  expect(pathname()).toMatch(/^\/agents\/[^/]+\/chat$/u);
  expect(new URLSearchParams(search()).has("prompt")).toBeFalsy();
});
