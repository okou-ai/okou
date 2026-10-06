import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  NEW_CHAT_PATH,
} from "./chat-run-test-fixtures.ts";

function billingResponse(credits: number): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier: "pro",
    ...billingPlanCapabilities("pro"),
    credits,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

async function openAccountMenu(
  credits = "20,000 credits",
): Promise<HTMLElement> {
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  const menu = await screen.findByRole("menu");
  await within(menu).findByText(credits);
  return menu;
}

async function showModels(settings: HTMLElement): Promise<void> {
  click(await findEnabledButton("Models", settings));
  await within(settings).findByRole("heading", { name: "Use more models" });
  await within(settings).findAllByText("No accounts connected.");
}

interface SettingsResponses {
  credits: number;
  holdPoliciesAndBilling: boolean;
  holdSubscriptions: boolean;
}

async function openModelsSettings(menu: HTMLElement): Promise<HTMLElement> {
  click(within(menu).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await showModels(settings);
  return settings;
}

async function closeSettings(settings: HTMLElement): Promise<void> {
  click(within(settings).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
}

async function setupLoadedModelsSettings() {
  const responses: SettingsResponses = {
    credits: 20_000,
    holdPoliciesAndBilling: false,
    holdSubscriptions: false,
  };
  const release = context.mocks.deferred<void>();
  installRunChat({ selectedModel: "okou-1.0" });
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    if (responses.holdPoliciesAndBilling) {
      await release.promise;
    }
    return respond(200, billingResponse(responses.credits));
  });
  context.mocks.api(
    personalModelProvidersMainContract.list,
    async ({ respond }) => {
      if (responses.holdSubscriptions) {
        await release.promise;
      }
      return respond(200, { modelProviders: [] });
    },
  );
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
  });
  await screen.findByRole("textbox", { name: "Message" });
  const menu = await openAccountMenu();
  responses.holdPoliciesAndBilling = true;
  const settings = await openModelsSettings(menu);
  await expect(
    findEnabledButton("Connect account", settings),
  ).resolves.toBeEnabled();
  responses.holdSubscriptions = true;
  return { settings, responses, release };
}

async function reopenModelsSettings(
  settings: HTMLElement,
  responses: SettingsResponses,
): Promise<HTMLElement> {
  await closeSettings(settings);
  // Account-menu balance reads have their own freshness contract; only hold
  // subsequent responses once navigation enters Settings again.
  responses.holdPoliciesAndBilling = false;
  responses.holdSubscriptions = false;
  const menu = await openAccountMenu();
  responses.holdPoliciesAndBilling = true;
  responses.holdSubscriptions = true;
  return openModelsSettings(menu);
}

test("Keep loaded model controls usable when switching Settings sections", async () => {
  const { settings } = await setupLoadedModelsSettings();
  click(await findEnabledButton("Preference", settings));
  await within(settings).findByRole("heading", { name: "Preference" });
  await showModels(settings);
  await expect(
    findEnabledButton("Connect account", settings),
  ).resolves.toBeEnabled();
});

test("Keep loaded model controls usable after reopening Settings", async () => {
  const { settings, responses } = await setupLoadedModelsSettings();
  const reopened = await reopenModelsSettings(settings, responses);
  await expect(
    findEnabledButton("Connect account", reopened),
  ).resolves.toBeEnabled();
});

test("Apply realtime billing changes after reopening Settings", async () => {
  const { settings, responses, release } = await setupLoadedModelsSettings();
  const reopened = await reopenModelsSettings(settings, responses);
  await expect(
    findEnabledButton("Connect account", reopened),
  ).resolves.toBeEnabled();
  responses.holdPoliciesAndBilling = false;
  responses.holdSubscriptions = false;
  act(() => {
    release.resolve();
  });
  click(await findEnabledButton("Credit balance", reopened));
  await within(reopened).findByRole("heading", { name: "Credit balance" });
  await within(reopened).findByText("20,000");
  responses.credits = 25_000;
  act(() => {
    context.mocks.ably.trigger("billing:changed");
  });
  await expect(
    within(reopened).findByText("25,000"),
  ).resolves.toBeInTheDocument();
  await closeSettings(reopened);
  await openAccountMenu("25,000 credits");
});
