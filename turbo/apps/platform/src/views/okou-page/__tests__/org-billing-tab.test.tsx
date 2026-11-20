import {
  billingAutoRechargeContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
  billingUsagePackManagementContract,
  billingUsagePackMigrationContract,
  billingConcurrencyCheckoutContract,
  billingConcurrencySubscriptionContract,
  billingCreditCheckoutContract,
  billingDowngradeContract,
  billingRestoreContract,
  billingStatusContract,
  type BillingStatusResponse,
  type CreditCheckoutRequest,
  type UsagePackMigrationStateResponse,
} from "@okouai/api-contracts/contracts/billing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

function queryButtonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement | undefined {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButtonByText(text, container);
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function subscriptionComparisonTrigger(
  container: ParentNode = document.body,
): HTMLElement {
  const trigger = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate
      .getAttribute("aria-label")
      ?.startsWith("Subscription comparison:");
  });
  if (!trigger) {
    throw new Error("Subscription comparison trigger not found");
  }
  return trigger;
}

async function hoverSubscriptionComparison(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.hover(subscriptionComparisonTrigger());
  return await screen.findByRole("tooltip");
}

function activeProBillingStatus(): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier: "pro",
    ...billingPlanCapabilities("pro"),
    credits: 25_000,
    onboardingPaymentPending: false,
    subscriptionStatus: "active",
    currentPeriodEnd: "2026-04-01T00:00:00Z",
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: true,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: {
      expiringNextCycle: 0,
      nextExpiryDate: null,
    },
    creditBreakdown: [
      {
        category: "plan",
        tier: "pro",
        label: "Pro credits",
        credits: 20_000,
      },
      {
        category: "payAsYouGo",
        label: "Purchased credits",
        credits: 5000,
      },
    ],
    creditGrants: [],
    concurrencyLimit: 3,
    concurrencySubscriptions: [],
    concurrencyUnitAmountCents: 10_000,
  };
}

function activeTeamBillingStatus(): BillingStatusResponse {
  return {
    ...activeProBillingStatus(),
    tier: "team",
    ...billingPlanCapabilities("team"),
    credits: 130_000,
    currentPeriodEnd: "2026-05-01T00:00:00Z",
    concurrencyLimit: 10,
    creditBreakdown: [
      {
        category: "plan",
        tier: "team",
        label: "Team credits",
        credits: 120_000,
      },
      {
        category: "payAsYouGo",
        label: "Purchased credits",
        credits: 10_000,
      },
    ],
  };
}

function noActiveBillingStatus(): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier: "limited-free-1",
    ...billingPlanCapabilities("limited-free-1"),
    credits: 0,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: {
      expiringNextCycle: 0,
      nextExpiryDate: null,
    },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 1,
    concurrencySubscriptions: [],
  };
}

function usagePackCatalogResponse() {
  return {
    supportsFreeMembers: true as const,
    usagePacks: [
      {
        usagePackUsd: 20 as const,
        priceUsd: 20,
        purchasedCredits: 20_000,
        bonusCredits: 1234,
        totalCredits: 21_234,
      },
      {
        usagePackUsd: 50 as const,
        priceUsd: 50,
        purchasedCredits: 50_000,
        bonusCredits: 4321,
        totalCredits: 54_321,
      },
      {
        usagePackUsd: 100 as const,
        priceUsd: 100,
        purchasedCredits: 100_000,
        bonusCredits: 9999,
        totalCredits: 109_999,
      },
      {
        usagePackUsd: 200 as const,
        priceUsd: 200,
        purchasedCredits: 200_000,
        bonusCredits: 30_000,
        totalCredits: 230_000,
      },
    ],
  };
}

function mockBillingStory(initialStatus = activeProBillingStatus()): {
  readonly creditCheckoutRequest: () => CreditCheckoutRequest | null;
} {
  let billingStatus = initialStatus;
  let creditCheckoutRequest: CreditCheckoutRequest | null = null;

  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus);
  });
  context.mocks.api(billingAutoRechargeContract.update, ({ body, respond }) => {
    billingStatus = {
      ...billingStatus,
      autoRecharge: {
        enabled: body.enabled,
        threshold: body.enabled ? (body.threshold ?? null) : null,
        amount: body.enabled ? (body.amount ?? null) : null,
      },
    };
    return respond(200, billingStatus.autoRecharge);
  });
  context.mocks.api(
    billingCreditCheckoutContract.create,
    ({ body, respond }) => {
      creditCheckoutRequest = body;
      return respond(200, {
        url: "https://billing.stripe.com/checkout/credit-purchase",
      });
    },
  );
  context.mocks.api(billingDowngradeContract.create, ({ respond }) => {
    billingStatus = {
      ...billingStatus,
      cancelAtPeriodEnd: true,
      canRestorePlan: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: "2026-04-01T00:00:00Z",
      },
    };
    return respond(200, {
      success: true,
      effectiveDate: "2026-04-01T00:00:00Z",
    });
  });
  context.mocks.api(billingRestoreContract.create, ({ respond }) => {
    billingStatus = {
      ...billingStatus,
      cancelAtPeriodEnd: false,
      canRestorePlan: false,
      scheduledChange: null,
    };
    return respond(200, { status: "restored" });
  });
  return {
    creditCheckoutRequest: () => {
      return creditCheckoutRequest;
    },
  };
}

async function openBillingTab(path = "/?settings=billing"): Promise<void> {
  await setupPage({
    context,
    path,
  });
  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Billing" }),
    ).toBeInTheDocument();
  });
}

test.each([false, true])(
  "The iOS billing management link opens Billing settings (My Okou=%s)",
  async (singleAgent) => {
    mockBillingStory();
    await setupPage({
      context,
      path: "/settings/billing",
      featureSwitches: { [FeatureSwitchKey.SingleAgent]: singleAgent },
    });
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await expect(
      within(settings).findByRole("heading", { name: "Billing" }),
    ).resolves.toBeInTheDocument();
  },
);

function inAppBillingPreviewFields() {
  return {
    supportsInAppPreview: true as const,
    returnUrl: new URL(
      window.location.pathname,
      window.location.origin,
    ).toString(),
  };
}

function mockInitialUsagePackPurchase(): void {
  context.mocks.data.org({
    id: "org_1",
    name: "Usage Pack Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, noActiveBillingStatus());
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse());
  });
  context.mocks.data.orgMembers({
    name: "Usage Pack Org",
    role: "admin",
    members: [
      {
        userId: "user_1",
        email: "alex@example.com",
        firstName: "Alex",
        lastName: "Chen",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00Z",
      },
      {
        userId: "user_2",
        email: "sam@example.com",
        firstName: "Sam",
        lastName: "Lee",
        imageUrl: "",
        role: "member",
        joinedAt: "2026-01-02T00:00:00Z",
      },
    ],
    pendingInvitations: [
      {
        id: "invitation_1",
        email: "pending@example.com",
        role: "member",
        createdAt: "2026-01-03T00:00:00Z",
      },
    ],
    membershipRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
}

async function openUsagePackPlanSelection(
  path = "/?settings=billing",
): Promise<{
  choosePlanHeading: HTMLElement;
  proPlan: HTMLElement;
  teamPlan: HTMLElement;
}> {
  await setupPage({
    context,
    path,
    auth: {
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    },
  });

  await waitFor(() => {
    expect(screen.getByText("No active plan")).toBeInTheDocument();
  });
  click(buttonByText("Upgrade"));

  const choosePlanHeading = await screen.findByRole("heading", {
    name: "Choose a plan",
  });
  const proPlan = await screen.findByRole("article", { name: "Pro plan" });
  const teamPlan = screen.getByRole("article", { name: "Team plan" });
  return { choosePlanHeading, proPlan, teamPlan };
}

async function openTeamMemberPackages(teamPlan: HTMLElement): Promise<{
  configurePackagesHeading: HTMLElement;
  memberUsage: HTMLElement;
  orderSummary: HTMLElement;
}> {
  click(buttonByText("Start with Team", teamPlan));
  const configurePackagesHeading = await screen.findByRole("heading", {
    name: "Configure member packages",
  });
  const memberUsage = screen.getByRole("group", {
    name: "Member usage",
  });
  const orderSummary = screen.getByRole("region", {
    name: "Order summary",
  });
  return { configurePackagesHeading, memberUsage, orderSummary };
}

async function selectMemberUsagePack(
  memberUsage: HTMLElement,
  memberName: string,
  optionName: string,
): Promise<void> {
  click(
    within(memberUsage).getByRole("combobox", {
      name: `Usage for ${memberName}`,
    }),
  );
  click(await screen.findByRole("option", { name: optionName }));
}

test("Compare both usage-pack prices before choosing a plan", async () => {
  mockInitialUsagePackPurchase();
  const { choosePlanHeading, proPlan, teamPlan } =
    await openUsagePackPlanSelection();
  expect(choosePlanHeading).toBeInTheDocument();
  expect(
    within(proPlan).getByText("3 tasks running at once"),
  ).toBeInTheDocument();
  expect(proPlan).toHaveTextContent("Scheduled & app automations");
  // The plan steps are a dialog over the billing tab, not a page that
  // replaces it, so the plan the workspace is deciding against stays visible.
  expect(screen.getByText("No active plan")).toBeInTheDocument();
  // The figure is a floor, not a fixed total: a workspace pays the plan plus
  // at least one paid package, and paid packages run $20 to $200.
  expect(proPlan).toHaveTextContent("from $20/month");
  expect(
    within(proPlan).getByText("Plan $0 · member packages $20–$200 each"),
  ).toBeInTheDocument();
  expect(teamPlan).toHaveTextContent("from $180/month");
  expect(
    within(teamPlan).getByText("Plan $160 · member packages $20–$200 each"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Choose a paid package for each member in the next step, or select No package.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Member usage" }),
  ).not.toBeInTheDocument();
});

test.each(["pro"] as const)(
  "Default new '%s' member packages through 'checkout preview'",
  async (tier) => {
    mockInitialUsagePackPurchase();
    context.mocks.api(
      billingUsagePackCheckoutContract.create,
      ({ body, respond }) => {
        expect(body).toMatchObject({
          tier,
          supportsInAppPreview: true,
          memberUsagePacks: [
            { memberId: "user_1", usagePackUsd: 20 },
            { memberId: "user_2", usagePackUsd: 20 },
            { memberId: "invitation_1", usagePackUsd: 20 },
          ],
        });
        return respond(200, {
          status: "preview",
          purchaseType: "usage_pack",
          tier,
          immediateAmountCents: tier === "pro" ? 6000 : 22_000,
          nextRecurringAmountCents: tier === "pro" ? 6000 : 22_000,
          currency: "usd",
          expiresAt: "2026-03-16T00:15:00Z",
          previewToken: `usage-pack-${tier}-preview`,
        });
      },
    );
    const { proPlan, teamPlan } = await openUsagePackPlanSelection(
      "/agents?settings=billing",
    );
    const plan = tier === "pro" ? proPlan : teamPlan;
    click(
      buttonByText(tier === "pro" ? "Start with Pro" : "Start with Team", plan),
    );
    const memberUsage = await screen.findByRole("group", {
      name: "Member usage",
    });
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    const upgradeLabel = tier === "pro" ? "Upgrade to Pro" : "Upgrade to Team";
    for (const memberName of ["Alex Chen", "Sam Lee", "pending@example.com"]) {
      expect(
        within(memberUsage).getByRole("combobox", {
          name: `Usage for ${memberName}`,
        }),
      ).toHaveTextContent("21,234 credits · 6% off");
    }
    expect(buttonByText(upgradeLabel, orderSummary)).toBeEnabled();
    click(buttonByText(upgradeLabel, orderSummary));
    const confirmation = await screen.findByRole("dialog", {
      name: "Order summary",
    });
    click(buttonByText("Cancel", confirmation));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Order summary" }),
      ).not.toBeInTheDocument();
    });
  },
);

test("Configure member packages for a new workspace plan", async () => {
  mockInitialUsagePackPurchase();
  const { teamPlan } = await openUsagePackPlanSelection();
  const { configurePackagesHeading, memberUsage, orderSummary } =
    await openTeamMemberPackages(teamPlan);
  expect(configurePackagesHeading).toBeInTheDocument();
  expect(within(memberUsage).getByText("Alex Chen")).toBeInTheDocument();
  expect(within(memberUsage).getByText("alex@example.com")).toBeInTheDocument();
  expect(within(memberUsage).getByText("Sam Lee")).toBeInTheDocument();
  expect(within(memberUsage).getByText("sam@example.com")).toBeInTheDocument();
  expect(
    within(memberUsage).getByText("pending@example.com"),
  ).toBeInTheDocument();
  expect(within(memberUsage).getByText("Pending")).toBeInTheDocument();
  const alexUsage = within(memberUsage).getByRole("combobox", {
    name: "Usage for Alex Chen",
  });
  const samUsage = within(memberUsage).getByRole("combobox", {
    name: "Usage for Sam Lee",
  });
  const pendingUsage = within(memberUsage).getByRole("combobox", {
    name: "Usage for pending@example.com",
  });
  expect(alexUsage).toHaveTextContent("21,234 credits · 6% off");
  expect(samUsage).toHaveTextContent("21,234 credits · 6% off");
  expect(pendingUsage).toHaveTextContent("21,234 credits · 6% off");
  expect(alexUsage).not.toBeDisabled();
  expect(samUsage).not.toBeDisabled();
  expect(pendingUsage).not.toBeDisabled();
  expect(
    within(memberUsage).getByText(
      "Member packages are optional. Any overage uses pay-as-you-go credits.",
    ),
  ).toBeInTheDocument();
  expect(within(memberUsage).getByText("Team plan")).toBeInTheDocument();
  expect(within(memberUsage).getByText("$160")).toBeInTheDocument();
  expect(memberUsage).toHaveTextContent(
    "Monthly total63,702 credits · 3,702 bonus$220/month",
  );
  expect(buttonByText("Upgrade to Team", orderSummary)).not.toBeDisabled();

  click(alexUsage);
  expect(
    screen.queryByRole("option", { name: "Pay as you go" }),
  ).not.toBeInTheDocument();
  const alexFiftyDollarPack = screen.getByRole("option", {
    name: "$50 · 54,321 credits · 8% off",
  });
  click(alexFiftyDollarPack);
  expect(memberUsage).toHaveTextContent("$250/month");

  click(pendingUsage);
  click(
    await screen.findByRole("option", {
      name: "$100 · 109,999 credits · 9% off",
    }),
  );

  expect(memberUsage).toHaveTextContent(
    "Monthly total185,554 credits · 15,554 bonus$330/month",
  );
  expect(alexUsage).not.toBeDisabled();
  expect(samUsage).not.toBeDisabled();
  expect(pendingUsage).not.toBeDisabled();
  expect(buttonByText("Upgrade to Team", orderSummary)).not.toBeDisabled();
});

test("Manage member packages on an Atom-granted plan", async () => {
  const planName = "Pro";
  const status = activeProBillingStatus();
  context.mocks.data.org({
    id: "org_1",
    name: `Atom ${planName} Org`,
    role: "admin",
  });
  context.mocks.data.orgMembers({
    name: `Atom ${planName} Org`,
    role: "admin",
    members: [
      {
        userId: "user_1",
        email: "alex@example.com",
        firstName: "Alex",
        lastName: "Chen",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00Z",
      },
    ],
    pendingInvitations: [],
    membershipRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...status,
      subscriptionStatus: "atom_grant",
      hasSubscription: false,
      showUsagePack: true,
      cancelAtPeriodEnd: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: status.currentPeriodEnd,
      },
      canRestorePlan: false,
    });
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse());
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        message: "Usage pack subscription not found",
        code: "NOT_FOUND",
      },
    });
  });
  context.mocks.api(billingUsagePackMigrationContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        message: "Legacy subscription migration is not available",
        code: "NOT_FOUND",
      },
    });
  });

  await setupPage({
    context,
    path: "/?settings=billing",
    auth: {
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    },
  });

  await screen.findByText(`${planName} plan`);
  click(buttonByText("Compare all plans"));
  const plan = await screen.findByRole("article", {
    name: `${planName} plan`,
  });
  expect(buttonByText("Manage", plan)).toBeEnabled();
  click(buttonByText("Manage", plan));

  const memberUsage = await screen.findByRole("group", {
    name: "Member usage",
  });
  expect(
    within(memberUsage).getByRole("combobox", {
      name: "Usage for Alex Chen",
    }),
  ).toHaveTextContent("21,234 credits");
  const orderSummary = screen.getByRole("region", {
    name: "Order summary",
  });
  expect(buttonByText("Configure member packages", orderSummary)).toBeEnabled();
  expect(
    within(orderSummary).queryByText(`Upgrade to ${planName}`),
  ).not.toBeInTheDocument();
});

async function openLegacyTeamConversion(scheduled = false): Promise<void> {
  let migrationState: UsagePackMigrationStateResponse = {
    tier: "team",
    targetTier: scheduled ? "team" : null,
    status: scheduled ? "scheduled" : "eligible",
    migrationId: scheduled ? "3ea4b7cf-d71e-45dc-8273-8bc8b9712490" : null,
    effectiveAt: "2026-09-01T00:00:00.000Z",
    hostedInvoiceUrl: null,
    ...(scheduled
      ? {
          configuration: {
            tier: "team" as const,
            memberUsagePacks: [
              { memberId: "user_1", usagePackUsd: 20 },
              { memberId: "invitation_1", usagePackUsd: 50 },
            ],
            recurringAmountCents: 22_950,
            currency: "usd",
          },
        }
      : {}),
  };
  context.mocks.data.org({
    id: "org_1",
    name: "Legacy Team Org",
    role: "admin",
  });
  context.mocks.data.orgMembers({
    name: "Legacy Team Org",
    role: "admin",
    members: [
      {
        userId: "user_1",
        email: "alex@example.com",
        firstName: "Alex",
        lastName: "Chen",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00Z",
      },
    ],
    pendingInvitations: [
      {
        id: "invitation_1",
        email: "pending@example.com",
        role: "member",
        createdAt: "2026-01-03T00:00:00Z",
      },
    ],
    membershipRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeTeamBillingStatus());
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse());
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        message: "Usage pack subscription not found",
        code: "NOT_FOUND",
      },
    });
  });
  context.mocks.api(billingUsagePackMigrationContract.get, ({ respond }) => {
    return respond(200, migrationState);
  });
  context.mocks.api(
    billingUsagePackMigrationContract.preview,
    ({ body, respond }) => {
      expect(body.targetTier).toBe("team");
      expect(body.memberUsagePacks).toStrictEqual([
        { memberId: "user_1", usagePackUsd: 20 },
        { memberId: "invitation_1", usagePackUsd: 50 },
      ]);
      migrationState = {
        ...migrationState,
        status: "previewed",
        targetTier: "team",
        migrationId: "3ea4b7cf-d71e-45dc-8273-8bc8b9712490",
      };
      return respond(200, {
        migrationId: "3ea4b7cf-d71e-45dc-8273-8bc8b9712490",
        tier: "team",
        targetTier: "team",
        currentRecurringAmountCents: 20_000,
        nextRecurringAmountCents: 22_950,
        recurringDifferenceCents: 2950,
        currency: "usd",
        purchasedCredits: 70_000,
        bonusCredits: 5555,
        totalCredits: 75_555,
        effectiveAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-03-16T00:30:00Z",
      });
    },
  );
  context.mocks.api(
    billingUsagePackMigrationContract.confirm,
    ({ body, params, respond }) => {
      expect(body).toStrictEqual({});
      expect(params.migrationId).toBe("3ea4b7cf-d71e-45dc-8273-8bc8b9712490");
      migrationState = {
        ...migrationState,
        status: "scheduled",
        configuration: {
          tier: "team",
          memberUsagePacks: [
            { memberId: "user_1", usagePackUsd: 20 },
            { memberId: "invitation_1", usagePackUsd: 50 },
          ],
          recurringAmountCents: 22_950,
          currency: "usd",
        },
      };
      return respond(200, {
        status: "scheduled",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        hostedInvoiceUrl: null,
      });
    },
  );
  context.mocks.api(
    billingUsagePackMigrationContract.previewRevision,
    ({ body, params, respond }) => {
      expect(params.migrationId).toBe("3ea4b7cf-d71e-45dc-8273-8bc8b9712490");
      expect(body).toStrictEqual({
        targetTier: "pro",
        memberUsagePacks: [
          { memberId: "user_1", usagePackUsd: 20 },
          { memberId: "invitation_1", usagePackUsd: 50 },
        ],
      });
      return respond(200, {
        migrationId: "3ea4b7cf-d71e-45dc-8273-8bc8b9712490",
        tier: "team",
        targetTier: "pro",
        currentRecurringAmountCents: 22_950,
        nextRecurringAmountCents: 7000,
        recurringDifferenceCents: -15_950,
        currency: "usd",
        purchasedCredits: 70_000,
        bonusCredits: 5555,
        totalCredits: 75_555,
        effectiveAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-03-16T00:30:00Z",
        previewToken: "signed-revision-preview",
      });
    },
  );
  context.mocks.api(
    billingUsagePackMigrationContract.confirmRevision,
    ({ body, params, respond }) => {
      expect(params.migrationId).toBe("3ea4b7cf-d71e-45dc-8273-8bc8b9712490");
      expect(body).toStrictEqual({
        targetTier: "pro",
        memberUsagePacks: [
          { memberId: "user_1", usagePackUsd: 20 },
          { memberId: "invitation_1", usagePackUsd: 50 },
        ],
        previewToken: "signed-revision-preview",
      });
      migrationState = {
        ...migrationState,
        targetTier: "pro",
        status: "scheduled",
        configuration: {
          tier: "pro",
          memberUsagePacks: [
            { memberId: "user_1", usagePackUsd: 20 },
            { memberId: "invitation_1", usagePackUsd: 50 },
          ],
          recurringAmountCents: 7000,
          currency: "usd",
        },
      };
      return respond(200, {
        status: "scheduled",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        hostedInvoiceUrl: null,
      });
    },
  );

  await setupPage({
    context,
    path: "/?settings=billing",
    auth: {
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    },
  });

  await screen.findByText("Team plan");
}

async function configureLegacyTeamConversion() {
  await openLegacyTeamConversion();
  click(buttonByText("Compare all plans"));
  const choosePlanDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  click(
    buttonByText(
      "Convert plan",
      within(choosePlanDialog).getByRole("article", { name: "Team plan" }),
    ),
  );

  const configurePackagesDialog = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  expect(
    within(configurePackagesDialog).getByText("Step 2 of 3"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Choose a plan" }),
  ).not.toBeInTheDocument();
  const memberUsage = screen.getByRole("group", { name: "Member usage" });
  expect(within(memberUsage).getByText("Alex Chen")).toBeInTheDocument();
  expect(
    within(memberUsage).getByText("pending@example.com"),
  ).toBeInTheDocument();
  await selectMemberUsagePack(
    memberUsage,
    "Alex Chen",
    "$20 · 21,234 credits · 6% off",
  );
  const pendingUsage = within(memberUsage).getByRole("combobox", {
    name: "Usage for pending@example.com",
  });
  click(pendingUsage);
  click(
    await screen.findByRole("option", {
      name: "$50 · 54,321 credits · 8% off",
    }),
  );

  const orderSummary = screen.getByRole("region", {
    name: "Order summary",
  });
  return orderSummary;
}

test("Compare legacy Team packages and review conversion totals", async () => {
  const orderSummary = await configureLegacyTeamConversion();
  expect(
    within(orderSummary).queryByRole("table", {
      name: "Current and new subscription comparison",
    }),
  ).not.toBeInTheDocument();
  const orderComparison = within(await hoverSubscriptionComparison()).getByRole(
    "table",
    {
      name: "Current and new subscription comparison",
    },
  );
  expect(
    within(orderComparison).getByRole("row", {
      name: /Plan Team Legacy Team/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(orderComparison).getByRole("row", {
      name: /Member packages \$0 \$70/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(orderComparison).getByRole("row", {
      name: /Concurrent slots 10 10/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(orderComparison).getByRole("row", {
      name: /Purchased credits 120,000 70,000/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(orderComparison).getByRole("row", {
      name: /Bonus credits 0 5,555/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(orderComparison).getByRole("row", {
      name: /Monthly total \$200\/month \$230\/month/u,
    }),
  ).toBeInTheDocument();
  const conversionNotice = within(orderSummary).getByRole("status", {
    name: "Convert plan",
  });
  expect(conversionNotice).toBeVisible();
  expect(conversionNotice).toHaveTextContent("Scheduled for Sep 1, 2026");

  const reviewConversionButton = buttonByText(
    "Review conversion",
    orderSummary,
  );
  expect(conversionNotice.parentElement).toContainElement(
    reviewConversionButton,
  );
  click(reviewConversionButton);
  const reviewDialog = await screen.findByRole("dialog", {
    name: "Review plan conversion",
  });
  expect(within(reviewDialog).getByText("Step 3 of 3")).toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Configure member packages" }),
  ).not.toBeInTheDocument();
  expect(queryButtonByText("Review conversion")).toBeUndefined();
  expect(
    within(reviewDialog).queryByRole("table", {
      name: "Current and new subscription comparison",
    }),
  ).not.toBeInTheDocument();
  expect(within(reviewDialog).getByText("Every month")).toBeInTheDocument();
  const conversionPlanRow = within(reviewDialog)
    .getByText("Team plan")
    .closest("div");
  expect(conversionPlanRow).toHaveTextContent("10 concurrent runs");
  expect(conversionPlanRow).toHaveTextContent("$160");
  expect(
    within(reviewDialog).getByText("Member packages").closest("div"),
  ).toHaveTextContent("$70");
  const conversionCreditsRow = within(reviewDialog)
    .getByText("Credits")
    .closest("div");
  expect(conversionCreditsRow).toHaveTextContent("5,555 bonus included");
  expect(conversionCreditsRow).toHaveTextContent("75,555");
  expect(
    within(reviewDialog).getByText("Monthly total").closest("div"),
  ).toHaveTextContent("$229.50/month");
  const reviewConversionNotice = within(reviewDialog).getByRole("status", {
    name: "Convert plan",
  });
  expect(reviewConversionNotice).toHaveTextContent("Scheduled for Sep 1, 2026");
  expect(reviewConversionNotice.parentElement).toContainElement(
    buttonByText("Confirm", reviewDialog),
  );
});

test("Confirm a legacy Team conversion", async () => {
  const orderSummary = await configureLegacyTeamConversion();
  click(buttonByText("Review conversion", orderSummary));
  const reviewDialog = await screen.findByRole("dialog", {
    name: "Review plan conversion",
  });
  click(buttonByText("Confirm", reviewDialog));
  await expect(
    screen.findByText("Switches to Team on Sep 1, 2026"),
  ).resolves.toBeVisible();
  await expect(
    screen.findByText("Subscription change confirmed."),
  ).resolves.toBeVisible();
  expect(
    screen.queryByText(
      "Conversion scheduled for Sep 1, 2026. Your current plan and entitlements remain active until then.",
    ),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Legacy")).toBeInTheDocument();
});

test("Review and revise an already scheduled legacy Team conversion", async () => {
  await openLegacyTeamConversion(true);
  await screen.findByText("Switches to Team on Sep 1, 2026");
  click(buttonByText("Downgrade"));
  const unchangedChoosePlanDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  const teamPlan = within(unchangedChoosePlanDialog).getByRole("article", {
    name: "Team plan",
  });
  click(buttonByText("Manage", teamPlan));
  const unchangedPackagesDialog = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  expect(
    within(unchangedPackagesDialog).getByText("Step 2 of 3"),
  ).toBeInTheDocument();
  expect(queryButtonByText("Current plan")).toBeUndefined();
  expect(queryButtonByText("Review conversion")).toBeUndefined();

  click(within(unchangedPackagesDialog).getByLabelText("Back"));
  const revisionChoosePlanDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  const proPlan = within(revisionChoosePlanDialog).getByRole("article", {
    name: "Pro plan",
  });
  click(buttonByText("Downgrade", proPlan));
  const revisionPackagesDialog = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  expect(
    within(revisionPackagesDialog).getByText("Step 2 of 3"),
  ).toBeInTheDocument();
  const reviewRevisionButton = buttonByText(
    "Review conversion",
    revisionPackagesDialog,
  );
  click(reviewRevisionButton);
  const revisionDialog = await screen.findByRole("dialog", {
    name: "Review plan conversion",
  });
  expect(within(revisionDialog).getByText("Step 3 of 3")).toBeInTheDocument();
  expect(queryButtonByText("Review conversion")).toBeUndefined();
  click(buttonByText("Confirm", revisionDialog));
  await expect(
    screen.findByText("Switches to Pro on Sep 1, 2026"),
  ).resolves.toBeVisible();
});

test("Hide retained package records for people who left the workspace", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Managed Usage Pack Org",
    role: "admin",
  });
  context.mocks.data.orgMembers({
    name: "Managed Usage Pack Org",
    role: "admin",
    members: [
      {
        userId: "user_1",
        email: "alex@example.com",
        firstName: "Alex",
        lastName: "Chen",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00Z",
      },
    ],
    pendingInvitations: [],
    membershipRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeProBillingStatus());
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse());
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      tier: "pro",
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      allocations: [
        {
          id: "b5235934-83df-4f16-bf41-f46890db7d40",
          memberId: "user_1",
          usagePackUsd: 20,
          currentPeriodEnd: "2026-04-01T00:00:00Z",
          pendingChange: null,
        },
        {
          id: "f2264b0e-2e55-4098-a9d4-7e2d7ff017d5",
          memberId: "removed_user",
          usagePackUsd: 50,
          currentPeriodEnd: "2026-04-01T00:00:00Z",
          pendingChange: {
            id: "18b51e88-6804-46c8-9b2f-3b130f6ca69c",
            kind: "removal",
            status: "scheduled",
            targetUsagePackUsd: null,
            effectiveAt: "2026-04-01T00:00:00Z",
          },
        },
      ],
    });
  });

  await setupPage({
    context,
    path: "/?settings=billing",
    auth: {
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    },
  });

  await screen.findByText("Pro plan");
  click(buttonByText("Compare all plans"));
  const proPlan = await screen.findByRole("article", { name: "Pro plan" });
  click(buttonByText("Manage", proPlan));

  const memberUsage = await screen.findByRole("group", {
    name: "Member usage",
  });
  expect(within(memberUsage).getByText("Alex Chen")).toBeInTheDocument();
  expect(within(memberUsage).queryByText("removed_user")).toBeNull();
  expect(
    within(memberUsage).queryByRole("combobox", {
      name: "Usage for removed_user",
    }),
  ).toBeNull();
  const orderSummary = screen.getByRole("region", {
    name: "Order summary",
  });
  expect(queryAllByRoleFast("button", orderSummary)).toHaveLength(0);

  const packageSelect = within(memberUsage).getByRole("combobox", {
    name: "Usage for Alex Chen",
  });
  click(packageSelect);
  click(
    await screen.findByRole("option", {
      name: "$50 · 54,321 credits · 8% off",
    }),
  );
  expect(buttonByText("Confirm", orderSummary)).not.toBeDisabled();
});

test.each<0 | 50>([50])(
  "Restore a member package scheduled to downgrade to $%s",
  async (targetUsagePackUsd) => {
    let restored = false;
    context.mocks.data.org({
      id: "org_1",
      name: "Scheduled Usage Pack Org",
      role: "admin",
    });
    context.mocks.data.orgMembers({
      name: "Scheduled Usage Pack Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
      ],
      pendingInvitations: [],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        supportsFreeMembers: true,
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        allocations: [
          {
            id: "b5235934-83df-4f16-bf41-f46890db7d40",
            memberId: "user_1",
            usagePackUsd: 100,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange: restored
              ? null
              : {
                  id: "ad3bd64c-7237-436d-a221-61b14ed719e7",
                  kind: targetUsagePackUsd === 0 ? "removal" : "downgrade",
                  status: "scheduled",
                  targetUsagePackUsd: targetUsagePackUsd || null,
                  effectiveAt: "2026-04-01T00:00:00Z",
                },
          },
        ],
      });
    });
    context.mocks.api(
      billingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 100 }],
          ...inAppBillingPreviewFields(),
        });
        return respond(200, {
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
          sourceTier: "pro",
          targetTier: "pro",
          immediateAmountCents: 0,
          nextRecurringAmountCents: 10_000,
          currency: "usd",
          effectiveAt: "2026-03-16T00:00:00Z",
          prorationDate: "2026-03-16T00:00:00Z",
          expiresAt: "2026-03-16T00:15:00Z",
        });
      },
    );
    context.mocks.api(
      billingUsagePackManagementContract.confirmSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
        });
        restored = true;
        return respond(200, {
          status: "completed",
          effectiveAt: "2026-03-16T00:00:00Z",
          hostedInvoiceUrl: null,
        });
      },
    );

    await setupPage({
      context,
      path: "/?settings=billing",
      auth: {
        user: {
          id: "user_1",
          fullName: "Alex Chen",
          email: "alex@example.com",
        },
      },
    });

    await screen.findByText("Pro plan");
    click(buttonByText("Compare all plans"));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    click(buttonByText("Manage", proPlan));
    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    const packageSelect = screen.getByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    expect(packageSelect).toHaveTextContent(
      targetUsagePackUsd === 0 ? "No package" : "54,321 credits · 8% off",
    );
    const notice = `Downgrades to ${targetUsagePackUsd === 0 ? "No package" : "$50"} on Apr 1, 2026.`;
    const downgradeNotice = screen.getByText(notice);
    expect(downgradeNotice).toBeVisible();
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    expect(screen.queryByText("Change is processing")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("table", {
        name: "Current and new subscription comparison",
      }),
    ).not.toBeInTheDocument();
    const scheduledDowngrade = within(orderSummary).getByRole("status", {
      name: "Downgrade scheduled",
    });
    expect(scheduledDowngrade).toBeVisible();
    expect(scheduledDowngrade).toHaveTextContent(
      "Lower package starts Apr 1, 2026 · Existing credits remain available until they expire",
    );
    expect(queryAllByRoleFast("button", orderSummary)).toHaveLength(0);

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$100 · 109,999 credits · 9% off",
      }),
    );
    const comparisonTooltip = await hoverSubscriptionComparison();
    const comparison = within(comparisonTooltip).getByRole("table", {
      name: "Current and new subscription comparison",
    });
    expect(
      within(comparison).getByRole("row", {
        name:
          targetUsagePackUsd === 0
            ? /Member packages \$0 \$100/u
            : /Member packages \$50 \$100/u,
      }),
    ).toBeInTheDocument();
    expect(buttonByText("Restore", orderSummary)).not.toBeDisabled();

    click(buttonByText("Restore", orderSummary));
    const confirmationDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    click(buttonByText("Confirm", confirmationDialog));
    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    await expect(
      screen.findByText("Subscription change confirmed."),
    ).resolves.toBeVisible();

    await expect(
      screen.findByRole("combobox", { name: "Usage for Alex Chen" }),
    ).resolves.toHaveTextContent("109,999 credits · 9% off");
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast(
        "button",
        screen.getByRole("region", { name: "Order summary" }),
      ),
    ).toHaveLength(0);
  },
);

test.each<{
  readonly targetUsagePackUsd: 0 | 100;
  readonly alreadyScheduled: boolean;
}>([{ targetUsagePackUsd: 100, alreadyScheduled: true }])(
  "Validate a member package downgrade to $targetUsagePackUsd (replacing: $alreadyScheduled)",
  async ({ targetUsagePackUsd, alreadyScheduled }) => {
    let confirmed = false;
    context.mocks.data.org({
      id: "org_1",
      name: "Replace Scheduled Usage Pack Org",
      role: "admin",
    });
    context.mocks.data.orgMembers({
      name: "Replace Scheduled Usage Pack Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
      ],
      pendingInvitations: [],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        supportsFreeMembers: true,
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        allocations: [
          {
            id: "b5235934-83df-4f16-bf41-f46890db7d40",
            memberId: "user_1",
            usagePackUsd: 200,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange:
              confirmed || alreadyScheduled
                ? {
                    id: "ad3bd64c-7237-436d-a221-61b14ed719e7",
                    kind:
                      confirmed && targetUsagePackUsd === 0
                        ? "removal"
                        : "downgrade",
                    status: "scheduled",
                    targetUsagePackUsd: confirmed
                      ? targetUsagePackUsd || null
                      : 50,
                    effectiveAt: "2026-04-01T00:00:00Z",
                  }
                : null,
          },
        ],
      });
    });
    context.mocks.api(
      billingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: "user_1", usagePackUsd: targetUsagePackUsd },
          ],
          ...inAppBillingPreviewFields(),
        });
        return respond(200, {
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
          sourceTier: "pro",
          targetTier: "pro",
          immediateAmountCents: 0,
          nextRecurringAmountCents: targetUsagePackUsd * 100,
          currency: "usd",
          effectiveAt: "2026-04-01T00:00:00Z",
          prorationDate: "2026-03-16T00:00:00Z",
          expiresAt: "2026-03-16T00:15:00Z",
        });
      },
    );

    context.mocks.api(
      billingUsagePackManagementContract.confirmSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
        });
        confirmed = true;
        return respond(200, {
          status: "scheduled",
          effectiveAt: "2026-04-01T00:00:00Z",
          hostedInvoiceUrl: null,
        });
      },
    );

    await setupPage({
      context,
      path: "/?settings=billing",
      auth: {
        user: {
          id: "user_1",
          fullName: "Alex Chen",
          email: "alex@example.com",
        },
      },
    });

    await screen.findByText("Pro plan");
    click(buttonByText("Compare all plans"));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    click(buttonByText("Manage", proPlan));
    const packageSelect = await screen.findByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$20 · 21,234 credits · 6% off",
      }),
    );
    expect(screen.getByText("Downgrades to $20 on Apr 1, 2026.")).toBeVisible();
    expect(buttonByText("Confirm", orderSummary)).not.toBeDisabled();

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name:
          targetUsagePackUsd === 0
            ? "No package"
            : "$100 · 109,999 credits · 9% off",
      }),
    );
    const notice = `Downgrades to ${targetUsagePackUsd === 0 ? "No package" : "$100"} on Apr 1, 2026.`;
    expect(screen.getByText(notice)).toBeVisible();
    expect(
      screen.queryByText("Downgrades to $50 on Apr 1, 2026."),
    ).not.toBeInTheDocument();
    const confirmButton = buttonByText("Confirm", orderSummary);
    expect(confirmButton).toHaveProperty("disabled", targetUsagePackUsd === 0);
    expect(
      Boolean(
        within(orderSummary).queryByText(
          "Select a paid package for at least one member to continue.",
        ),
      ),
    ).toBe(targetUsagePackUsd === 0);
    if (targetUsagePackUsd === 0) {
      return;
    }

    click(confirmButton);
    const review = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    click(buttonByText("Confirm", review));
    await expect(
      screen.findByText("Subscription change confirmed."),
    ).resolves.toBeVisible();
    expect(screen.getByText(notice)).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Downgrade scheduled" }),
    ).toHaveTextContent("Lower package starts Apr 1, 2026");
  },
);

async function openTeamToProDowngrade() {
  let billingStatus: BillingStatusResponse = activeTeamBillingStatus();
  context.mocks.data.org({
    id: "org_1",
    name: "Usage Pack Downgrade Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus);
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse());
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      tier: "team",
      supportsFreeMembers: true,
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      allocations: [
        {
          id: "3a9138ff-bb8c-4476-95c2-64775cc50ceb",
          memberId: "user_1",
          usagePackUsd: 20,
          currentPeriodEnd: "2026-04-01T00:00:00Z",
          pendingChange: null,
        },
      ],
    });
  });
  context.mocks.api(
    billingUsagePackManagementContract.previewSubscriptionChange,
    ({ body, respond }) => {
      expect(body).toStrictEqual({
        targetTier: "pro",
        memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 20 }],
        ...inAppBillingPreviewFields(),
      });
      return respond(200, {
        changeId: "667d65ac-85df-4743-b421-b9d18a3ad89b",
        sourceTier: "team",
        targetTier: "pro",
        immediateAmountCents: 0,
        nextRecurringAmountCents: 2000,
        currency: "usd",
        effectiveAt: "2026-04-01T00:00:00Z",
        prorationDate: "2026-03-16T00:00:00Z",
        expiresAt: "2026-03-16T00:15:00Z",
      });
    },
  );
  context.mocks.api(
    billingUsagePackManagementContract.confirmSubscriptionChange,
    ({ body, respond }) => {
      expect(body).toStrictEqual({
        changeId: "667d65ac-85df-4743-b421-b9d18a3ad89b",
      });
      billingStatus = {
        ...billingStatus,
        canRestorePlan: true,
        scheduledChange: {
          type: "downgrade",
          targetTier: "pro",
          effectiveDate: "2026-04-01T00:00:00Z",
        },
      };
      return respond(200, {
        status: "scheduled",
        effectiveAt: "2026-04-01T00:00:00Z",
        hostedInvoiceUrl: null,
      });
    },
  );

  await setupPage({
    context,
    path: "/?settings=billing",
    auth: {
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    },
  });

  await waitFor(() => {
    expect(screen.getByText("Team plan")).toBeInTheDocument();
  });
  click(buttonByText("Compare all plans"));
  const proPlan = await screen.findByRole("article", { name: "Pro plan" });
  click(buttonByText("Downgrade", proPlan));

  await screen.findByRole("heading", {
    name: "Configure member packages",
  });
  const memberUsage = screen.getByRole("group", {
    name: "Member usage",
  });
  const orderSummary = screen.getByRole("region", {
    name: "Order summary",
  });
  const confirmDowngradeButton = buttonByText("Confirm", orderSummary);
  expect(confirmDowngradeButton).toBeEnabled();
  return { memberUsage, orderSummary, confirmDowngradeButton };
}

test("Require a paid member package before previewing a Team-to-Pro downgrade", async () => {
  const { memberUsage, orderSummary, confirmDowngradeButton } =
    await openTeamToProDowngrade();
  await selectMemberUsagePack(memberUsage, "Alex Chen", "No package");
  expect(confirmDowngradeButton).toBeDisabled();
  expect(
    within(orderSummary).getByText(
      "Select a paid package for at least one member to continue.",
    ),
  ).toBeVisible();

  await selectMemberUsagePack(
    memberUsage,
    "Alex Chen",
    "$20 · 21,234 credits · 6% off",
  );
  expect(confirmDowngradeButton).toBeEnabled();
  expect(
    within(orderSummary).queryByText(
      "Select a paid package for at least one member to continue.",
    ),
  ).not.toBeInTheDocument();
  click(confirmDowngradeButton);
  await screen.findByRole("dialog", { name: "Review package change" });
});

test("Review and confirm a scheduled Team-to-Pro downgrade", async () => {
  const { orderSummary, confirmDowngradeButton } =
    await openTeamToProDowngrade();
  const comparison = within(await hoverSubscriptionComparison()).getByRole(
    "table",
    {
      name: "Current and new subscription comparison",
    },
  );
  expect(
    within(comparison).getByRole("row", {
      name: /Monthly total \$180\/month \$20\/month/u,
    }),
  ).toBeInTheDocument();
  const downgradeNotice = within(orderSummary).getByRole("status", {
    name: "Downgrade",
  });
  expect(downgradeNotice).toBeVisible();
  expect(downgradeNotice).toHaveTextContent(
    "Lower package starts Apr 1, 2026 · Existing credits remain available until they expire",
  );
  expect(
    within(orderSummary).queryByText("Scheduled for Apr 1, 2026"),
  ).not.toBeInTheDocument();
  expect(downgradeNotice.parentElement).toContainElement(
    confirmDowngradeButton,
  );
  click(confirmDowngradeButton);
  const confirmationDialog = await screen.findByRole("dialog", {
    name: "Review package change",
  });
  expect(
    within(confirmationDialog).queryByText("Due now"),
  ).not.toBeInTheDocument();
  expect(
    within(confirmationDialog).queryByText("$0.00"),
  ).not.toBeInTheDocument();
  expect(
    within(confirmationDialog).getByText("Monthly total").closest("div"),
  ).toHaveTextContent("$20/month");
  const locationBeforeConfirmation = window.location.href;
  click(buttonByText("Confirm", confirmationDialog));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Configure member packages" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Subscription change confirmed.")).toBeVisible();
  });
  expect(window.location.href).toBe(locationBeforeConfirmation);
});

test("Replace a Team cancellation with a Pro downgrade", async () => {
  let requestedTargetTier: string | null = null;
  let billingStatus: BillingStatusResponse = {
    ...activeTeamBillingStatus(),
    cancelAtPeriodEnd: true,
    canRestorePlan: true,
    scheduledChange: {
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: "2026-05-01T00:00:00Z",
    },
  };
  context.mocks.data.org({
    id: "org_1",
    name: "Managed Team Cancel Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus);
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse());
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      tier: "team",
      currentPeriodEnd: "2026-05-01T00:00:00Z",
      allocations: [
        {
          id: "3a9138ff-bb8c-4476-95c2-64775cc50ceb",
          memberId: "user_1",
          usagePackUsd: 20,
          currentPeriodEnd: "2026-05-01T00:00:00Z",
          pendingChange: null,
        },
      ],
    });
  });
  context.mocks.api(
    billingUsagePackManagementContract.previewSubscriptionChange,
    () => {
      throw new Error("Package preview must not replace a Plan cancellation");
    },
  );
  context.mocks.api(billingDowngradeContract.create, ({ body, respond }) => {
    requestedTargetTier = body.targetTier;
    billingStatus = {
      ...billingStatus,
      cancelAtPeriodEnd: false,
      scheduledChange: {
        type: "downgrade",
        targetTier: "pro",
        effectiveDate: "2026-05-01T00:00:00Z",
      },
    };
    return respond(200, {
      success: true,
      effectiveDate: "2026-05-01T00:00:00Z",
    });
  });

  await setupPage({
    context,
    path: "/?settings=billing",
    auth: {
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    },
  });

  await waitFor(() => {
    expect(screen.getByText("Restore plan")).toBeInTheDocument();
  });
  click(buttonByText("Compare all plans"));
  const proPlan = await screen.findByRole("article", { name: "Pro plan" });
  click(buttonByText("Downgrade", proPlan));

  const downgradeDialog = await screen.findByRole("dialog", {
    name: "Downgrade plan",
  });
  expect(
    within(downgradeDialog).getByText("Downgrade to Pro?"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Configure member packages" }),
  ).not.toBeInTheDocument();
  click(buttonByText("Downgrade to Pro", downgradeDialog));

  await waitFor(() => {
    expect(requestedTargetTier).toBe("pro");
  });
});

test("Manage paid concurrency while the Team plan is ending", async () => {
  let previewedQuantity: number | null = null;
  let restoredSubscriptionId: string | null = null;
  let billingStatus: BillingStatusResponse = {
    ...activeTeamBillingStatus(),
    cancelAtPeriodEnd: true,
    scheduledChange: {
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: "2026-06-01T00:00:00Z",
    },
    concurrencyLimit: 15,
    concurrencySubscriptions: [
      {
        id: "sub_concurrency_ending_plan",
        quantity: 5,
        currentPeriodEnd: "2026-06-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        canReduce: true,
        canChangeInApp: true,
      },
    ],
  };
  context.mocks.data.org({
    id: "org_1",
    name: "Ending Team Concurrency Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus);
  });
  context.mocks.api(
    billingConcurrencySubscriptionContract.previewChange,
    ({ body, respond }) => {
      previewedQuantity = body.quantity;
      return respond(200, {
        currentQuantity: 5,
        targetQuantity: body.quantity,
        immediateAmountCents: 10_000,
        nextRecurringAmountCents: 0,
        currency: "usd",
      });
    },
  );
  context.mocks.api(
    billingConcurrencySubscriptionContract.restore,
    ({ params, respond }) => {
      restoredSubscriptionId = params.subscriptionId;
      billingStatus = {
        ...billingStatus,
        concurrencySubscriptions: billingStatus.concurrencySubscriptions.map(
          (subscription) => {
            return {
              ...subscription,
              scheduledQuantity: null,
              scheduledChangeAt: null,
            };
          },
        ),
      };
      return respond(200, { success: true });
    },
  );
  await openBillingTab();

  expect(screen.getByText("Active until Jun 1, 2026")).toBeInTheDocument();
  click(buttonByText("Change"));
  const changeDialog = await screen.findByRole("dialog", {
    name: "Change concurrency",
  });
  const quantityInput = within(changeDialog).getByRole("textbox", {
    name: "Slots",
  });
  expect(
    within(changeDialog).getByLabelText(
      "Decrease additional concurrency quantity",
    ),
  ).toBeDisabled();
  expect(
    within(changeDialog).queryByText("Cancel entire subscription"),
  ).not.toBeInTheDocument();
  click(
    within(changeDialog).getByLabelText(
      "Increase additional concurrency quantity",
    ),
  );
  expect(quantityInput).toHaveValue("6");
  click(buttonByText("Review change", changeDialog));
  await waitFor(() => {
    expect(previewedQuantity).toBe(6);
  });
  click(buttonByText("Cancel", changeDialog));

  const restoreTeamPlanButton = await waitFor(() => {
    return buttonByText("Restore Team plan");
  });
  click(restoreTeamPlanButton);
  const restorePlanDialog = await screen.findByRole("dialog", {
    name: "Restore Team plan?",
  });
  expect(restorePlanDialog).toHaveTextContent(
    "This will undo the scheduled cancellation for your Team plan. It will renew on Jun 1, 2026.",
  );
  expect(restorePlanDialog).toHaveTextContent(
    "Your paid concurrency (5 slots) will remain active and continue renewing with your plan.",
  );
  click(buttonByText("Cancel", restorePlanDialog));
  expect(buttonByText("Change")).toBeEnabled();

  billingStatus = {
    ...billingStatus,
    concurrencySubscriptions: billingStatus.concurrencySubscriptions.map(
      (subscription) => {
        return {
          ...subscription,
          scheduledQuantity: 3,
          scheduledChangeAt: "2026-06-01T00:00:00Z",
        };
      },
    ),
  };
  context.mocks.ably.trigger("billing:changed");
  await waitFor(() => {
    expect(
      screen.getByText("Changes to 3 slots on Jun 1, 2026"),
    ).toBeInTheDocument();
    expect(buttonByText("Restore concurrency")).toBeEnabled();
  });

  click(buttonByText("Restore concurrency"));
  const restoreConcurrencyDialog = await screen.findByRole("dialog", {
    name: "Restore concurrency subscription?",
  });
  expect(restoredSubscriptionId).toBeNull();
  expect(restoreConcurrencyDialog).toHaveTextContent(
    "This restores renewal for your paid concurrency (5 slots). Your plan will not change.",
  );
  click(buttonByText("Restore concurrency", restoreConcurrencyDialog));

  await waitFor(() => {
    expect(restoredSubscriptionId).toBe("sub_concurrency_ending_plan");
    expect(
      screen.getByText("Concurrency subscription restored."),
    ).toBeInTheDocument();
    expect(buttonByText("Restore Team plan")).toBeEnabled();
    expect(screen.getByText("Active until Jun 1, 2026")).toBeInTheDocument();
  });
});

test("Buy paid concurrency with an in-app review", async () => {
  let requestedQuantity: number | null = null;
  let previewedQuantity: number | null = null;

  context.mocks.data.org({
    id: "org_1",
    name: "Team Concurrency Purchase Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...activeTeamBillingStatus(),
      concurrencyUnitAmountCents: 4200,
      concurrencyPurchaseReviewAvailable: true,
    });
  });
  context.mocks.api(
    billingConcurrencyCheckoutContract.preview,
    ({ body, respond }) => {
      previewedQuantity = body.quantity;
      return respond(200, {
        currentQuantity: 0,
        targetQuantity: body.quantity,
        immediateAmountCents: 12_000,
        nextRecurringAmountCents: 36_000,
        currency: "usd",
      });
    },
  );
  context.mocks.api(
    billingConcurrencyCheckoutContract.create,
    ({ body, respond }) => {
      requestedQuantity = body.quantity;
      return respond(200, { url: body.successUrl });
    },
  );

  await openBillingTab();

  click(buttonByText("Buy concurrency"));
  const purchaseDialog = await screen.findByRole("dialog", {
    name: "Buy concurrency",
  });
  expect(within(purchaseDialog).getByText("Monthly total")).toBeInTheDocument();
  const quantityInput = within(purchaseDialog).getByRole("textbox", {
    name: "Slots",
  });
  expect(quantityInput).toHaveValue("1");
  fireEvent.change(quantityInput, { target: { value: "" } });
  expect(quantityInput).toHaveValue("");
  expect(buttonByText("Review purchase", purchaseDialog)).toBeDisabled();
  fireEvent.change(quantityInput, { target: { value: "5" } });

  await waitFor(() => {
    expect(within(purchaseDialog).getByText("$210/month")).toBeInTheDocument();
  });

  click(buttonByText("Review purchase", purchaseDialog));

  await screen.findByText("$120.00");
  const reviewDialog = screen.getByRole("dialog", {
    name: "Review concurrency purchase",
  });
  await waitFor(() => {
    expect(previewedQuantity).toBe(5);
    expect(within(reviewDialog).getByText("Due today")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("$120.00")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("5")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("$360.00/month")).toBeInTheDocument();
  });
  click(buttonByText("Pay and add slots", reviewDialog));

  await waitFor(() => {
    expect(requestedQuantity).toBe(5);
    expect(
      screen.getByText(
        "Concurrency added. Your new slots will become available after Stripe confirms the subscription.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Review concurrency purchase" }),
    ).toBeNull();
  });
});

test("Confirm a plan cancellation in hosted checkout when required", async () => {
  const locationAssign = context.mocks.browser.locationAssign();

  context.mocks.data.org({
    id: "org_1",
    name: "Payment Confirm Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeProBillingStatus());
  });
  let downgradeReturnUrl: string | undefined;
  context.mocks.api(billingDowngradeContract.create, ({ body, respond }) => {
    downgradeReturnUrl = body.returnUrl;
    return respond(200, {
      status: "payment_method_required",
      checkoutUrl: "https://checkout.stripe.com/confirm-cancel-subscription",
    });
  });

  await openBillingTab();

  await waitFor(() => {
    expect(screen.getByText("Pro plan")).toBeInTheDocument();
    expect(screen.getByText("Downgrade")).toBeInTheDocument();
  });

  click(screen.getByText("Downgrade"));
  const downgradeDialog = await screen.findByRole("dialog", {
    name: "Downgrade plan",
  });
  click(buttonByText("Cancel subscription", downgradeDialog));

  await waitFor(() => {
    expect(locationAssign.calls).toStrictEqual([
      "https://checkout.stripe.com/confirm-cancel-subscription",
    ]);
  });
  expect(
    new URL(downgradeReturnUrl ?? "").searchParams.get("billing_pending"),
  ).toBe("downgrade-limited-free-1");
  expect(screen.queryByText("Downgrade plan")).not.toBeInTheDocument();
});

test("Confirm a scheduled cancellation after returning from hosted payment", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Cancellation Return Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...activeProBillingStatus(),
      cancelAtPeriodEnd: true,
      canRestorePlan: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: "2026-04-01T00:00:00Z",
      },
    });
  });

  await openBillingTab(
    "/?settings=billing&billing_pending=downgrade-limited-free-1",
  );

  await expect(
    screen.findByText(
      /^Cancellation scheduled\. Your current plan stays active until/u,
    ),
  ).resolves.toBeInTheDocument();
  const searchParams = new URLSearchParams(window.location.search);
  expect(searchParams.get("settings")).toBe("billing");
  expect(searchParams.has("billing_pending")).toBeFalsy();
});

test("Restore a plan after hosted payment confirmation", async () => {
  const locationAssign = context.mocks.browser.locationAssign();
  let restored = false;

  context.mocks.data.org({
    id: "org_1",
    name: "Restore Realtime Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(
      200,
      restored
        ? activeProBillingStatus()
        : {
            ...activeProBillingStatus(),
            cancelAtPeriodEnd: true,
            canRestorePlan: true,
            scheduledChange: {
              type: "cancel",
              targetTier: "limited-free-1",
              effectiveDate: "2026-04-01T00:00:00Z",
            },
          },
    );
  });
  let restoreReturnUrl: string | undefined;
  context.mocks.api(billingRestoreContract.create, ({ body, respond }) => {
    restoreReturnUrl = body.returnUrl;
    return respond(200, {
      status: "payment_method_required",
      checkoutUrl: "https://checkout.stripe.com/confirm-restore-plan",
    });
  });

  await openBillingTab();

  await waitFor(() => {
    expect(screen.getByText("Restore plan")).toBeInTheDocument();
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });

  click(screen.getByText("Restore plan"));
  const restoreDialog = await screen.findByRole("dialog", {
    name: "Restore Pro plan?",
  });
  click(buttonByText("Restore plan", restoreDialog));

  await waitFor(() => {
    expect(locationAssign.calls).toStrictEqual([
      "https://checkout.stripe.com/confirm-restore-plan",
    ]);
  });
  expect(
    new URL(restoreReturnUrl ?? "").searchParams.get("billing_pending"),
  ).toBe("restore");
  expect(screen.queryByText("Restore Pro plan?")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Plan restored. Your subscription will renew normally."),
  ).not.toBeInTheDocument();

  restored = true;
  context.mocks.ably.trigger("billing:changed");

  await expect(
    screen.findByText("Plan restored. Your subscription will renew normally."),
  ).resolves.toBeVisible();
});

test("Confirm a restored plan after returning from hosted payment", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Restore Return Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeProBillingStatus());
  });

  await openBillingTab("/?settings=billing&billing_pending=restore");

  await expect(
    screen.findByText("Plan restored. Your subscription will renew normally."),
  ).resolves.toBeVisible();
  const searchParams = new URLSearchParams(window.location.search);
  expect(searchParams.get("settings")).toBe("billing");
  expect(searchParams.has("billing_pending")).toBeFalsy();
});

test("Hide Restore when an ending plan cannot be restored", async () => {
  const canRestorePlan = false;
  context.mocks.data.org({
    id: "org_1",
    name: "Expiring Plan Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...activeProBillingStatus(),
      subscriptionStatus: "atom_grant",
      cancelAtPeriodEnd: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: "2026-04-01T00:00:00Z",
      },
      ...(canRestorePlan === undefined ? {} : { canRestorePlan }),
    });
  });

  await openBillingTab();

  await waitFor(() => {
    expect(
      screen.getByText(/has been cancelled and will end on Apr 1, 2026/),
    ).toBeInTheDocument();
  });
  expect(screen.queryByText("Restore plan")).not.toBeInTheDocument();
});
