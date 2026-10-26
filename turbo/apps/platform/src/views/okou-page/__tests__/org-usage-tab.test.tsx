import type { OrgMembersResponse } from "@okouai/api-contracts/contracts/org-members";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { usageMembersContract } from "@okouai/api-contracts/contracts/usage";
import type { UsageRecordRange } from "@okouai/api-contracts/contracts/usage-record";
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
                  credits: aliceModelCredits / 2,
                  usageKinds: [
                    { kind: "model", credits: aliceModelCredits / 2 },
                  ],
                },
                {
                  provider: "openai/gpt-5.6-sol",
                  credits: aliceModelCredits / 2,
                  usageKinds: [
                    { kind: "model", credits: aliceModelCredits / 2 },
                  ],
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

async function openCreditUsage(): Promise<void> {
  await setupPage({
    context,
    path: "/?settings=usage-records",
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

async function setupCreditBalanceReview() {
  mockUsageStory();
  await openCreditBalance();
  await waitFor(() => {
    expect(screen.getByText("12,000")).toBeInTheDocument();
  });
}

test("Review workspace credit balance and additions", async () => {
  await setupCreditBalanceReview();
  const balance = screen.getByTestId("credit-balance-info");
  expect(within(balance).getByText("Org credits")).toBeInTheDocument();
  expect(within(balance).getByText("12,000")).toBeInTheDocument();
  const grants = within(balance).getByTestId("credit-grants-section");
  expect(within(grants).getByText("Date")).toBeInTheDocument();
  expect(within(grants).getByText("Credits")).toBeInTheDocument();
  expect(within(grants).getByText("Left")).toBeInTheDocument();
  expect(within(grants).getByText("Mar 1, 2026")).toBeInTheDocument();
  expect(within(grants).getByText("+10,000")).toBeInTheDocument();
  expect(within(grants).getByText("8,000")).toBeInTheDocument();
  expect(within(grants).queryByText("March Pro credits")).toBeNull();
  expect(screen.queryByText("Pro credits")).toBeNull();
  expect(screen.queryByText("Purchased credits")).toBeNull();
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

async function setupTeamCreditUsage() {
  const user = userEvent.setup();
  const requests = mockUsageStory();
  await openCreditUsage();
  selectTeamUsage();
  await waitFor(() => {
    expect(screen.getByText("Alice Admin")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });
  return { requests, user };
}

test("Review credit usage by workspace member", async () => {
  const { requests } = await setupTeamCreditUsage();
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
});

test("Explain a member's model credit usage", async () => {
  const { user } = await setupTeamCreditUsage();
  const modelSegment = screen.getByTestId(
    "member-usage-kind-test-user-123-model",
  );
  await user.hover(modelSegment);
  await expect(
    screen.findByText("Models - 6,000"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("GPT 5.6 Sol").parentElement).toHaveTextContent(
    "GPT 5.6 Sol6,000",
  );
  expect(screen.queryByText("openai/gpt-5.6-sol")).not.toBeInTheDocument();
});

test("Team usage groups historical data and new enrichment while conserving non-model credits", async () => {
  const user = userEvent.setup();
  mockUsageStory();
  context.mocks.api(usageMembersContract.get, ({ respond }) => {
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
          creditsCharged: 84,
          breakdown: [
            {
              kind: "connector",
              credits: 14,
              providers: [
                {
                  provider: "dataforseo",
                  credits: 3,
                  usageKinds: [{ kind: "commerce", credits: 3 }],
                },
                {
                  provider: "monid/apollo",
                  credits: 4,
                  usageKinds: [{ kind: "data-search", credits: 4 }],
                },
                { provider: "slack", credits: 7, usageKinds: [] },
              ],
            },
            {
              kind: "other",
              credits: 60,
              providers: [
                {
                  provider: "monid/dy",
                  credits: 5,
                  usageKinds: [{ kind: "social", credits: 5 }],
                },
                {
                  provider: "monid/weibo",
                  credits: 7,
                  usageKinds: [{ kind: "social", credits: 7 }],
                },
                {
                  provider: "dataforseo",
                  credits: 24,
                  usageKinds: [
                    { kind: "commerce", credits: 11 },
                    {
                      kind: "commerce/dataforseo/provider_cost_usd_micros",
                      credits: 13,
                    },
                  ],
                },
                {
                  provider: "unknown",
                  credits: 14,
                  usageKinds: [{ kind: "legacy-data", credits: 14 }],
                },
                {
                  provider: "apidojo",
                  credits: 2,
                  usageKinds: [{ kind: "finance", credits: 2 }],
                },
                {
                  provider: "google-maps",
                  credits: 3,
                  usageKinds: [{ kind: "maps", credits: 3 }],
                },
                {
                  provider: "monid/apollo",
                  credits: 5,
                  usageKinds: [
                    {
                      kind: "data-search/monid/apollo/provider_cost_usd_micros",
                      credits: 5,
                    },
                  ],
                },
              ],
            },
            {
              kind: "model",
              credits: 10,
              providers: [
                { provider: "gpt-5.6-sol", credits: 10, usageKinds: [] },
              ],
            },
          ],
        },
      ],
    });
  });

  await openCreditUsage();
  selectTeamUsage();
  await screen.findByText("Alice Admin");
  expect(screen.getAllByText("84").length).toBeGreaterThanOrEqual(1);

  const connectorSegment = screen.getByTestId(
    "member-usage-kind-test-user-123-connector",
  );
  await user.hover(connectorSegment);
  const heading = await screen.findByText("Connectors - 60");
  const details = heading.parentElement;
  if (!details) {
    throw new Error("Member connector usage details not found");
  }
  for (const [label, credits] of [
    ["Data Search", "53"],
    ["Slack", "7"],
  ]) {
    expect(within(details).getByText(label).parentElement).toHaveTextContent(
      `${label}${credits}`,
    );
  }

  await user.unhover(connectorSegment);
  const otherSegment = screen.getByTestId(
    "member-usage-kind-test-user-123-other",
  );
  await user.hover(otherSegment);
  await screen.findByText("Other - 14");
  expect(screen.getByText("Legacy Data").parentElement).toHaveTextContent(
    "Legacy Data14",
  );

  await user.unhover(otherSegment);
  await user.hover(screen.getByTestId("member-usage-kind-test-user-123-model"));
  await screen.findByText("Models - 10");
  expect(screen.getByText("GPT 5.6 Sol").parentElement).toHaveTextContent(
    "GPT 5.6 Sol10",
  );
});

test("Review workspace credit usage for the last seven days", async () => {
  const { requests, user } = await setupTeamCreditUsage();
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
