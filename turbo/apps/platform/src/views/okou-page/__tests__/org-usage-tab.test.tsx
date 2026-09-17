import type { OrgMembersResponse } from "@okouai/api-contracts/contracts/org-members";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { usageMembersContract } from "@okouai/api-contracts/contracts/usage";
import type { UsageRecordRange } from "@okouai/api-contracts/contracts/usage-record";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";

import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();
const MOCK_NOW = "2026-03-01T01:00:00Z";
const SHORT_ALLOWANCE_RESET = "2026-03-01T05:00:00Z";
const WEEKLY_ALLOWANCE_RESET = "2026-03-08T00:00:00Z";

// Mirrors the allowance formatter: a window resetting today shows the clock,
// a later one shows the day.
function expectedAllowanceResetText(value: string): string {
  const date = new Date(value);
  const resetsToday = date.toDateString() === new Date(MOCK_NOW).toDateString();
  const formatted = new Intl.DateTimeFormat(
    "en-US",
    resetsToday
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  ).format(date);
  return `Resets ${formatted}`;
}

function mockBillingStatus(
  overrides: Partial<BillingStatusResponse> = {},
): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      showUsagePack: false,
      tier: "pro",
      ...billingPlanCapabilities("pro"),
      credits: 12_000,
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
          credits: 8000,
        },
        {
          category: "payAsYouGo",
          label: "Purchased credits",
          credits: 4000,
        },
      ],
      creditGrants: [
        {
          id: "grant-pro",
          source: "subscription",
          label: "March Pro credits",
          amount: 10_000,
          remaining: 8000,
          createdAt: "2026-03-01T00:00:00Z",
          expiresAt: "2026-04-01T00:00:00Z",
        },
      ],
      usageAllowance: {
        windows: [
          {
            kind: "short",
            windowSeconds: 18_000,
            unitLimit: 5000,
            consumedUnits: 1250,
            remainingUnits: 3750,
            startsAt: "2026-03-01T00:00:00Z",
            expiresAt: SHORT_ALLOWANCE_RESET,
          },
          {
            kind: "weekly",
            windowSeconds: 604_800,
            unitLimit: 50_000,
            consumedUnits: 10_000,
            remainingUnits: 40_000,
            startsAt: "2026-03-01T00:00:00Z",
            expiresAt: WEEKLY_ALLOWANCE_RESET,
          },
        ],
      },
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
      ...overrides,
    });
  });
}

interface UsageStoryRequests {
  readonly teamUsageRanges: UsageRecordRange[];
}

function mockUsageStory(): UsageStoryRequests {
  const requests: UsageStoryRequests = { teamUsageRanges: [] };
  const orgMembers: OrgMembersResponse = {
    name: "Test Org",
    role: "admin",
    createdAt: "2026-01-01T00:00:00Z",
    members: [
      {
        userId: "test-user-123",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Admin",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00Z",
      },
      {
        userId: "user-bob",
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Member",
        imageUrl: "",
        role: "member",
        joinedAt: "2026-01-02T00:00:00Z",
      },
    ],
    pendingInvitations: [],
    membershipRequests: [],
  };
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockBillingStatus();
  context.mocks.api(orgMembersContract.members, ({ respond }) => {
    return respond(200, orgMembers);
  });
  context.mocks.api(usageMembersContract.get, ({ query, respond }) => {
    requests.teamUsageRanges.push(query.range);
    const lastSevenDays = query.range === "7d";
    const aliceModelCredits = lastSevenDays ? 6100 : 6000;
    const bobModelCredits = lastSevenDays ? 2200 : 2100;
    return respond(200, {
      period: {
        start: "2026-03-01T00:00:00Z",
        end: "2026-04-01T00:00:00Z",
      },
      members: [
        {
          userId: "test-user-123",
          email: "alice@example.com",
          inputTokens: 12_000,
          outputTokens: 3000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          creditsCharged: aliceModelCredits + 1500,
          breakdown: [
            {
              kind: "model",
              credits: aliceModelCredits,
              providers: [
                {
                  provider: "gpt-5.6-sol",
                  credits: aliceModelCredits,
                  usageKinds: [{ kind: "model", credits: aliceModelCredits }],
                },
              ],
            },
            {
              kind: "connector",
              credits: 1500,
              providers: [
                {
                  provider: "x",
                  credits: 1500,
                  usageKinds: [{ kind: "connector", credits: 1500 }],
                },
              ],
            },
          ],
        },
        {
          userId: "user-bob",
          email: "bob@example.com",
          inputTokens: 8000,
          outputTokens: 1200,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          creditsCharged: bobModelCredits,
          breakdown: [
            {
              kind: "model",
              credits: bobModelCredits,
              providers: [
                {
                  provider: "gpt-5.6-luna",
                  credits: bobModelCredits,
                  usageKinds: [{ kind: "model", credits: bobModelCredits }],
                },
              ],
            },
          ],
        },
      ],
    });
  });
  return requests;
}

async function openCreditBalance(): Promise<void> {
  await setupPage({
    context,
    path: "/?settings=usage",
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Credit balance")[0]).toBeInTheDocument();
  });
}

async function openCreditUsage(teamUsageBreakdown = true): Promise<void> {
  await setupPage({
    context,
    path: "/?settings=usage-records",
    featureSwitches: {
      [FeatureSwitchKey.TeamUsageBreakdown]: teamUsageBreakdown,
    },
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Credit usage")[0]).toBeInTheDocument();
  });
}

function selectTeamUsage(): void {
  const teamUsageTab = queryAllByRoleFast("tab").find((element) => {
    return element.textContent === "Team usage";
  });
  if (!teamUsageTab) {
    throw new Error("Team usage tab not found");
  }
  click(teamUsageTab);
}

beforeEach(() => {
  mockNow(new Date(MOCK_NOW), context.signal);
});

test("Review workspace credit balance, allowances, and additions", async () => {
  mockUsageStory();
  await openCreditBalance();

  await waitFor(() => {
    expect(screen.getByText("12,000")).toBeInTheDocument();
  });
  const allowance = screen.getByTestId("usage-allowance-section");
  expect(allowance).toBeInTheDocument();
  expect(screen.getByText("Usage allowance")).toBeInTheDocument();
  expect(screen.getByText("5h")).toBeInTheDocument();
  expect(screen.getByText("1w")).toBeInTheDocument();
  expect(screen.getByText("3,750 left")).toBeInTheDocument();
  expect(screen.getByText("40,000 left")).toBeInTheDocument();
  expect(
    screen.getByText(expectedAllowanceResetText(SHORT_ALLOWANCE_RESET)),
  ).toBeInTheDocument();
  expect(
    screen.getByText(expectedAllowanceResetText(WEEKLY_ALLOWANCE_RESET)),
  ).toBeInTheDocument();
  expect(within(allowance).getAllByRole("progressbar")).toHaveLength(2);

  // The compact additions table keeps only the three values needed for
  // scanning; source and expiry details are available from each row tooltip.
  const grants = screen.getByTestId("credit-grants-section");
  expect(within(grants).getByText("Date")).toBeInTheDocument();
  expect(within(grants).getByText("Credits")).toBeInTheDocument();
  expect(within(grants).getByText("Left")).toBeInTheDocument();
  expect(within(grants).getByText("Mar 1, 2026")).toBeInTheDocument();
  expect(within(grants).getByText("+10,000")).toBeInTheDocument();
  expect(within(grants).getByText("8,000")).toBeInTheDocument();
  expect(within(grants).queryByText("March Pro credits")).toBeNull();
  expect(screen.queryByTestId("credit-grants-toggle")).toBeNull();
  expect(screen.queryByText("Pro credits")).toBeNull();
  expect(screen.queryByText("Purchased credits")).toBeNull();

  // Usage records moved to their own section.
  expect(screen.queryByText("Team usage")).toBeNull();
});

test("Move from workspace credit balance to usage records", async () => {
  mockUsageStory();
  await openCreditBalance();

  await waitFor(() => {
    expect(screen.getByTestId("credit-balance-see-usage")).toBeInTheDocument();
  });
  click(screen.getByTestId("credit-balance-see-usage"));

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Credit usage" }),
    ).toBeInTheDocument();
  });
  expect(screen.queryByTestId("usage-records-see-balance")).toBeNull();
});

test("Buy credits from the workspace balance", async () => {
  mockUsageStory();
  await openCreditBalance();

  await waitFor(() => {
    expect(
      screen.getByTestId("credit-balance-buy-credits"),
    ).toBeInTheDocument();
  });
  click(screen.getByTestId("credit-balance-buy-credits"));

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Billing" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Buy credits" }),
    ).toBeInTheDocument();
  });
});

test("Hide Buy credits from an ineligible workspace", async () => {
  mockUsageStory();
  mockBillingStatus({ canBuyCredits: false });
  await openCreditBalance();

  await waitFor(() => {
    expect(screen.getByTestId("credit-grants-section")).toBeInTheDocument();
  });
  expect(screen.queryByTestId("credit-balance-buy-credits")).toBeNull();
});

test("Explain the composition of a workspace credit balance", async () => {
  const user = userEvent.setup();
  mockUsageStory();
  mockBillingStatus({
    creditBreakdown: [
      {
        category: "payAsYouGo",
        label: "Purchased credits",
        credits: 12_000,
      },
    ],
  });
  await openCreditBalance();

  const segment = await screen.findByTestId(
    "credit-balance-segment-payAsYouGo",
  );
  await user.hover(segment);
  await expect(
    screen.findByText("Purchased credits — 12,000"),
  ).resolves.toBeInTheDocument();
});

test("Review credit usage by workspace member and period", async () => {
  const user = userEvent.setup();
  const requests = mockUsageStory();
  await openCreditUsage();

  selectTeamUsage();
  await waitFor(() => {
    expect(screen.getByText("Alice Admin")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });
  expect(screen.getByText("7,500")).toBeInTheDocument();
  expect(screen.getByText("2,100")).toBeInTheDocument();
  expect(requests.teamUsageRanges).toContain("billingPeriod");
  expect(
    screen.getByTestId("member-usage-kind-test-user-123-model"),
  ).toBeInTheDocument();
  expect(
    screen.getByTestId("member-usage-kind-test-user-123-connector"),
  ).toBeInTheDocument();
  expect(
    screen.getByTestId("member-usage-kind-user-bob-model"),
  ).toBeInTheDocument();

  const modelSegment = screen.getByTestId(
    "member-usage-kind-test-user-123-model",
  );
  await user.hover(modelSegment);
  await expect(
    screen.findByText("Models - 6,000"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("GPT 5.6 Sol")).toBeInTheDocument();
  await user.unhover(modelSegment);

  click(screen.getByText("Billing period"));
  click(await screen.findByText("Last 7 days"));
  await waitFor(() => {
    expect(requests.teamUsageRanges.at(-1)).toBe("7d");
    expect(screen.getByText("7,600")).toBeInTheDocument();
    expect(screen.getByText("2,200")).toBeInTheDocument();
  });

  await user.hover(screen.getByTestId("member-usage-kind-test-user-123-model"));
  await expect(
    screen.findByText("Models - 6,100"),
  ).resolves.toBeInTheDocument();
});

test("Hide member breakdowns while their rollout switch is off", async () => {
  mockUsageStory();
  await openCreditUsage(false);

  selectTeamUsage();
  await expect(screen.findByText("Alice Admin")).resolves.toBeInTheDocument();
  expect(screen.getByText("7,500")).toBeInTheDocument();
  expect(
    screen.queryByTestId("member-usage-kind-test-user-123-model"),
  ).not.toBeInTheDocument();
});
