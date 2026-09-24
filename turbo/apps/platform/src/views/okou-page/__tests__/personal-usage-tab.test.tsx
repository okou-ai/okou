import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackCreditsContract,
  billingUsagePackManagementContract,
  type UsagePackCreditsResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  usageRecordContract,
  type UsageRecordRange,
  type UsageRecordResponse,
  type UsageRecordRow,
} from "@okouai/api-contracts/contracts/usage-record";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { emptyUsageImg } from "../platform-assets.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

function buttonByAriaLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function usageRows(): UsageRecordRow[] {
  return [
    {
      threadId: "thread-planning",
      title: "Quarterly planning chat",
      credits: 1083,
      tokens: 2200,
      breakdown: [
        {
          kind: "other",
          credits: 1083,
          providers: [
            {
              provider: "firecrawl",
              credits: 180,
              usageKinds: [{ kind: "scrape", credits: 180 }],
            },
            {
              provider: "google-maps",
              credits: 200,
              usageKinds: [{ kind: "maps", credits: 200 }],
            },
            {
              provider: "perplexity",
              credits: 200,
              usageKinds: [
                { kind: "people-search", credits: 80 },
                { kind: "web-search", credits: 120 },
              ],
            },
            {
              provider: "dataforseo",
              credits: 100,
              usageKinds: [{ kind: "seo", credits: 100 }],
            },
            {
              provider: "apidojo",
              credits: 200,
              usageKinds: [{ kind: "finance", credits: 200 }],
            },
            {
              provider: "google-weather",
              credits: 200,
              usageKinds: [{ kind: "weather", credits: 200 }],
            },
            {
              provider: "qwen/qwen-2.5-7b-instruct",
              credits: 3,
              usageKinds: [
                {
                  kind: "translation/qwen/qwen-2.5-7b-instruct/tokens.output",
                  credits: 3,
                },
              ],
            },
          ],
        },
      ],
      member: null,
      lastActivityAt: "2026-03-21T10:00:00Z",
    },
    {
      threadId: "thread-slack-follow-up",
      title: "Slack customer follow-up",
      credits: 2400,
      tokens: 5100,
      breakdown: [],
      member: null,
      lastActivityAt: "2026-03-20T10:00:00Z",
    },
    ...Array.from({ length: 18 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return {
        threadId: `thread-scheduled-${index}`,
        title: `Scheduled digest ${index + 1}`,
        credits: 100 + index,
        tokens: 1000 + index,
        breakdown: [],
        member: null,
        lastActivityAt: `2026-03-${day}T10:00:00Z`,
      } satisfies UsageRecordRow;
    }),
    {
      threadId: "thread-agent-audit",
      title: "Extended agent audit",
      credits: 3100,
      tokens: 7300,
      breakdown: [],
      member: null,
      lastActivityAt: "2026-02-28T10:00:00Z",
    },
  ];
}

function usageRow(args: {
  readonly title: string;
  readonly credits: number;
  readonly runId: string;
}): UsageRecordRow {
  return {
    threadId: args.runId,
    title: args.title,
    credits: args.credits,
    tokens: 1000,
    breakdown: [],
    member: null,
    lastActivityAt: "2026-03-21T10:00:00Z",
  };
}

function mockBillingStatus(
  tier: "limited-free-1" | "pro" = "pro",
  showUsagePack = tier === "pro",
  subscriptionStatus = "active",
): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      tier,
      ...billingPlanCapabilities(tier),
      showUsagePack,
      restrictedBuiltInModels: tier === "limited-free-1",
      credits: 12_500,
      onboardingPaymentPending: false,
      subscriptionStatus,
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: subscriptionStatus === "active",
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
          credits: 10_000,
        },
        {
          category: "promotional",
          label: "Launch bonus",
          credits: 2500,
        },
      ],
      creditGrants: [],
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
    });
  });
}

function mockEmptyUsagePackCredits(): void {
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 0,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
      hasUsagePack: false,
    });
  });
}

interface UsageRecordRequestLog {
  readonly ranges: UsageRecordRange[];
}

function personalUsagePage(
  rows: UsageRecordRow[],
  page: number,
  pageSize: number,
): UsageRecordResponse {
  const offset = (page - 1) * pageSize;
  return {
    period: {
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-04-01T00:00:00.000Z",
    },
    rows: rows.slice(offset, offset + pageSize),
    totalCredits: rows.reduce((sum, row) => {
      return sum + row.credits;
    }, 0),
    pagination: {
      page,
      pageSize,
      total: rows.length,
    },
  };
}

function mockPersonalUsageStory(
  rows: UsageRecordRow[] = usageRows(),
  tier: "limited-free-1" | "pro" = "pro",
  mockUsagePackCredits = true,
  role: "admin" | "member" = "admin",
  failPageOnce: number | null = null,
): UsageRecordRequestLog {
  let failedPage = false;
  const requests: UsageRecordRequestLog = {
    ranges: [],
  };

  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role,
  });
  mockBillingStatus(tier);
  context.mocks.api(usageRecordContract.get, ({ query, respond }) => {
    requests.ranges.push(query.range);
    if (query.page === failPageOnce && !failedPage) {
      failedPage = true;
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Usage page is temporarily unavailable",
        },
      });
    }
    return respond(200, personalUsagePage(rows, query.page, query.pageSize));
  });
  if (mockUsagePackCredits) {
    mockEmptyUsagePackCredits();
  }
  return requests;
}

async function openUsageSettings(
  section: "usage" | "usage-records" = "usage",
): Promise<void> {
  await setupPage({
    context,
    path: `/?settings=${section}`,
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

async function openMemberPackageCredits(): Promise<HTMLElement> {
  mockPersonalUsageStory(usageRows(), "pro", false, "member");
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      hasUsagePack: true,
      creditGrants: [
        {
          id: "grant-purchased",
          grantType: "purchased",
          amount: 25_000,
          remaining: 20_000,
          createdAt: "2026-03-01T00:00:00.000Z",
          expiresAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: "grant-bonus",
          grantType: "bonus",
          amount: 400,
          remaining: 400,
          createdAt: "2026-03-01T00:00:00.000Z",
          expiresAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
  });

  await openUsageSettings();

  const card = await screen.findByTestId("usage-pack-credit-card");
  return card;
}

test("Review your member-package credit balance and grant rows", async () => {
  const card = await openMemberPackageCredits();
  expect(within(card).getByText("Usage pack credits")).toBeInTheDocument();
  expect(
    within(card).getByTestId("usage-pack-credit-purchased"),
  ).toBeInTheDocument();
  expect(
    within(card).getByTestId("usage-pack-credit-bonus"),
  ).toBeInTheDocument();
  const grants = within(card).getByTestId("usage-pack-credit-grants-section");
  expect(within(grants).getByText("Credit additions")).toBeInTheDocument();
  expect(within(grants).getByText("Date")).toBeInTheDocument();
  expect(within(grants).getByText("Credits")).toBeInTheDocument();
  expect(within(grants).getByText("Left")).toBeInTheDocument();
  expect(
    within(card).queryByTestId("usage-pack-credit-grants-toggle"),
  ).toBeNull();
  expect(within(card).getByText("20,400")).toBeInTheDocument();
  expect(within(card).getByText("20,000")).toBeInTheDocument();
  expect(within(grants).getByText("+25,000")).toBeInTheDocument();
  expect(within(grants).getByText("+400")).toBeInTheDocument();
  expect(screen.queryByTestId("credit-balance-info")).toBeNull();
  expect(screen.queryByText("Team usage")).toBeNull();
  expect(screen.queryByText("Today")).toBeNull();
  expect(screen.queryByText("Quarterly planning chat")).toBeNull();
  expect(
    queryAllByRoleFast("button", card).some((button) => {
      return button.textContent?.trim() === "Configure member packages";
    }),
  ).toBeFalsy();
});

test("Show an illustrated empty credit balance when a member has no usage pack", async () => {
  mockPersonalUsageStory(usageRows(), "limited-free-1", false, "member");

  await openUsageSettings();

  const emptyState = await screen.findByTestId("credit-balance-empty");
  expect(emptyState.querySelector("img")).toHaveAttribute("src", emptyUsageImg);
  expect(
    screen.queryByTestId("usage-pack-credit-card"),
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId("credit-balance-info")).not.toBeInTheDocument();
});

test("Hide Usage package controls when the capability is disabled, even with credits", async () => {
  mockPersonalUsageStory();
  mockBillingStatus("pro", false);
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 1000,
      purchasedCredits: 0,
      bonusCredits: 1000,
      creditGrants: [],
      hasUsagePack: true,
    });
  });

  await openUsageSettings();
  await expect(
    screen.findByTestId("credit-balance-info"),
  ).resolves.toBeVisible();
  expect(
    screen.queryByTestId("usage-pack-credit-card"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Configure member packages"),
  ).not.toBeInTheDocument();
});

test("Start package configuration from an empty Atom balance", async () => {
  mockPersonalUsageStory();
  mockBillingStatus("pro", true, "atom_grant");
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No usage pack subscription" },
    });
  });

  await openUsageSettings();
  const card = await screen.findByTestId("usage-pack-credit-card");
  const configureButton = await within(card).findByText(
    "Configure member packages",
  );
  click(configureButton);
  await expect(
    screen.findByRole("heading", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
});

test("Show one-time bonus credits without an active package", async () => {
  mockPersonalUsageStory(usageRows(), "pro", false, "member");
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 10_000,
      purchasedCredits: 0,
      bonusCredits: 10_000,
      creditGrants: [
        {
          id: "grant-atom-bonus",
          grantType: "bonus",
          amount: 10_000,
          remaining: 10_000,
          createdAt: "2026-08-17T03:43:42.000Z",
          expiresAt: "2026-09-17T03:43:37.000Z",
        },
      ],
      hasUsagePack: false,
    });
  });

  await openUsageSettings();

  const card = await screen.findByTestId("usage-pack-credit-card");
  expect(within(card).getByText("Usage pack credits")).toBeInTheDocument();
  expect(
    within(card).getByTestId("usage-pack-credit-bonus"),
  ).toBeInTheDocument();
  expect(within(card).getByText("+10,000")).toBeInTheDocument();
});

test("Configure member packages from personal Credit balance", async () => {
  const user = userEvent.setup();
  mockPersonalUsageStory(usageRows(), "pro", false, "admin");
  context.mocks.data.orgMembers({
    name: "Test Org",
    role: "admin",
    createdAt: "2026-01-01T00:00:00.000Z",
    members: [
      {
        userId: "test-user-123",
        email: "linghan@example.com",
        firstName: "Linghan",
        lastName: "Hu",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    pendingInvitations: [],
    membershipRequests: [],
  });
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      creditGrants: [],
      hasUsagePack: true,
      memberCredits: [],
    });
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      tier: "pro",
      currentPeriodEnd: "2026-04-01T00:00:00.000Z",
      allocations: [
        {
          id: "a99c2cd1-b012-4ba5-952f-3aa9b707d0c6",
          memberId: "test-user-123",
          usagePackUsd: 20,
          currentPeriodEnd: "2026-04-01T00:00:00.000Z",
          pendingChange: null,
        },
      ],
    });
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          totalCredits: 20_400,
        },
      ],
    });
  });

  await openUsageSettings();

  const card = await screen.findByTestId("usage-pack-credit-card");
  const configureButton = queryAllByRoleFast("button", card).find((button) => {
    return button.textContent?.trim() === "Configure member packages";
  });
  if (!configureButton) {
    throw new Error("Configure member packages button not found");
  }
  await user.click(configureButton);

  const configureDialog = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  expect(within(configureDialog).getByText("Step 2 of 3")).toBeInTheDocument();
  expect(
    within(configureDialog).getByRole("combobox", {
      name: "Usage for Test User",
    }),
  ).toHaveTextContent("20,400 credits · 2% off");
});

test("Review every workspace member’s package balance", async () => {
  const user = userEvent.setup();
  mockPersonalUsageStory(usageRows(), "pro", false, "admin");
  context.mocks.data.orgMembers({
    name: "Test Org",
    role: "admin",
    createdAt: "2026-01-01T00:00:00.000Z",
    members: [
      {
        userId: "test-user-123",
        email: "linghan@example.com",
        firstName: "Linghan",
        lastName: "Hu",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        userId: "member-yuma",
        email: "yuma@example.com",
        firstName: "Yuma",
        lastName: null,
        imageUrl: "",
        role: "member",
        joinedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  });
  const linghanCreditGrants = [
    {
      id: "admin-grant-purchased",
      grantType: "purchased",
      amount: 20_000,
      remaining: 20_000,
      createdAt: "2026-03-01T00:00:00.000Z",
      expiresAt: "2026-04-01T00:00:00.000Z",
    },
    {
      id: "admin-grant-bonus",
      grantType: "bonus",
      amount: 400,
      remaining: 400,
      createdAt: "2026-03-01T00:00:00.000Z",
      expiresAt: "2026-04-01T00:00:00.000Z",
    },
  ] satisfies UsagePackCreditsResponse["creditGrants"];
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      creditGrants: linghanCreditGrants,
      hasUsagePack: true,
      memberCredits: [
        {
          memberId: "test-user-123",
          totalCredits: 20_400,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          creditGrants: linghanCreditGrants,
        },
      ],
    });
  });

  await openUsageSettings();

  const card = await screen.findByTestId("usage-pack-credit-card");
  expect(within(card).getByText("Usage pack credits")).toBeInTheDocument();
  expect(within(card).queryByText("Linghan Hu")).toBeNull();
  expect(within(card).queryByText("Yuma")).toBeNull();
  expect(
    within(card).getByTestId("usage-pack-credit-grants-section"),
  ).toBeInTheDocument();

  await user.click(buttonByAriaLabel("View member balances", card));
  const memberDialog = await screen.findByRole("dialog", {
    name: "Member usage pack credits",
  });
  const memberList = within(memberDialog).getByRole("list", {
    name: "Members",
  });
  expect(within(memberList).getByText("Linghan Hu")).toBeInTheDocument();
  expect(
    within(memberList).getByText("linghan@example.com"),
  ).toBeInTheDocument();
  expect(within(memberList).getByText("Yuma")).toBeInTheDocument();
  expect(within(memberList).getByText("yuma@example.com")).toBeInTheDocument();
  expect(
    within(memberList).getByTestId("usage-pack-member-test-user-123-bar"),
  ).toBeInTheDocument();
  expect(
    within(memberList).getByTestId(
      "usage-pack-member-test-user-123-grants-toggle",
    ),
  ).toBeInTheDocument();
  const linghanCard = within(memberList).getByTestId(
    "usage-pack-member-credit-test-user-123",
  );
  expect(linghanCard).toHaveTextContent("20,400");
  const yumaCard = within(memberList).getByTestId(
    "usage-pack-member-credit-member-yuma",
  );
  expect(yumaCard).toHaveTextContent("0");

  await user.click(
    within(memberList).getByTestId(
      "usage-pack-member-test-user-123-grants-toggle",
    ),
  );
  expect(
    within(memberList).getByTestId(
      "usage-pack-member-test-user-123-grants-toggle",
    ),
  ).toHaveAttribute("aria-expanded", "true");
  const expandedRow = await within(memberList).findByTestId(
    "usage-pack-member-test-user-123-grants-expanded-row",
  );
  expect(within(expandedRow).getByText("Date")).toBeInTheDocument();
  expect(within(expandedRow).getByText("Credits")).toBeInTheDocument();
  expect(within(expandedRow).getByText("Left")).toBeInTheDocument();
  const purchaseRecord = within(expandedRow).getByTestId(
    "usage-pack-member-test-user-123-grants-admin-grant-purchased",
  );
  expect(purchaseRecord).toHaveTextContent("Mar 1, 2026");
  expect(purchaseRecord).toHaveTextContent("+20,000");
  expect(purchaseRecord).toHaveTextContent("20,000");
  await user.hover(purchaseRecord);
  await expect(screen.findByText("Purchased")).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Expires Apr 1, 2026"),
  ).resolves.toBeInTheDocument();

  const orgCredits = await screen.findByTestId("credit-balance-info");
  expect(within(orgCredits).getByText("Org credits")).toBeInTheDocument();
  expect(within(orgCredits).getByText("12,500")).toBeInTheDocument();
});

test("Review personal credit-usage records by date range", async () => {
  const user = userEvent.setup();
  const requests = mockPersonalUsageStory();
  await openUsageSettings("usage-records");

  await waitFor(() => {
    expect(screen.getByText("Quarterly planning chat")).toBeInTheDocument();
    expect(screen.getByText("Slack customer follow-up")).toBeInTheDocument();
  });
  expect(screen.getByText("1.1K")).toBeInTheDocument();
  expect(screen.getByText("21 threads")).toBeInTheDocument();
  expect(screen.getByText("Mar 21")).toBeInTheDocument();
  expect(screen.queryByText("Extended agent audit")).not.toBeInTheDocument();
  expect(screen.queryByText("All sources")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Slack")).not.toBeInTheDocument();
  expect(screen.getAllByLabelText("Thread").length).toBeGreaterThan(0);
  expect(requests.ranges).toContain("today");

  await user.hover(screen.getByTestId("usage-kind-segment-other"));

  await waitFor(() => {
    expect(screen.getAllByText("Web Fetch").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Maps").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Web Search").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("People Search").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      screen.getAllByText("People Search").some((element) => {
        return element.parentElement?.textContent === "People Search80";
      }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Web Search").some((element) => {
        return element.parentElement?.textContent === "Web Search120";
      }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("SEO").some((element) => {
        return element.parentElement?.textContent === "SEO100";
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("Finance").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Weather").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Translation").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Firecrawl")).not.toBeInTheDocument();
    expect(screen.queryByText("Google Maps")).not.toBeInTheDocument();
    expect(screen.queryByText("Perplexity")).not.toBeInTheDocument();
    expect(screen.queryByText("Dataforseo")).not.toBeInTheDocument();
    expect(screen.queryByText("Apidojo")).not.toBeInTheDocument();
    expect(screen.queryByText("Google Weather")).not.toBeInTheDocument();
    expect(
      screen.queryByText("qwen/qwen-2.5-7b-instruct"),
    ).not.toBeInTheDocument();
  });

  click(screen.getByText("Today"));
  click(await screen.findByText("Last 7 days"));

  await waitFor(() => {
    expect(screen.getByText("Last 7 days")).toBeInTheDocument();
    expect(requests.ranges).toContain("7d");
  });
});

test("Merge every Social Search vendor into one connector-segment row", async () => {
  const user = userEvent.setup();
  mockPersonalUsageStory([
    {
      ...usageRow({
        title: "Social platform research",
        credits: 90,
        runId: "run-social-platform-research",
      }),
      breakdown: [
        {
          kind: "other",
          credits: 65,
          providers: [
            {
              provider: "monid/x",
              credits: 5,
              usageKinds: [{ kind: "social", credits: 5 }],
            },
            {
              provider: "monid/instagram",
              credits: 7,
              usageKinds: [{ kind: "social", credits: 7 }],
            },
            {
              provider: "monid/tiktok",
              credits: 11,
              usageKinds: [{ kind: "social", credits: 11 }],
            },
            {
              provider: "monid/youtube",
              credits: 13,
              usageKinds: [{ kind: "social", credits: 13 }],
            },
            {
              provider: "monid/facebook",
              credits: 17,
              usageKinds: [{ kind: "social", credits: 17 }],
            },
            {
              provider: "socialkit",
              credits: 12,
              usageKinds: [{ kind: "social", credits: 12 }],
            },
          ],
        },
        {
          kind: "connector",
          credits: 15,
          providers: [
            { provider: "x", credits: 12, usageKinds: [] },
            {
              provider: "slack",
              credits: 3,
              usageKinds: [{ kind: "connector", credits: 3 }],
            },
          ],
        },
        {
          kind: "model",
          credits: 10,
          providers: [{ provider: "gpt-5.6-sol", credits: 10, usageKinds: [] }],
        },
      ],
    },
  ]);
  await openUsageSettings("usage-records");
  await screen.findByText("Social platform research");

  const connectorSegment = screen.getByTestId("usage-kind-segment-connector");
  await user.hover(connectorSegment);
  const heading = await screen.findByText("Connectors - 80");
  const details = heading.parentElement;
  if (!details) {
    throw new Error("Connector usage details not found");
  }
  for (const [label, credits] of [
    // The X connector keeps its own row; every kind "social" vendor merges.
    ["X", "12"],
    ["Social Search", "65"],
    ["Slack", "3"],
  ]) {
    expect(within(details).getByText(label).parentElement).toHaveTextContent(
      `${label}${credits}`,
    );
  }
  expect(within(details).queryByText(/monid/iu)).not.toBeInTheDocument();
  expect(within(details).queryByText(/socialkit/iu)).not.toBeInTheDocument();
  for (const platform of ["Instagram", "TikTok", "YouTube", "Facebook"]) {
    expect(within(details).queryByText(platform)).not.toBeInTheDocument();
  }

  // Every social vendor moved out, so the remaining "other" bucket is empty.
  expect(
    screen.queryByTestId("usage-kind-segment-other"),
  ).not.toBeInTheDocument();
});

test("Refresh all loaded usage pages after billing changes", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockBillingStatus();
  const initialRows = [
    usageRow({
      title: "Initial usage row",
      credits: 100,
      runId: "run-initial",
    }),
    ...Array.from({ length: 19 }, (_, index) => {
      return usageRow({
        title: `Initial usage filler ${index + 1}`,
        credits: 10,
        runId: `run-initial-filler-${index + 1}`,
      });
    }),
    usageRow({
      title: "Initial usage second page",
      credits: 200,
      runId: "run-initial-page-two",
    }),
  ];
  const refreshedRows = [
    usageRow({
      title: "Realtime refreshed usage",
      credits: 450,
      runId: "run-refreshed",
    }),
  ];
  let refreshed = false;
  context.mocks.api(usageRecordContract.get, ({ query, respond }) => {
    const rows = refreshed ? refreshedRows : initialRows;
    const offset = (query.page - 1) * query.pageSize;
    return respond(200, {
      period: {
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-04-01T00:00:00.000Z",
      },
      rows: rows.slice(offset, offset + query.pageSize),
      totalCredits: rows.reduce((sum, row) => {
        return sum + row.credits;
      }, 0),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: rows.length,
      },
    });
  });
  mockEmptyUsagePackCredits();

  await openUsageSettings("usage-records");

  await waitFor(() => {
    expect(screen.getByText("Initial usage row")).toBeInTheDocument();
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });

  click(screen.getByText("Load more"));
  await expect(
    screen.findByText("Initial usage second page"),
  ).resolves.toBeInTheDocument();

  refreshed = true;
  context.mocks.ably.trigger("billing:changed");

  await waitFor(() => {
    expect(screen.getByText("Realtime refreshed usage")).toBeInTheDocument();
    expect(screen.queryByText("Initial usage row")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Initial usage second page"),
    ).not.toBeInTheDocument();
  });
});
