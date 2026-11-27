import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import type { OnboardingDraftPayload } from "@okouai/api-contracts/validators/onboarding";
import { mockOnboardingDraft } from "../../../__tests__/mock-onboarding-draft.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();

test.each([
  ["onboarding-account-menu-002", "Claude usage", "{Enter}"],
  ["onboarding-account-menu-003", "ChatGPT usage", " "],
])(
  "%s opens model settings from %s using the keyboard",
  async (_id, usage, key) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    const types = ["codex-oauth-token", "claude-code-oauth-token"] as const;
    context.mocks.data.personalModelProviders(
      types.map((type) => {
        return {
          type,
          id: crypto.randomUUID(),
          framework: type === "codex-oauth-token" ? "codex" : "claude-code",
          isActive: true,
          needsReconnect: false,
          lastRefreshErrorCode: null,
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          subscriptionUsage: {
            fiveHour: {
              usedPercent: 20,
              remainingPercent: 80,
              resetAt: null,
              windowSeconds: 18_000,
            },
            weekly: null,
          },
        };
      }),
    );
    const user = userEvent.setup();
    await setupPage({ context, path: "/onboarding" });
    await user.click(await findAction("button", "Test User"));
    const menu = await screen.findByRole("menu");
    const item = await screen.findByLabelText(usage, {
      selector: '[role="menuitem"]',
    });
    for (const _entry of menu.querySelectorAll('[role="menuitem"]')) {
      if (item === document.activeElement) {
        break;
      }
      await user.keyboard("{ArrowDown}");
    }
    expect(item).toHaveFocus();
    await user.keyboard(key);
    const dialog = await screen.findByRole("dialog");
    await screen.findByText("Use more models");
    expect(new URLSearchParams(window.location.search).get("settings")).toBe(
      "model",
    );
    await waitFor(() => {
      return expect(dialog).toContainElement(
        document.activeElement as HTMLElement,
      );
    });
  },
);

function savedProgress(step: OnboardingDraftPayload["step"], text = "") {
  mockOnboardingDraft(context, {
    step,
    answers: {
      industry: "marketing",
      experienced: false,
      provider: null,
      startingPromptDraft: text,
      startingPromptKey: "edited",
      startingPromptOutput: null,
      recommendationJobId: null,
      recommendationStartedAt: null,
    },
  });
}
function newcomer() {
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}
test("onboarding-progress-001 resuming sources keeps redemption through a trip back to the work question", async () => {
  newcomer();
  savedProgress("sources");
  await setupPage({ context, path: "/?redeemCode=RESUME" });
  await screen.findByRole("heading", { name: "Connect a work tool" });
  expect(new URL(location.href).searchParams.get("redeemCode")).toBe("RESUME");
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "What kind of work do you do?" });
  click(await findAction("button", "Continue"));
  await expect(
    screen.findByRole("heading", { name: "Connect a work tool" }),
  ).resolves.toBeVisible();
  expect(new URL(location.href).searchParams.get("redeemCode")).toBe("RESUME");
});
test("onboarding-progress-003 a clean browser restores the task saved on another device", async () => {
  newcomer();
  const text = "Restore this task from my other device";
  savedProgress("ready", text);
  await setupPage({ context, path: "/onboarding" });
  await expect(
    screen.findByRole("heading", { name: /start your first task/i }),
  ).resolves.toBeVisible();
  expect(screen.getByLabelText("Your first task")).toHaveValue(text);
  expect(location.pathname).toBe("/onboarding/ready");
});
test("onboarding-progress-006 an explicit work-tool URL overrides the saved ready step", async () => {
  newcomer();
  savedProgress("ready", "Draft my launch plan");
  await setupPage({ context, path: "/onboarding/sources" });
  await expect(
    screen.findByRole("heading", { name: "Connect a work tool" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/onboarding/sources");
});
test("onboarding-progress-014 completed onboarding opens the Home composer despite stored ready progress", async () => {
  savedProgress("ready", "Draft my launch plan");
  context.mocks.data.onboardingStatus({
    needsOnboarding: false,
    onboardingComplete: true,
  });
  await setupPage({ context, path: "/" });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
});
