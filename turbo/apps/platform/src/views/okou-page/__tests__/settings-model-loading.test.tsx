import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { modelProviderConnectionsMainContract } from "@okouai/api-contracts/contracts/model-provider-gateways";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
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
  await within(settings).findByRole("heading", { name: "Personal accounts" });
  await waitFor(() => {
    expect(
      within(settings).queryByTestId("oauth-account-table-skeleton"),
    ).not.toBeInTheDocument();
  });
}

test("Reuse composer data when opening and navigating Settings; refresh on Ably notices", async () => {
  let mode: OrgModelMode = "custom";
  let credits = 20_000;
  const reads = { policies: 0, billing: 0, subscriptions: 0 };
  installRunChat({ selectedModel: MODEL });
  context.mocks.api(modelPoliciesMainContract.list, ({ respond }) => {
    reads.policies += 1;
    return respond(200, policyResponse(mode));
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    reads.billing += 1;
    return respond(200, billingResponse(credits));
  });
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    reads.subscriptions += 1;
    return respond(200, { modelProviders: [] });
  });
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.PersonalModelProviderAccounts]: true },
  });
  await findButton("GPT 5.6 Sol");
  const menu = await openAccountMenu();
  const beforeSettings = { ...reads };
  click(within(menu).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await showModels(settings);
  expect(reads.policies).toBe(beforeSettings.policies);
  expect(reads.billing).toBe(beforeSettings.billing);
  const loaded = { ...reads };

  click(await findEnabledButton("Preference", settings));
  await within(settings).findByRole("heading", { name: "Preference" });
  await showModels(settings);
  expect(reads).toStrictEqual(loaded);
  click(within(settings).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
  const reopenedMenu = await openAccountMenu();
  const beforeReopen = { ...reads };
  click(within(reopenedMenu).getByText("Settings"));
  const reopened = await screen.findByRole("dialog", { name: "Settings" });
  await showModels(reopened);
  expect(reads).toStrictEqual(beforeReopen);

  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "org:org_default",
        "modelPoliciesChanged",
      ),
    ).toBeTruthy();
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
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
  expect(reads.policies).toBeGreaterThan(beforeReopen.policies);
  expect(reads.subscriptions).toBe(beforeReopen.subscriptions);

  credits = 25_000;
  act(() => {
    context.mocks.ably.trigger("billing:changed");
  });
  await waitFor(() => {
    expect(reads.billing).toBeGreaterThan(beforeReopen.billing);
  });
  click(within(reopened).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
  await openAccountMenu("25,000 credits");
});

test("Do not load organization controls while the initial model mode is unknown", async () => {
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let organizationReads = 0;
  context.mocks.api(modelPoliciesMainContract.list, async ({ respond }) => {
    started.resolve();
    await release.promise;
    return respond(200, policyResponse("auto"));
  });
  context.mocks.api(modelProvidersMainContract.list, ({ respond }) => {
    organizationReads += 1;
    return respond(200, { modelProviders: [] });
  });
  context.mocks.api(
    modelProviderConnectionsMainContract.list,
    ({ respond }) => {
      organizationReads += 1;
      return respond(200, { connections: [] });
    },
  );
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
  expect(organizationReads).toBe(0);

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
  expect(organizationReads).toBe(0);
  await page.ready;
});
