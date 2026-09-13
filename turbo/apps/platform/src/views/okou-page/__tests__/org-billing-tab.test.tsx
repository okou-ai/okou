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
  billingPortalContract,
  billingRestoreContract,
  billingStatusContract,
  type BillingStatusResponse,
  type CreditCheckoutRequest,
  type UsagePackMigrationStateResponse,
} from "@okouai/api-contracts/contracts/billing";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi, type Mock } from "vitest";

import {
  click,
  holdElementAnimations,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

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

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
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
    concurrencyLimit: 2,
    concurrencySubscriptions: [],
    concurrencyUnitAmountCents: 10_000,
  };
}

function activeTeamBillingStatus(): BillingStatusResponse {
  return {
    ...activeProBillingStatus(),
    tier: "team",
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

function activeCustomBillingStatus(): BillingStatusResponse {
  return {
    ...activeProBillingStatus(),
    tier: "custom",
    credits: 0,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    hasSubscription: false,
    creditBreakdown: [],
    concurrencyLimit: 10,
  };
}

function noActiveBillingStatus(): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier: "pro-suspend",
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
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function usagePackCatalogResponse(supportsFreeMembers?: boolean) {
  return {
    ...(supportsFreeMembers === undefined ? {} : { supportsFreeMembers }),
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

function mockBillingStory(): {
  readonly creditCheckoutRequest: () => CreditCheckoutRequest | null;
} {
  let billingStatus = activeProBillingStatus();
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

function inAppBillingPreviewFields() {
  return {
    supportsInAppPreview: true as const,
    returnUrl: new URL(
      window.location.pathname,
      window.location.origin,
    ).toString(),
  };
}

function installScrollIntoViewMock(): Mock<HTMLElement["scrollIntoView"]> {
  const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

async function openSettingsFromAccountMenu(
  userName = "Test User",
): Promise<HTMLElement> {
  const accountButton = await waitFor(() => {
    return buttonByLabel(userName);
  });
  click(accountButton);
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  return screen.findByRole("dialog", { name: "Settings" });
}

async function waitForAnimationFrame(): Promise<void> {
  const frame = createDeferredPromise<void>(context.signal);
  window.requestAnimationFrame(() => {
    frame.resolve(undefined);
  });
  await frame.promise;
}

function mockInitialUsagePackPurchase(supportsFreeMembers?: boolean): void {
  context.mocks.data.org({
    id: "org_1",
    name: "Usage Pack Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, noActiveBillingStatus());
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse(supportsFreeMembers));
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

test("Compare usage-pack plans before choosing one", async () => {
  mockInitialUsagePackPurchase(true);
  const { choosePlanHeading, proPlan, teamPlan } =
    await openUsagePackPlanSelection();
  expect(choosePlanHeading).toBeInTheDocument();
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

  expect(
    within(proPlan).getByText("Everyday agent work, priced per member."),
  ).toBeInTheDocument();
  expect(within(proPlan).queryByText("20,000 credits / month")).toBeNull();
  expect(within(proPlan).queryByText("Pay as you go after that")).toBeNull();
  expect(
    within(teamPlan).getByText("For a team that keeps agents running all day."),
  ).toBeInTheDocument();
  expect(within(teamPlan).queryByText("120,000 credits / month")).toBeNull();

  // Pro carries the whole list.
  expect(within(proPlan).getByText("Included")).toBeInTheDocument();
  for (const item of [
    "2 agents running at once",
    "Claude Opus 5, GPT 5.6 Sol, DeepSeek V4 Pro",
    "Bring your own LLM keys",
    "Scheduled and event automations",
    "Video and avatar generation",
    "Built-in SEO, lead, web, and market data",
    "Slack and Telegram integration",
    "Voice input, 300 requests and 200 minutes a day",
    "Email support",
  ]) {
    expect(within(proPlan).getByText(item)).toBeInTheDocument();
  }

  /* Concurrency, webhooks and the voice caps are the real entitlement
       differences; the middle rows are shared capability the label inherits with
       "Everything in Pro", each phrased as an outcome rather than a setting. */
  expect(
    within(teamPlan).getByText("Everything in Pro, built for teams"),
  ).toBeInTheDocument();
  for (const item of [
    "10 agents running at once",
    "Add more concurrency any time",
    "One agent can run a whole team of agents",
    "Start a run from any system with one webhook",
    "Watch an agent's live browser and take the wheel",
    "Agents drive real apps on your desktop",
    "More custom connectors & channel integration",
    "Voice input, 500 requests and 500 minutes a day",
    "Priority support",
  ]) {
    expect(within(teamPlan).getByText(item)).toBeInTheDocument();
  }
  for (const item of [
    "2 agents running at once",
    "Claude Opus 5, GPT 5.6 Sol, DeepSeek V4 Pro",
    "Bring your own LLM keys",
    "Scheduled and event automations",
    "Video and avatar generation",
    "Built-in SEO, lead, web, and market data",
    "Slack and Telegram integration",
    "Email support",
  ]) {
    expect(within(teamPlan).queryByText(item)).toBeNull();
  }
});

test.each(["pro", "team"] as const)(
  "Default new '%s' member packages through 'checkout preview'",
  async (tier) => {
    mockInitialUsagePackPurchase(true);
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

test.each(["pro", "team"] as const)(
  "Default new '%s' member packages through 'empty selection recovery'",
  async (tier) => {
    mockInitialUsagePackPurchase(true);
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
    for (const memberName of ["Alex Chen", "Sam Lee", "pending@example.com"]) {
      await selectMemberUsagePack(memberUsage, memberName, "No package");
    }
    expect(buttonByText(upgradeLabel, orderSummary)).toBeDisabled();
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
    expect(buttonByText(upgradeLabel, orderSummary)).toBeEnabled();
    expect(
      within(orderSummary).queryByText(
        "Select a paid package for at least one member to continue.",
      ),
    ).not.toBeInTheDocument();
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
    within(memberUsage).queryByText(
      "20,000 purchased credits + 1,234 bonus credits",
    ),
  ).not.toBeInTheDocument();
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
  expect(
    within(memberUsage).queryByText(
      "100,000 purchased credits + 9,999 bonus credits",
    ),
  ).not.toBeInTheDocument();
  expect(alexUsage).not.toBeDisabled();
  expect(samUsage).not.toBeDisabled();
  expect(pendingUsage).not.toBeDisabled();
});

test("Keep standalone package choices visible until closing finishes", async () => {
  mockInitialUsagePackPurchase();
  await setupPage({
    context,
    path: "/?settings=billing&billingView=plans",
    auth: {
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    },
  });
  const teamPlan = await screen.findByRole("article", { name: "Team plan" });
  const { memberUsage } = await openTeamMemberPackages(teamPlan);
  await selectMemberUsagePack(
    memberUsage,
    "Alex Chen",
    "$50 · 54,321 credits · 8% off",
  );

  const packagesDialog = screen.getByRole("dialog", {
    name: "Configure member packages",
  });
  const finishCloseTransition = holdElementAnimations(packagesDialog);
  click(within(packagesDialog).getByLabelText("Close"));
  expect(
    new URL(window.location.href).searchParams.has("settings"),
  ).toBeFalsy();
  expect(
    screen.getByRole("dialog", { name: "Configure member packages" }),
  ).toBeVisible();
  expect(
    screen.getByRole("combobox", { name: "Usage for Alex Chen" }),
  ).toHaveTextContent("54,321 credits · 8% off");
  finishCloseTransition();
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  const settingsDialog = await openSettingsFromAccountMenu("Alex Chen");
  click(buttonByText("Billing", settingsDialog));
  await screen.findByText("No active plan");
  click(buttonByText("Upgrade"));
  const reopenedTeamPlan = await screen.findByRole("article", {
    name: "Team plan",
  });
  await openTeamMemberPackages(reopenedTeamPlan);
  expect(
    screen.getByRole("combobox", { name: "Usage for Alex Chen" }),
  ).toHaveTextContent("21,234 credits · 6% off");
});

test("Leave a member-package flow without keeping unfinished choices", async () => {
  let purchaseSubmitted = false;
  mockInitialUsagePackPurchase();
  context.mocks.api(billingUsagePackCheckoutContract.create, ({ respond }) => {
    purchaseSubmitted = true;
    return respond(200, {
      url: "https://checkout.stripe.com/unexpected-package-purchase",
    });
  });
  const { teamPlan } = await openUsagePackPlanSelection();
  const { memberUsage } = await openTeamMemberPackages(teamPlan);
  await selectMemberUsagePack(
    memberUsage,
    "Alex Chen",
    "$50 · 54,321 credits · 8% off",
  );
  await selectMemberUsagePack(
    memberUsage,
    "pending@example.com",
    "$100 · 109,999 credits · 9% off",
  );

  const packagesDialog = screen.getByRole("dialog", {
    name: "Configure member packages",
  });
  click(within(packagesDialog).getByLabelText("Back"));
  const planChooserHeading = await screen.findByRole("heading", {
    name: "Choose a plan",
  });
  expect(purchaseSubmitted).toBeFalsy();
  const planChooserDialog = planChooserHeading.closest('[role="dialog"]');
  if (!(planChooserDialog instanceof HTMLElement)) {
    throw new Error("Plan chooser dialog not found");
  }
  click(within(planChooserDialog).getByLabelText("Close"));

  const settingsDialog = screen.getByRole("dialog", { name: "Settings" });
  click(within(settingsDialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  const reopenedDialog = await openSettingsFromAccountMenu("Alex Chen");
  click(buttonByText("Billing", reopenedDialog));
  await waitFor(() => {
    expect(screen.getByText("No active plan")).toBeInTheDocument();
  });
  click(buttonByText("Upgrade"));
  await expect(
    screen.findByRole("heading", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();

  const reopenedTeamPlan = screen.getByRole("article", {
    name: "Team plan",
  });
  click(buttonByText("Start with Team", reopenedTeamPlan));

  const resetMemberUsage = await screen.findByRole("group", {
    name: "Member usage",
  });
  expect(
    within(resetMemberUsage).getByRole("combobox", {
      name: "Usage for Alex Chen",
    }),
  ).toHaveTextContent("21,234 credits · 6% off");
  expect(
    within(resetMemberUsage).getByRole("combobox", {
      name: "Usage for pending@example.com",
    }),
  ).toHaveTextContent("21,234 credits · 6% off");
  expect(
    within(resetMemberUsage).getByRole("combobox", {
      name: "Usage for Sam Lee",
    }),
  ).toHaveTextContent("21,234 credits · 6% off");
  expect(resetMemberUsage).toHaveTextContent("$220/month");
  expect(purchaseSubmitted).toBeFalsy();
});

test.each([false, true])(
  "Add a package for a member without an allocation (no package supported: %s)",
  async (supportsFreeMembers) => {
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
          id: "invitation_paid_pending",
          email: "paid.pending@example.com",
          role: "member",
          createdAt: "2026-01-03T00:00:00Z",
          usagePackUsd: 100,
        },
      ],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, {
        ...usagePackCatalogResponse(),
        supportsFreeMembers,
      });
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        supportsMemberAdditions: true,
        supportsFreeMembers,
        allocations: [
          {
            id: "b5235934-83df-4f16-bf41-f46890db7d40",
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
          memberUsagePacks: [
            { memberId: "user_1", usagePackUsd: 20 },
            { memberId: "user_2", usagePackUsd: 50 },
          ],
          ...inAppBillingPreviewFields(),
        });
        return respond(200, {
          changeId: "ad3bd64c-7237-436d-a221-61b14ed719e7",
          sourceTier: "pro",
          targetTier: "pro",
          immediateAmountCents: 2500,
          immediateCreditGrant: {
            purchasedCredits: 25_000,
            bonusCredits: 2160,
            totalCredits: 27_160,
            expiresAt: "2026-04-01T00:00:00Z",
          },
          nextRecurringAmountCents: 7000,
          currency: "usd",
          effectiveAt: "2026-03-16T00:00:00Z",
          prorationDate: "2026-03-16T00:00:00Z",
          expiresAt: "2026-03-16T00:15:00Z",
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
    const memberUsage = await screen.findByRole("group", {
      name: "Member usage",
    });
    expect(within(memberUsage).getByText("Alex Chen")).toBeInTheDocument();
    expect(within(memberUsage).getByText("Sam Lee")).toBeInTheDocument();
    expect(
      within(memberUsage).getByText("paid.pending@example.com"),
    ).toBeInTheDocument();
    expect(within(memberUsage).getByText("Pending")).toBeInTheDocument();
    const paidPendingUsage = within(memberUsage).getByRole("combobox", {
      name: "Usage for paid.pending@example.com",
    });
    expect(paidPendingUsage).toHaveTextContent("109,999 credits · 9% off");
    expect(paidPendingUsage).toBeDisabled();
    const samUsage = within(memberUsage).getByRole("combobox", {
      name: "Usage for Sam Lee",
    });
    expect(samUsage).toHaveTextContent(
      supportsFreeMembers ? "No package" : "21,234 credits · 6% off",
    );
    click(samUsage);
    click(
      await screen.findByRole("option", {
        name: "$50 · 54,321 credits · 8% off",
      }),
    );
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    const confirmButton = buttonByText("Confirm", orderSummary);
    click(confirmButton);
    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    expect(reviewDialog).toBeInTheDocument();
    expect(confirmButton).toHaveTextContent("Updating...");
    expect(confirmButton).toBeDisabled();
  },
);

test("Offer a safe conversion path for a legacy plan", async () => {
  const migrationReady = createDeferredPromise<void>(context.signal);
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
    pendingInvitations: [],
    membershipRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeTeamBillingStatus());
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse());
  });
  context.mocks.api(
    billingUsagePackMigrationContract.get,
    async ({ respond }) => {
      await migrationReady.promise;
      return respond(200, {
        tier: "team",
        targetTier: null,
        status: "eligible",
        migrationId: null,
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
  click(buttonByText("Compare all plans"));

  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Choose a plan" }),
  ).not.toBeInTheDocument();

  migrationReady.resolve(undefined);

  const choosePlanDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  expect(within(choosePlanDialog).getByText("Step 1 of 3")).toBeInTheDocument();
  expect(screen.getByText("Legacy")).toBeInTheDocument();
  const proPlan = within(choosePlanDialog).getByRole("article", {
    name: "Pro plan",
  });
  const teamPlan = within(choosePlanDialog).getByRole("article", {
    name: "Team plan",
  });
  expect(buttonByText("Convert plan", proPlan)).toBeEnabled();
  expect(buttonByText("Convert plan", teamPlan)).toBeEnabled();
  expect(
    screen.queryByRole("heading", { name: "Configure member packages" }),
  ).not.toBeInTheDocument();

  click(
    buttonByText(
      "Convert plan",
      screen.getByRole("article", { name: "Pro plan" }),
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
  expect(
    screen.queryByRole("table", {
      name: "Current and new subscription comparison",
    }),
  ).not.toBeInTheDocument();
  const comparison = within(await hoverSubscriptionComparison()).getByRole(
    "table",
    {
      name: "Current and new subscription comparison",
    },
  );
  expect(
    within(comparison).getByRole("row", {
      name: /Plan Team Legacy Pro/u,
    }),
  ).toBeInTheDocument();
  expect(within(comparison).getByText("Monthly total")).toBeInTheDocument();

  click(within(configurePackagesDialog).getByLabelText("Back"));
  const returnedChoosePlanDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  click(within(returnedChoosePlanDialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText("Legacy")).toBeInTheDocument();
  expect(screen.queryByText("Move to member packages")).not.toBeInTheDocument();
  expect(buttonByText("Convert plan")).toBeEnabled();

  click(screen.getByText("Downgrade"));
  const downgradeDialog = await screen.findByRole("dialog", {
    name: "Downgrade plan",
  });
  expect(
    within(downgradeDialog).getByText("Downgrade to No plan?"),
  ).toBeInTheDocument();
  expect(
    within(downgradeDialog).queryByText("Choose which plan to downgrade to."),
  ).not.toBeInTheDocument();
  expect(within(downgradeDialog).queryByText("Pro")).not.toBeInTheDocument();
  click(buttonByText("Cancel", downgradeDialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Downgrade plan" }),
    ).not.toBeInTheDocument();
  });

  click(buttonByText("Convert plan"));
  await screen.findByRole("dialog", { name: "Choose a plan" });
});

test("Prevent a second plan checkout when migration is unavailable", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Paid Pro Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeProBillingStatus());
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
  });

  await screen.findByText("Pro plan");
  click(buttonByText("Compare all plans"));

  const teamPlan = await screen.findByRole("article", { name: "Team plan" });
  expect(buttonByText("Start with Team", teamPlan)).toBeDisabled();
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

test("Schedule a legacy Team conversion after reviewing member packages", async () => {
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
  expect(
    within(orderSummary).queryByText("Monthly difference"),
  ).not.toBeInTheDocument();
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

  click(within(reviewDialog).getByLabelText("Back"));
  const returnedPackagesDialog = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  expect(
    within(returnedPackagesDialog).getByText("Step 2 of 3"),
  ).toBeInTheDocument();
  click(buttonByText("Review conversion", returnedPackagesDialog));
  const returnedReviewDialog = await screen.findByRole("dialog", {
    name: "Review plan conversion",
  });
  click(buttonByText("Confirm", returnedReviewDialog));
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

test("Upgrade a current member package in the app", async () => {
  let changeProcessing = false;
  let paymentApplied = false;
  let previewed = false;
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
      tier: "pro",
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      allocations: [
        {
          id: "b5235934-83df-4f16-bf41-f46890db7d40",
          memberId: "user_1",
          usagePackUsd: paymentApplied ? 50 : 20,
          currentPeriodEnd: "2026-04-01T00:00:00Z",
          pendingChange:
            changeProcessing && !paymentApplied
              ? {
                  id: "ad3bd64c-7237-436d-a221-61b14ed719e7",
                  kind: "upgrade",
                  status: "applying",
                  targetUsagePackUsd: 50,
                  effectiveAt: "2026-03-16T00:00:00Z",
                }
              : previewed && !paymentApplied
                ? {
                    id: "ad3bd64c-7237-436d-a221-61b14ed719e7",
                    kind: "upgrade",
                    status: "previewed",
                    targetUsagePackUsd: 50,
                    effectiveAt: "2026-03-16T00:00:00Z",
                  }
                : null,
        },
      ],
    });
  });
  context.mocks.api(
    billingUsagePackManagementContract.previewSubscriptionChange,
    ({ body, respond }) => {
      previewed = true;
      expect(body).toStrictEqual({
        targetTier: "pro",
        memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 50 }],
        ...inAppBillingPreviewFields(),
      });
      return respond(200, {
        changeId: "ad3bd64c-7237-436d-a221-61b14ed719e7",
        sourceTier: "pro",
        targetTier: "pro",
        immediateAmountCents: 1500,
        immediateCreditGrant: {
          purchasedCredits: 15_000,
          bonusCredits: 1100,
          totalCredits: 16_100,
          expiresAt: "2026-04-01T00:00:00Z",
        },
        nextRecurringAmountCents: 5000,
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
        changeId: "ad3bd64c-7237-436d-a221-61b14ed719e7",
      });
      changeProcessing = true;
      return respond(200, {
        status: "processing",
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

  await waitFor(() => {
    expect(screen.getByText("Pro plan")).toBeInTheDocument();
  });
  expect(
    screen.queryByRole("heading", { name: "Member packages" }),
  ).not.toBeInTheDocument();
  click(buttonByText("Compare all plans"));
  await screen.findByRole("heading", { name: "Choose a plan" });
  const proPlan = screen.getByRole("article", { name: "Pro plan" });
  const teamPlan = screen.getByRole("article", { name: "Team plan" });
  expect(buttonByText("Manage", proPlan)).not.toBeDisabled();
  expect(proPlan).toHaveTextContent("from $20/month");
  expect(teamPlan).toHaveTextContent("from $180/month");
  expect(teamPlan).toHaveTextContent(
    "Plan $160 · member packages $20–$200 each",
  );
  click(buttonByText("Manage", proPlan));

  await screen.findByRole("heading", {
    name: "Configure member packages",
  });
  const packageSelect = await screen.findByRole("combobox", {
    name: "Usage for Alex Chen",
  });
  const memberUsage = screen.getByRole("group", {
    name: "Member usage",
  });
  const orderSummary = screen.getByRole("region", {
    name: "Order summary",
  });
  expect(
    screen.queryByRole("table", {
      name: "Current and new subscription comparison",
    }),
  ).not.toBeInTheDocument();
  // With nothing changed there is no comparison and no repeated summary; the
  // ledger above already carries the current state.
  expect(
    within(orderSummary).queryByText("Concurrent slots"),
  ).not.toBeInTheDocument();
  expect(queryAllByRoleFast("button", orderSummary)).toHaveLength(0);
  const user = userEvent.setup();
  await user.click(packageSelect);
  await user.click(
    await screen.findByRole("option", {
      name: "$50 · 54,321 credits · 8% off",
    }),
  );
  const comparisonTrigger = subscriptionComparisonTrigger(memberUsage);
  expect(comparisonTrigger).toHaveAccessibleName(
    "Subscription comparison: $50/month",
  );
  expect(comparisonTrigger).toHaveTextContent("$50/month");
  comparisonTrigger.focus();
  expect(comparisonTrigger).toHaveFocus();
  const comparisonTooltip = await screen.findByRole("tooltip");
  expect(
    within(comparisonTooltip).getByText("Subscription comparison"),
  ).toBeInTheDocument();
  expect(
    within(comparisonTooltip).getByText(
      "Your current subscription and this selection, side by side",
    ),
  ).toBeInTheDocument();
  const comparison = within(comparisonTooltip).getByRole("table", {
    name: "Current and new subscription comparison",
  });
  expect(within(comparison).getByText("Current")).toBeInTheDocument();
  expect(within(comparison).getByText("New")).toBeInTheDocument();
  expect(
    within(comparison).getByRole("row", {
      name: /Member packages \$20 \$50/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(comparison).getByRole("row", {
      name: /Purchased credits 20,000 50,000/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(comparison).getByRole("row", {
      name: /Bonus credits 1,234 4,321/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(comparison).getByRole("row", {
      name: /Monthly total \$20\/month \$50\/month/u,
    }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Review")).not.toBeInTheDocument();
  const locationBeforeConfirmation = window.location.href;
  click(buttonByText("Confirm", orderSummary));
  const confirmationDialog = await screen.findByRole("dialog", {
    name: "Review package change",
  });
  // The review is the flow's last step, not a dialog stacked on the packages
  // it reviews, so the configuration step is gone while it is open.
  expect(
    within(confirmationDialog).getByText("Step 3 of 3"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Order summary" }),
  ).not.toBeInTheDocument();
  expect(within(confirmationDialog).getByText("Today")).toBeInTheDocument();
  expect(
    within(confirmationDialog).getByText("Every month"),
  ).toBeInTheDocument();
  const dueRow = within(confirmationDialog).getByText("Due now").closest("div");
  expect(dueRow).toHaveTextContent("For the rest of this billing period");
  expect(dueRow).toHaveTextContent("$15.00");
  const grantRow = within(confirmationDialog)
    .getByText("Credits added after payment")
    .closest("div");
  expect(grantRow).toHaveTextContent("Expires Apr 1, 2026");
  expect(grantRow).toHaveTextContent("+16,100");
  expect(
    within(confirmationDialog).queryByText("Next recurring total"),
  ).not.toBeInTheDocument();
  expect(
    within(confirmationDialog).queryByText("Total credits"),
  ).not.toBeInTheDocument();
  const monthlyCreditsRow = within(confirmationDialog)
    .getByText("Credits")
    .closest("div");
  expect(monthlyCreditsRow).toHaveTextContent("4,321 bonus included");
  expect(monthlyCreditsRow).toHaveTextContent("54,321");
  expect(
    within(confirmationDialog).getByText("Monthly total").closest("div"),
  ).toHaveTextContent("$50/month");
  expect(
    within(confirmationDialog).queryByText(/Renews /u),
  ).not.toBeInTheDocument();
  expect(window.location.href).toBe(locationBeforeConfirmation);
  click(buttonByText("Confirm", confirmationDialog));
  await screen.findByRole("heading", {
    name: "Configure member packages",
  });
  await screen.findByText("Change is processing");
  expect(
    queryAllByRoleFast(
      "button",
      screen.getByRole("region", { name: "Order summary" }),
    ),
  ).toHaveLength(0);
  await expect(
    screen.findByText("Subscription change confirmed."),
  ).resolves.toBeVisible();
  expect(window.location.href).toBe(locationBeforeConfirmation);
  expect(
    screen.queryByRole("heading", { name: "Choose a plan" }),
  ).not.toBeInTheDocument();

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });
  paymentApplied = true;
  context.mocks.ably.trigger("billing:changed");

  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Usage for Alex Chen" }),
    ).toHaveTextContent("54,321 credits · 8% off");
  });
  expect(
    queryAllByRoleFast(
      "button",
      screen.getByRole("region", { name: "Order summary" }),
    ),
  ).toHaveLength(0);
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

test.each([50, 0] as const)(
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
      return respond(200, {
        ...usagePackCatalogResponse(),
        supportsFreeMembers: true,
      });
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
    expect(screen.queryByText("+4,321 bonus credits")).not.toBeInTheDocument();
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

test.each([
  { targetUsagePackUsd: 100, alreadyScheduled: true },
  { targetUsagePackUsd: 0, alreadyScheduled: true },
  { targetUsagePackUsd: 0, alreadyScheduled: false },
] as const)(
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
      return respond(200, {
        ...usagePackCatalogResponse(),
        supportsFreeMembers: true,
      });
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

test("Upgrade Pro to Team without repurchasing member packages", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Usage Pack Upgrade Org",
    role: "admin",
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
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      allocations: [
        {
          id: "b5235934-83df-4f16-bf41-f46890db7d40",
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
        targetTier: "team",
        memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 20 }],
        ...inAppBillingPreviewFields(),
      });
      return respond(200, {
        changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
        sourceTier: "pro",
        targetTier: "team",
        immediateAmountCents: 8000,
        nextRecurringAmountCents: 18_000,
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
      return respond(200, {
        status: "processing",
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

  await waitFor(() => {
    expect(screen.getByText("Pro plan")).toBeInTheDocument();
  });
  click(buttonByText("Upgrade"));

  await screen.findByRole("heading", {
    name: "Configure member packages",
  });
  expect(
    screen.queryByRole("heading", { name: "Compare plans" }),
  ).not.toBeInTheDocument();
  // A managed subscription still has its review step ahead of it.
  expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
  const packageSelect = await screen.findByRole("combobox", {
    name: "Usage for Alex Chen",
  });
  expect(packageSelect).toHaveTextContent("21,234 credits · 6% off");
  expect(packageSelect).not.toBeDisabled();
  const orderSummary = screen.getByRole("region", {
    name: "Order summary",
  });
  let comparison = within(await hoverSubscriptionComparison()).getByRole(
    "table",
    {
      name: "Current and new subscription comparison",
    },
  );
  expect(
    within(comparison).getByRole("row", {
      name: /Plan Pro · \$0 Team · \$160/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(comparison).getByRole("row", {
      name: /Concurrent slots 2 10/u,
    }),
  ).toBeInTheDocument();
  expect(
    within(comparison).getByRole("row", {
      name: /Monthly total \$20\/month \$180\/month/u,
    }),
  ).toBeInTheDocument();
  const confirmButton = buttonByText("Confirm", orderSummary);

  click(packageSelect);
  click(
    await screen.findByRole("option", {
      name: "$50 · 54,321 credits · 8% off",
    }),
  );
  comparison = within(await hoverSubscriptionComparison()).getByRole("table", {
    name: "Current and new subscription comparison",
  });
  expect(
    within(comparison).getByRole("row", {
      name: /Monthly total \$20\/month \$210\/month/u,
    }),
  ).toBeInTheDocument();
  expect(confirmButton).not.toBeDisabled();

  click(packageSelect);
  click(
    await screen.findByRole("option", {
      name: "$20 · 21,234 credits · 6% off",
    }),
  );
  comparison = within(await hoverSubscriptionComparison()).getByRole("table", {
    name: "Current and new subscription comparison",
  });
  expect(
    within(comparison).getByRole("row", {
      name: /Monthly total \$20\/month \$180\/month/u,
    }),
  ).toBeInTheDocument();

  const locationBeforeConfirmation = window.location.href;
  click(confirmButton);
  const confirmationDialog = await screen.findByRole("dialog", {
    name: "Review package change",
  });
  expect(within(confirmationDialog).getByText("$80.00")).toBeInTheDocument();
  expect(
    within(confirmationDialog).getByText("Monthly total").closest("div"),
  ).toHaveTextContent("$180/month");
  expect(window.location.href).toBe(locationBeforeConfirmation);
  click(buttonByText("Confirm", confirmationDialog));
  await screen.findByRole("heading", {
    name: "Configure member packages",
  });
  expect(window.location.href).toBe(locationBeforeConfirmation);
});

test("Schedule a Team-to-Pro downgrade", async () => {
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
    return respond(200, usagePackCatalogResponse(true));
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

test("Open the Buy credits section from a billing deep link", async () => {
  const scrollIntoView = installScrollIntoViewMock();
  context.mocks.data.org({
    id: "org_1",
    name: "Credit Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeProBillingStatus());
  });

  await openBillingTab("/?settings=billing&billingView=credits");

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Buy credits" }),
    ).toBeInTheDocument();
    expect(buttonByText("Quick buy $20.00")).toBeEnabled();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "smooth",
    });
  });
});

test("Do not reuse an unavailable credits deep link after Settings closes", async () => {
  const scrollIntoView = installScrollIntoViewMock();
  let billingStatus: BillingStatusResponse = {
    ...activeProBillingStatus(),
    canBuyCredits: false,
  };
  context.mocks.data.org({
    id: "org_1",
    name: "Credit Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus);
  });

  await openBillingTab("/?settings=billing&billingView=credits");

  const dialog = screen.getByRole("dialog", { name: "Settings" });
  await waitFor(() => {
    expect(
      screen.getByText(
        "Manage the payment methods used for billing in Stripe.",
      ),
    ).toBeInTheDocument();
  });
  expect(
    within(dialog).queryByRole("heading", { name: "Buy credits" }),
  ).not.toBeInTheDocument();

  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  billingStatus = {
    ...activeProBillingStatus(),
    canBuyCredits: true,
  };
  const reopenedDialog = await openSettingsFromAccountMenu();
  click(buttonByText("Billing", reopenedDialog));

  const buyCreditsHeading = await within(reopenedDialog).findByRole("heading", {
    name: "Buy credits",
  });
  expect(buyCreditsHeading).toBeInTheDocument();
  await waitForAnimationFrame();
  expect(scrollIntoView).not.toHaveBeenCalled();
});

test("Show billing controls according to plan capabilities", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Capability Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...noActiveBillingStatus(),
      canBuyConcurrency: true,
      canBuyCredits: true,
      autoRechargeAllowed: true,
    });
  });

  await openBillingTab();

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Buy credits" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Automatic top-ups")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Concurrency" }),
    ).toBeInTheDocument();
  });
});

test("Retry after billing status fails to load", async () => {
  let failNextStatusRequest = false;
  const failedStatusRequestStarted = context.mocks.deferred<void>();
  const releaseFailedStatusResponse = context.mocks.deferred<void>();

  context.mocks.data.org({
    id: "org_1",
    name: "Suspended Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    if (failNextStatusRequest) {
      failNextStatusRequest = false;
      failedStatusRequestStarted.resolve();
      await releaseFailedStatusResponse.promise;
      return respond(500, {
        error: {
          message: "Failed to load billing status",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    }
    return respond(200, noActiveBillingStatus());
  });
  await openBillingTab();

  await waitFor(() => {
    expect(screen.getByText("No active plan")).toBeInTheDocument();
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });

  failNextStatusRequest = true;
  context.mocks.ably.trigger("billing:changed");
  await failedStatusRequestStarted.promise;
  releaseFailedStatusResponse.resolve();
  await expect(
    screen.findByText("Could not load billing status."),
  ).resolves.toBeInTheDocument();

  click(screen.getByText("Retry"));

  await waitFor(() => {
    expect(screen.getByText("No active plan")).toBeInTheDocument();
    expect(screen.getByText("No active subscription")).toBeInTheDocument();
  });
});

test("Manage workspace payment methods in Stripe", async () => {
  let portalRequestBody: unknown;
  context.mocks.data.org({
    id: "org_1",
    name: "Paid Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeProBillingStatus());
  });
  context.mocks.api(billingPortalContract.create, ({ body, respond }) => {
    portalRequestBody = body;
    return respond(200, {
      url: "https://billing.stripe.com/customer-portal/test-org",
    });
  });

  await openBillingTab("/?settings=billing");

  await waitFor(() => {
    expect(screen.getByText("Payment methods")).toBeInTheDocument();
    expect(screen.getByText("Pro plan")).toBeInTheDocument();
  });

  click(buttonByText("Manage"));

  await waitFor(() => {
    expect(window.location.href).toBe(
      "https://billing.stripe.com/customer-portal/test-org",
    );
  });
  expect(portalRequestBody).not.toHaveProperty("mode");
});

test("Open payment methods in a new tab with a modified click", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "No Subscription Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, noActiveBillingStatus());
  });
  context.mocks.api(billingPortalContract.create, ({ respond }) => {
    return respond(200, {
      url: "https://billing.stripe.com/customer-portal/no-subscription",
    });
  });
  const openedTargets = context.mocks.browser.open();

  await openBillingTab();

  await waitFor(() => {
    expect(screen.getByText("Payment methods")).toBeInTheDocument();
  });

  fireEvent.click(buttonByText("Manage"), { metaKey: true });

  await waitFor(() => {
    expect(openedTargets.calls).toStrictEqual([
      {
        url: "https://billing.stripe.com/customer-portal/no-subscription",
        target: "_blank",
        features: null,
      },
    ]);
  });
});

test("Show custom-plan access without self-service plan changes", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Custom Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeCustomBillingStatus());
  });

  await openBillingTab();

  await waitFor(() => {
    expect(screen.getByText("Custom plan")).toBeInTheDocument();
    expect(
      screen.getByText("Custom access with 10 concurrent runs"),
    ).toBeInTheDocument();
    expect(screen.getByText("10 concurrent runs")).toBeInTheDocument();
    expect(screen.getByText("Payment methods")).toBeInTheDocument();
  });
  expect(screen.queryByText("Upgrade")).not.toBeInTheDocument();
  expect(screen.queryByText("Downgrade")).not.toBeInTheDocument();
});

test("Keep usage-pack plans unavailable for custom workspaces", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Custom Usage Pack Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, activeCustomBillingStatus());
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse());
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      tier: "team",
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      allocations: [],
    });
  });

  await openBillingTab("/?settings=billing");

  await screen.findByText("Custom plan");

  for (let openCount = 0; openCount < 2; openCount += 1) {
    click(buttonByText("Compare all plans"));

    const choosePlanDialog = await screen.findByRole("dialog", {
      name: "Choose a plan",
    });
    expect(
      within(choosePlanDialog).getByText("Step 1 of 3"),
    ).toBeInTheDocument();
    for (const name of ["Pro plan", "Team plan"]) {
      const plan = within(choosePlanDialog).getByRole("article", { name });
      expect(buttonByText("Unavailable", plan)).toBeDisabled();
    }

    click(within(choosePlanDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Choose a plan" }),
      ).not.toBeInTheDocument();
    });
  }
});

test("Show the end date for a cancelled custom plan", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Custom Cancel Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...activeCustomBillingStatus(),
      cancelAtPeriodEnd: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "pro-suspend",
        effectiveDate: "2026-08-09T00:00:00Z",
      },
    });
  });

  await openBillingTab();

  await waitFor(() => {
    expect(screen.getByText("Custom plan")).toBeInTheDocument();
    expect(
      screen.getByText("Your custom plan will end on Aug 9, 2026."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Custom plan has been cancelled/u),
    ).not.toBeInTheDocument();
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
      targetTier: "pro-suspend",
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

test("Cancel and restore a paid concurrency subscription", async () => {
  let canceledSubscriptionId: string | null = null;
  let restoredSubscriptionId: string | null = null;
  let billingStatus: BillingStatusResponse = {
    ...activeTeamBillingStatus(),
    concurrencyLimit: 12,
    concurrencySubscriptions: [
      {
        id: "sub_concurrency_12345678",
        quantity: 2,
        currentPeriodEnd: "2026-06-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        canReduce: true,
        canChangeInApp: true,
      },
    ],
  };

  context.mocks.data.org({
    id: "org_1",
    name: "Team Concurrency Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus);
  });
  context.mocks.api(
    billingConcurrencySubscriptionContract.cancel,
    ({ params, respond }) => {
      canceledSubscriptionId = params.subscriptionId;
      billingStatus = {
        ...billingStatus,
        concurrencySubscriptions: billingStatus.concurrencySubscriptions.map(
          (subscription) => {
            if (subscription.id !== params.subscriptionId) {
              return subscription;
            }
            return { ...subscription, cancelAtPeriodEnd: true };
          },
        ),
      };
      return respond(200, {
        success: true,
        currentPeriodEnd: "2026-06-01T00:00:00Z",
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
            if (subscription.id !== params.subscriptionId) {
              return subscription;
            }
            return { ...subscription, cancelAtPeriodEnd: false };
          },
        ),
      };
      return respond(200, { success: true });
    },
  );
  await openBillingTab();

  await waitFor(() => {
    expect(screen.getByText("12 concurrent runs")).toBeInTheDocument();
    expect(screen.getByText("10 included with your plan")).toBeInTheDocument();
    expect(screen.getByText("2 paid add-on")).toBeInTheDocument();
    expect(screen.getByText("Renews Jun 1, 2026")).toBeInTheDocument();
  });
  expect(queryButtonByText("Buy concurrency")).toBeUndefined();

  click(buttonByText("Change"));
  const initialChangeDialog = await screen.findByRole("dialog", {
    name: "Change concurrency",
  });
  expect(canceledSubscriptionId).toBeNull();
  expect(queryAllByRoleFast("radio", initialChangeDialog)).toHaveLength(0);
  click(buttonByText("Cancel entire subscription", initialChangeDialog));
  const cancelDialog = await screen.findByRole("dialog", {
    name: "Cancel entire subscription",
  });
  expect(cancelDialog).toHaveTextContent(
    "This stops renewal at the end of the current billing period. Existing slots stay active until then.",
  );
  click(buttonByText("Cancel subscription", cancelDialog));

  await waitFor(() => {
    expect(canceledSubscriptionId).toBe("sub_concurrency_12345678");
    expect(
      screen.getByText(
        "Concurrency subscription canceled. Slots stay active until Jun 1, 2026.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Active until Jun 1, 2026")).toBeInTheDocument();
    expect(buttonByText("Restore concurrency")).toBeInTheDocument();
  });

  click(buttonByText("Restore concurrency"));
  const restoreDialog = await screen.findByRole("dialog", {
    name: "Restore concurrency subscription?",
  });
  expect(restoredSubscriptionId).toBeNull();
  expect(restoreDialog).toHaveTextContent(
    "This restores renewal for your paid concurrency (2 slots). Your plan will not change.",
  );
  click(buttonByText("Restore concurrency", restoreDialog));

  await waitFor(() => {
    expect(restoredSubscriptionId).toBe("sub_concurrency_12345678");
    expect(
      screen.getByText("Concurrency subscription restored."),
    ).toBeInTheDocument();
    expect(screen.getByText("Renews Jun 1, 2026")).toBeInTheDocument();
  });
});

test("Increase an active paid concurrency subscription", async () => {
  let previewedQuantity: number | null = null;
  let confirmedQuantity: number | null = null;
  const billingStatus: BillingStatusResponse = {
    ...activeTeamBillingStatus(),
    concurrencyLimit: 12,
    concurrencySubscriptions: [
      {
        id: "sub_concurrency_12345678",
        quantity: 2,
        currentPeriodEnd: "2026-06-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        canReduce: true,
        canChangeInApp: true,
      },
    ],
  };

  context.mocks.data.org({
    id: "org_1",
    name: "Team Concurrency Org",
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
        currentQuantity: 2,
        targetQuantity: body.quantity,
        immediateAmountCents: 15_000,
        nextRecurringAmountCents: body.quantity * 10_000,
        currency: "usd",
      });
    },
  );
  context.mocks.api(
    billingConcurrencySubscriptionContract.confirmChange,
    ({ body, respond }) => {
      confirmedQuantity = body.quantity;
      return respond(200, {
        status: "pending_payment",
        hostedInvoiceUrl: "https://invoice.stripe.test/org-concurrency-change",
      });
    },
  );

  await openBillingTab();

  await waitFor(() => {
    expect(screen.getByText("12 concurrent runs")).toBeInTheDocument();
    expect(screen.getByText("10 included with your plan")).toBeInTheDocument();
    expect(screen.getByText("2 paid add-on")).toBeInTheDocument();
    expect(screen.getByText("Renews Jun 1, 2026")).toBeInTheDocument();
  });
  expect(queryButtonByText("Buy concurrency")).toBeUndefined();

  click(buttonByText("Change"));
  const changeDialog = await screen.findByRole("dialog", {
    name: "Change concurrency",
  });
  expect(queryAllByRoleFast("radio", changeDialog)).toHaveLength(0);
  const quantityInput = within(changeDialog).getByRole("textbox", {
    name: "Slots",
  });
  expect(quantityInput).toHaveValue("2");
  const increaseQuantity = within(changeDialog).getByLabelText(
    "Increase additional concurrency quantity",
  );
  click(increaseQuantity);
  click(increaseQuantity);

  await waitFor(() => {
    expect(within(changeDialog).getByText("$400/month")).toBeInTheDocument();
  });

  click(buttonByText("Review change", changeDialog));

  const reviewDialog = await screen.findByRole("dialog", {
    name: "Review concurrency change",
  });
  expect(previewedQuantity).toBe(4);
  expect(within(reviewDialog).getByText("Slots")).toBeInTheDocument();
  expect(within(reviewDialog).getByText("4")).toBeInTheDocument();
  expect(within(reviewDialog).getByText("Due today")).toBeInTheDocument();
  expect(within(reviewDialog).getByText("$150.00")).toBeInTheDocument();
  expect(within(reviewDialog).getByText("$400.00/month")).toBeInTheDocument();

  click(buttonByText("Pay and update", reviewDialog));

  await waitFor(() => {
    expect(confirmedQuantity).toBe(4);
    expect(window.location.href).toBe(
      "https://invoice.stripe.test/org-concurrency-change",
    );
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

test("Buy concurrency when an in-app price preview is unavailable", async () => {
  let requestedQuantity: number | null = null;

  context.mocks.data.org({
    id: "org_1",
    name: "Team Concurrency Price Unavailable Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...activeTeamBillingStatus(),
      concurrencyUnitAmountCents: undefined,
    });
  });
  context.mocks.api(
    billingConcurrencyCheckoutContract.create,
    ({ body, respond }) => {
      requestedQuantity = body.quantity;
      return respond(200, {
        url: `https://checkout.stripe.com/concurrency?quantity=${body.quantity}`,
      });
    },
  );

  await openBillingTab();

  click(buttonByText("Buy concurrency"));
  const purchaseDialog = await screen.findByRole("dialog", {
    name: "Buy concurrency",
  });
  expect(within(purchaseDialog).getByText("—")).toBeInTheDocument();
  click(buttonByText("Buy concurrency", purchaseDialog));

  await waitFor(() => {
    expect(requestedQuantity).toBe(1);
    expect(window.location.href).toBe(
      "https://checkout.stripe.com/concurrency?quantity=1",
    );
  });
});

test("Schedule and restore a paid-concurrency reduction", async () => {
  let previewedQuantity: number | null = null;
  let confirmedQuantity: number | null = null;
  let restoredSubscriptionId: string | null = null;
  let billingStatus: BillingStatusResponse = {
    ...activeTeamBillingStatus(),
    concurrencyLimit: 15,
    concurrencySubscriptions: [
      {
        id: "sub_concurrency_reduce",
        quantity: 5,
        currentPeriodEnd: "2026-06-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        canReduce: true,
        canChangeInApp: true,
        scheduledQuantity: null,
        scheduledChangeAt: null,
      },
    ],
  };

  context.mocks.data.org({
    id: "org_1",
    name: "Concurrency Reduction Org",
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
        immediateAmountCents: 0,
        nextRecurringAmountCents: body.quantity * 10_000,
        currency: "usd",
        effectiveAt: "2026-06-01T00:00:00Z",
      });
    },
  );
  context.mocks.api(
    billingConcurrencySubscriptionContract.confirmChange,
    ({ body, respond }) => {
      confirmedQuantity = body.quantity;
      billingStatus = {
        ...billingStatus,
        concurrencySubscriptions: billingStatus.concurrencySubscriptions.map(
          (subscription) => {
            return {
              ...subscription,
              scheduledQuantity: body.quantity,
              scheduledChangeAt: "2026-06-01T00:00:00Z",
            };
          },
        ),
      };
      return respond(200, {
        status: "completed",
        hostedInvoiceUrl: null,
        effectiveAt: "2026-06-01T00:00:00Z",
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

  click(buttonByText("Change"));
  const dialog = await screen.findByRole("dialog", {
    name: "Change concurrency",
  });
  expect(queryAllByRoleFast("radio", dialog)).toHaveLength(0);
  const quantityInput = within(dialog).getByRole("textbox", {
    name: "Slots",
  });
  expect(quantityInput).toHaveValue("5");
  const decreaseQuantity = within(dialog).getByLabelText(
    "Decrease additional concurrency quantity",
  );
  click(decreaseQuantity);
  click(decreaseQuantity);
  expect(quantityInput).toHaveValue("3");
  expect(within(dialog).getByText("$300/month")).toBeInTheDocument();

  const locationBeforeChange = window.location.href;
  click(buttonByText("Review change", dialog));

  const reviewDialog = await screen.findByRole("dialog", {
    name: "Review concurrency change",
  });
  expect(previewedQuantity).toBe(3);
  expect(within(reviewDialog).queryByText("Due today")).not.toBeInTheDocument();
  expect(
    within(reviewDialog).getByText(
      "Your current slots stay active through this billing period. The lower quantity starts at renewal with no refund or account credit.",
    ),
  ).toBeInTheDocument();
  expect(
    within(reviewDialog).getByText("Scheduled for Jun 1, 2026"),
  ).toBeInTheDocument();
  expect(within(reviewDialog).getByText("$300.00/month")).toBeInTheDocument();

  click(buttonByText("Schedule change", reviewDialog));

  await waitFor(() => {
    expect(confirmedQuantity).toBe(3);
    expect(window.location.href).toBe(locationBeforeChange);
    expect(
      screen.getByText("Changes to 3 slots on Jun 1, 2026"),
    ).toBeInTheDocument();
    expect(buttonByText("Restore concurrency")).toBeEnabled();
  });

  click(buttonByText("Restore concurrency"));
  const restoreDialog = await screen.findByRole("dialog", {
    name: "Restore concurrency subscription?",
  });
  expect(restoreDialog).toHaveTextContent(
    "This restores renewal for your paid concurrency (5 slots). Your plan will not change.",
  );
  click(buttonByText("Restore concurrency", restoreDialog));

  await waitFor(() => {
    expect(restoredSubscriptionId).toBe("sub_concurrency_reduce");
    expect(
      screen.queryByText("Changes to 3 slots on Jun 1, 2026"),
    ).not.toBeInTheDocument();
    expect(buttonByText("Change")).toBeEnabled();
  });
});

test("Keep paid concurrency within supported quantity limits", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Concurrency Boundary Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...activeTeamBillingStatus(),
      concurrencyLimit: 11,
      concurrencySubscriptions: [
        {
          id: "sub_concurrency_boundary",
          quantity: 1,
          currentPeriodEnd: "2026-06-01T00:00:00Z",
          cancelAtPeriodEnd: false,
          canReduce: true,
          canChangeInApp: true,
        },
      ],
    });
  });

  await openBillingTab();

  click(buttonByText("Change"));
  const dialog = await screen.findByRole("dialog", {
    name: "Change concurrency",
  });
  const quantityInput = within(dialog).getByRole("textbox", {
    name: "Slots",
  });
  const decreaseQuantity = within(dialog).getByLabelText(
    "Decrease additional concurrency quantity",
  );
  expect(quantityInput).toHaveValue("1");
  expect(decreaseQuantity).toBeDisabled();
  fireEvent.change(quantityInput, { target: { value: "0" } });
  expect(quantityInput).toHaveValue("1");

  fireEvent.change(quantityInput, { target: { value: "1000" } });
  expect(quantityInput).toHaveValue("1000");
  expect(
    within(dialog).getByLabelText("Increase additional concurrency quantity"),
  ).toBeDisabled();
  expect(within(dialog).getByText("$100,000/month")).toBeInTheDocument();
  fireEvent.change(quantityInput, { target: { value: "1001" } });
  expect(quantityInput).toHaveValue("1000");
});

test("Lock concurrency actions while a price review is loading", async () => {
  const previewReady = createDeferredPromise<void>(context.signal);
  let previewStarted = false;

  context.mocks.data.org({
    id: "org_1",
    name: "Concurrency Loading Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...activeTeamBillingStatus(),
      concurrencyLimit: 12,
      concurrencySubscriptions: [
        {
          id: "sub_concurrency_loading",
          quantity: 2,
          currentPeriodEnd: "2026-06-01T00:00:00Z",
          cancelAtPeriodEnd: false,
          canReduce: true,
          canChangeInApp: true,
        },
      ],
    });
  });
  context.mocks.api(
    billingConcurrencySubscriptionContract.previewChange,
    async ({ body, respond }) => {
      previewStarted = true;
      await previewReady.promise;
      return respond(200, {
        currentQuantity: 2,
        targetQuantity: body.quantity,
        immediateAmountCents: 10_000,
        nextRecurringAmountCents: body.quantity * 10_000,
        currency: "usd",
      });
    },
  );

  await openBillingTab();

  click(buttonByText("Change"));
  const dialog = await screen.findByRole("dialog", {
    name: "Change concurrency",
  });
  const cancelSubscription = buttonByText("Cancel entire subscription", dialog);
  const cancel = buttonByText("Cancel", dialog);
  const increaseQuantity = within(dialog).getByLabelText(
    "Increase additional concurrency quantity",
  );
  click(increaseQuantity);
  const reviewChange = buttonByText("Review change", dialog);
  click(reviewChange);

  await waitFor(() => {
    expect(previewStarted).toBeTruthy();
    expect(reviewChange).toHaveTextContent("Updating...");
    expect(reviewChange).toBeDisabled();
  });
  expect(cancelSubscription).toBeDisabled();
  expect(cancel).toBeDisabled();
  expect(
    within(dialog).getByLabelText("Decrease additional concurrency quantity"),
  ).toBeDisabled();
  expect(
    within(dialog).getByLabelText("Increase additional concurrency quantity"),
  ).toBeDisabled();

  previewReady.resolve(undefined);
  await screen.findByRole("dialog", { name: "Review concurrency change" });
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
  context.mocks.api(billingDowngradeContract.create, ({ respond }) => {
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
  expect(screen.queryByText("Downgrade plan")).not.toBeInTheDocument();
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
  context.mocks.api(billingRestoreContract.create, ({ respond }) => {
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

test("Buy credits with a saved payment method in the app", async () => {
  const checkoutReady = createDeferredPromise<void>(context.signal);
  let startRequest: CreditCheckoutRequest | null = null;
  let confirmedPreviewToken: string | null = null;
  let purchaseCompleted = false;

  context.mocks.data.org({
    id: "org_1",
    name: "Credit Preview Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...activeProBillingStatus(),
      canBuyCredits: true,
      credits: purchaseCompleted ? 32_500 : 12_500,
    });
  });
  context.mocks.api(
    billingCreditCheckoutContract.create,
    async ({ body, respond }) => {
      startRequest = body;
      await checkoutReady.promise;
      return respond(200, {
        status: "preview",
        credits: 20_000,
        amountCents: 1800,
        currency: "usd",
        expiresAt: "2026-08-13T12:15:00.000Z",
        previewToken: "credit-preview-token",
      });
    },
  );
  context.mocks.api(
    billingCreditCheckoutContract.confirm,
    ({ body, respond }) => {
      confirmedPreviewToken = body.previewToken;
      purchaseCompleted = true;
      return respond(200, {
        status: "completed",
        hostedInvoiceUrl: null,
      });
    },
  );

  await openBillingTab("/?settings=billing");
  const locationBeforePurchase = window.location.href;
  const quickBuyButton = buttonByText("Quick buy $20.00");
  click(quickBuyButton);

  await waitFor(() => {
    expect(buttonByText("Preparing...")).toBeDisabled();
  });
  expect(queryButtonByText("Redirecting...")).toBeUndefined();
  checkoutReady.resolve(undefined);

  const reviewDialog = await screen.findByRole("dialog", {
    name: "Review credit purchase",
  });
  expect(quickBuyButton).toHaveTextContent("Preparing...");
  expect(quickBuyButton).toBeDisabled();
  expect(
    within(reviewDialog).getByText(
      "Confirm this one-time charge with your saved payment method.",
    ),
  ).toBeInTheDocument();
  expect(within(reviewDialog).getByText("Today")).toBeInTheDocument();
  expect(within(reviewDialog).getByText("Due now")).toBeInTheDocument();
  expect(within(reviewDialog).getByText("Credits added")).toBeInTheDocument();
  expect(within(reviewDialog).queryByText("Every month")).toBeNull();
  expect(within(reviewDialog).getByText("$18.00")).toBeInTheDocument();
  expect(within(reviewDialog).getByText("+20,000")).toBeInTheDocument();
  expect(startRequest).toMatchObject({
    credits: 20_000,
    supportsInAppPreview: true,
  });
  expect(window.location.href).toBe(locationBeforePurchase);

  click(buttonByText("Pay and add credits", reviewDialog));

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Review credit purchase" }),
    ).not.toBeInTheDocument();
  });
  expect(confirmedPreviewToken).toBe("credit-preview-token");
  expect(window.location.href).toBe(locationBeforePurchase);
  click(buttonByText("Credit balance"));
  await expect(screen.findByText("32,500")).resolves.toBeInTheDocument();
});

test("Buy a custom credit amount in hosted checkout", async () => {
  const billingStory = mockBillingStory();
  await openBillingTab("/?settings=billing");

  await waitFor(() => {
    expect(screen.getByText("Pro plan")).toBeInTheDocument();
    expect(screen.getByText("Automatic top-ups")).toBeInTheDocument();
  });

  click(screen.getByText("Custom"));
  await fill(screen.getByLabelText("Custom dollar amount"), "35");
  expect(screen.getByText("Quick buy $35.00")).toBeInTheDocument();

  click(screen.getByText("Quick buy $35.00"));

  await waitFor(() => {
    expect(window.location.href).toBe(
      "https://billing.stripe.com/checkout/credit-purchase",
    );
  });
  expect(billingStory.creditCheckoutRequest()).toMatchObject({
    credits: 35_000,
    customAmount: true,
  });
  expect(billingStory.creditCheckoutRequest()).not.toHaveProperty(
    "previewExistingBilling",
  );
  expect(
    screen.queryByRole("dialog", { name: "Review credit purchase" }),
  ).not.toBeInTheDocument();
});

test("Save automatic credit top-ups", async () => {
  mockBillingStory();
  await openBillingTab("/?settings=billing");

  await waitFor(() => {
    expect(screen.getByText("Pro plan")).toBeInTheDocument();
    expect(screen.getByText("Automatic top-ups")).toBeInTheDocument();
  });

  click(screen.getByLabelText("Enable auto-recharge"));
  await fill(
    screen.getByLabelText("Credit threshold for auto-recharge"),
    "2000",
  );
  await fill(
    screen.getByLabelText("Auto-recharge credit amount in credits"),
    "10000",
  );

  await waitFor(() => {
    expect(screen.getByTestId("auto-recharge-unsaved-bar")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
  });

  click(screen.getByTestId("save-button"));

  await waitFor(() => {
    expect(
      screen.queryByTestId("auto-recharge-unsaved-bar"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Enable auto-recharge")).toBeChecked();
    expect(
      screen.getByLabelText("Credit threshold for auto-recharge"),
    ).toHaveValue("2000");
    expect(
      screen.getByLabelText("Auto-recharge credit amount in credits"),
    ).toHaveValue("10000");
    expect(screen.getByText("$10.00")).toBeInTheDocument();
  });
});
