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
    isDefault: true,
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
    workspaceDefaultModel: model,
    workspaceDefaultPolicyId: POLICY_ID,
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

test("Keep loaded model controls usable during Settings navigation and apply realtime changes", async () => {
  let mode: OrgModelMode = "custom";
  let credits = 20_000;
  const release = context.mocks.deferred<void>();
  let holdPoliciesAndBilling = false;
  let holdSubscriptions = false;
  installRunChat({ selectedModel: MODEL });
  context.mocks.api(modelPoliciesMainContract.list, async ({ respond }) => {
    if (holdPoliciesAndBilling) {
      await release.promise;
    }
    return respond(200, policyResponse(mode));
  });
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    if (holdPoliciesAndBilling) {
      await release.promise;
    }
    return respond(200, billingResponse(credits));
  });
  context.mocks.api(
    personalModelProvidersMainContract.list,
    async ({ respond }) => {
      if (holdSubscriptions) {
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
  holdPoliciesAndBilling = true;
  click(within(menu).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await showModels(settings);
  await expect(
    findEnabledButton("Add account", settings),
  ).resolves.toBeEnabled();
  holdSubscriptions = true;

  click(await findEnabledButton("Preference", settings));
  await within(settings).findByRole("heading", { name: "Preference" });
  await showModels(settings);
  await expect(
    findEnabledButton("Add account", settings),
  ).resolves.toBeEnabled();
  click(within(settings).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
  // Account-menu balance reads have their own freshness contract; only hold
  // subsequent responses once navigation enters Settings again.
  holdPoliciesAndBilling = false;
  holdSubscriptions = false;
  const reopenedMenu = await openAccountMenu();
  holdPoliciesAndBilling = true;
  holdSubscriptions = true;
  click(within(reopenedMenu).getByText("Settings"));
  const reopened = await screen.findByRole("dialog", { name: "Settings" });
  await showModels(reopened);
  await expect(
    findEnabledButton("Add account", reopened),
  ).resolves.toBeEnabled();

  holdPoliciesAndBilling = false;
  holdSubscriptions = false;
  act(() => {
    release.resolve();
  });
  mode = "auto";
  act(() => {
    context.mocks.ably.triggerOnChannel(
      "org:org_default",
      "modelPoliciesChanged",
      null,
    );
  });
  await within(reopened).findByText("Easy model");
  await within(reopened).findByRole("heading", {
    name: "Personal Model Subscriptions",
  });
  expect(
    within(reopened).getByRole("heading", { name: "Models" }),
  ).toBeInTheDocument();
  expect(
    within(reopened).queryByRole("heading", { name: "Available models" }),
  ).not.toBeInTheDocument();

  credits = 25_000;
  act(() => {
    context.mocks.ably.trigger("billing:changed");
  });
  click(within(reopened).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
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
  await within(settings).findByText("Easy model");
  await within(settings).findByRole("heading", {
    name: "Personal Model Subscriptions",
  });
  expect(
    within(settings).getByRole("heading", { name: "Models" }),
  ).toBeInTheDocument();
  expect(
    within(settings).queryByRole("status", { name: "Loading models..." }),
  ).not.toBeInTheDocument();
  await page.ready;
});
