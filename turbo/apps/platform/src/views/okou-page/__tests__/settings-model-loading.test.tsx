import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import type {
  OrgModelMode,
  OrgModelPoliciesResponse,
  OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import {
  context,
  findButton,
  findEnabledButton,
  installRunChat,
  NEW_CHAT_PATH,
} from "./chat-run-test-fixtures.ts";

const MODEL = "gpt-5.6-sol";
const POLICY_ID = "e7000000-0000-4000-a000-000000000001";

function policyResponse(mode: OrgModelMode): OrgModelPoliciesResponse {
  const model = mode === "auto" ? "okou-1.0" : MODEL;
  const policy: OrgModelPolicy = {
    id: POLICY_ID,
    model,
    modelLabel: mode === "auto" ? "Auto" : "GPT 5.6 Sol",
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
  return {
    modelMode: mode,
    revision: `revision-${mode}`,
    writePreconditionRequired: false,
    modelsAvailableToAdd: [],
    policies: [policy],
  };
}

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
  await within(settings).findByRole("heading", { name: "Models" });
  await within(settings).findByRole("heading", { name: "Available models" });
  await within(settings).findByRole("heading", { name: "Personal accounts" });
  await within(settings).findAllByText("No accounts connected.");
}

interface SettingsResponses {
  mode: OrgModelMode;
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
    mode: "custom",
    credits: 20_000,
    holdPoliciesAndBilling: false,
    holdSubscriptions: false,
  };
  const release = context.mocks.deferred<void>();
  installRunChat({ selectedModel: MODEL });
  context.mocks.api(modelPoliciesMainContract.list, async ({ respond }) => {
    if (responses.holdPoliciesAndBilling) {
      await release.promise;
    }
    return respond(200, policyResponse(responses.mode));
  });
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
    featureSwitches: { [FeatureSwitchKey.PersonalModelProviderAccounts]: true },
  });
  await findButton("GPT 5.6 Sol");
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

test("Apply realtime model policy changes after reopening Settings", async () => {
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
  responses.mode = "auto";
  act(() => {
    context.mocks.ably.triggerOnChannel(
      "org:org_default",
      "modelPoliciesChanged",
      null,
    );
  });
  await within(reopened).findByRole("heading", { name: "Use more models" });
  await expect(
    findEnabledButton("Connect account", reopened),
  ).resolves.toBeEnabled();
  expect(
    within(reopened).queryByRole("heading", { name: "Models" }),
  ).not.toBeInTheDocument();
  expect(
    within(reopened).queryByRole("heading", { name: "Available models" }),
  ).not.toBeInTheDocument();
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

test("Keep the Models header without organization loading UI while the initial mode is pending", async () => {
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(modelPoliciesMainContract.list, async ({ respond }) => {
    started.resolve();
    await release.promise;
    return respond(200, policyResponse("auto"));
  });
  const page = await startPage({
    context,
    path: "/agents?settings=model",
    featureSwitches: { [FeatureSwitchKey.PersonalModelProviderAccounts]: true },
  });
  await page.content;
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await started.promise;
  await within(settings).findByRole("heading", { name: "Models" });
  await within(settings).findByRole("heading", { name: "Personal accounts" });
  expect(
    within(settings).queryByRole("status", { name: "Loading models..." }),
  ).not.toBeInTheDocument();

  act(() => {
    release.resolve();
  });
  await within(settings).findByRole("heading", { name: "Use more models" });
  await expect(
    findEnabledButton("Connect account", settings),
  ).resolves.toBeEnabled();
  expect(
    within(settings).queryByRole("heading", { name: "Models" }),
  ).not.toBeInTheDocument();
  expect(
    within(settings).queryByRole("status", { name: "Loading models..." }),
  ).not.toBeInTheDocument();
  await page.ready;
});
