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
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import { pathname } from "../../../signals/location.ts";

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
): UsageRecordRequestLog {
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

test.each(["admin", "member"] as const)(
  "Show a zero usage pack balance for a free %s without a package",
  async (role) => {
    mockPersonalUsageStory(usageRows(), "limited-free-1", true, role);

    await openUsageSettings();

    const card = await screen.findByTestId("usage-pack-credit-card");
    await expect(
      within(card).findByText("Usage pack credits"),
    ).resolves.toBeInTheDocument();
    expect(within(card).getByText("0")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryAllByTestId("credit-balance-info")).toHaveLength(
        role === "admin" ? 1 : 0,
      );
    });
    expect(
      within(card).queryByText("Configure member packages"),
    ).not.toBeInTheDocument();
  },
);

test.each(["limited-free-1", "pro"] as const)(
  "Show bonus credits and hide package configuration when the capability is disabled for %s",
  async (tier) => {
    mockPersonalUsageStory();
    mockBillingStatus(tier, false);
    context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
      return respond(200, {
        totalCredits: 1000,
        purchasedCredits: 0,
        bonusCredits: 1000,
        creditGrants: [],
        hasUsagePack: false,
      });
    });

    await openUsageSettings();
    await expect(
      screen.findByTestId("credit-balance-info"),
    ).resolves.toBeInTheDocument();
    const card = await screen.findByTestId("usage-pack-credit-card");
    await expect(within(card).findByText("1,000")).resolves.toBeInTheDocument();
    expect(within(card).getByText("Usage pack credits")).toBeInTheDocument();
    expect(
      within(card).queryByText("Configure member packages"),
    ).not.toBeInTheDocument();
  },
);

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
  expect(screen.queryByLabelText("Slack")).not.toBeInTheDocument();
  expect(screen.getAllByLabelText("Thread").length).toBeGreaterThan(0);
  expect(requests.ranges).toContain("today");

  await user.hover(screen.getByTestId("usage-kind-segment-connector"));
  await screen.findByText("Connectors - 1,080");
  await waitFor(() => {
    expect(screen.getByText("Data Search").parentElement).toHaveTextContent(
      "Data Search1,080",
    );
    expect(
      screen.queryByText("qwen/qwen-2.5-7b-instruct"),
    ).not.toBeInTheDocument();
  });

  await user.unhover(screen.getByTestId("usage-kind-segment-connector"));
  await user.hover(screen.getByTestId("usage-kind-segment-other"));
  await screen.findByText("Other - 3");
  expect(screen.getByText("Translation").parentElement).toHaveTextContent(
    "Translation3",
  );

  click(screen.getByText("Today"));
  click(await screen.findByText("Last 7 days"));

  await waitFor(() => {
    expect(screen.getByText("Last 7 days")).toBeInTheDocument();
    expect(requests.ranges).toContain("7d");
  });
});

test.each(["click", "Enter"])(
  "Usage links keep Settings open for browser activations and close on %s",
  async (activation) => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000001";
    mockPersonalUsageStory([
      usageRow({
        title: "Planning conversation",
        credits: 100,
        runId: threadId,
      }),
    ]);
    context.mocks.browser.open();
    await openUsageSettings("usage-records");
    const link = await screen.findByText("Planning conversation");
    expect(link).toHaveAttribute("href", `/chats/${threadId}`);
    const initialPath = pathname();

    for (const modifier of ["Alt", "Control", "Meta", "Shift"]) {
      await user.keyboard(`{${modifier}>}`);
      await user.click(link);
      await user.keyboard(`{/${modifier}}`);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(pathname()).toBe(initialPath);
    }
    for (const keys of ["[MouseMiddle]", "[MouseRight]"]) {
      await user.pointer({ target: link, keys });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(pathname()).toBe(initialPath);
    }

    if (activation === "Enter") {
      link.focus();
      await user.keyboard("{Enter}");
    } else {
      click(link);
    }
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${threadId}`);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  },
);

test("Merge historical data and new enrichment into Connectors without double counting credits", async () => {
  const user = userEvent.setup();
  mockPersonalUsageStory([
    {
      ...usageRow({
        title: "Social platform research",
        credits: 143,
        runId: "run-social-platform-research",
      }),
      breakdown: [
        {
          kind: "other",
          credits: 114,
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
            {
              provider: "monid/dy",
              credits: 2,
              usageKinds: [{ kind: "social", credits: 2 }],
            },
            {
              provider: "monid/weibo",
              credits: 3,
              usageKinds: [{ kind: "social", credits: 3 }],
            },
            {
              provider: "dataforseo",
              credits: 15,
              usageKinds: [
                { kind: "commerce", credits: 9 },
                {
                  kind: "commerce/dataforseo/provider_cost_usd_micros",
                  credits: 6,
                },
              ],
            },
            {
              provider: "unknown",
              credits: 8,
              usageKinds: [{ kind: "legacy-data", credits: 8 }],
            },
            {
              provider: "apidojo",
              credits: 7,
              usageKinds: [{ kind: "finance", credits: 7 }],
            },
            {
              provider: "google-maps",
              credits: 5,
              usageKinds: [{ kind: "maps", credits: 5 }],
            },
            {
              provider: "monid/apollo",
              credits: 9,
              usageKinds: [
                {
                  kind: "data-search/monid/apollo/provider_cost_usd_micros",
                  credits: 9,
                },
              ],
            },
          ],
        },
        {
          kind: "connector",
          credits: 19,
          providers: [
            {
              provider: "dataforseo",
              credits: 4,
              usageKinds: [{ kind: "commerce", credits: 4 }],
            },
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
  expect(screen.getAllByText("143").length).toBeGreaterThanOrEqual(1);

  const connectorSegment = screen.getByTestId("usage-kind-segment-connector");
  await user.hover(connectorSegment);
  const heading = await screen.findByText("Connectors - 125");
  const details = heading.parentElement;
  if (!details) {
    throw new Error("Connector usage details not found");
  }
  for (const [label, credits] of [
    // The X connector stays separate from Data Search.
    ["X", "12"],
    ["Data Search", "110"],
    ["Slack", "3"],
  ]) {
    expect(within(details).getByText(label).parentElement).toHaveTextContent(
      `${label}${credits}`,
    );
  }

  await user.unhover(connectorSegment);
  await user.hover(screen.getByTestId("usage-kind-segment-other"));
  await screen.findByText("Other - 8");
  expect(screen.getByText("Legacy Data").parentElement).toHaveTextContent(
    "Legacy Data8",
  );

  await user.unhover(screen.getByTestId("usage-kind-segment-other"));
  await user.hover(screen.getByTestId("usage-kind-segment-model"));
  await screen.findByText("Models - 10");
  expect(screen.getByText("GPT 5.6 Sol").parentElement).toHaveTextContent(
    "GPT 5.6 Sol10",
  );
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

test("Personal billing merges model aliases and historical Auto presets without changing totals", async () => {
  mockPersonalUsageStory([
    {
      threadId: "thread-model-aliases",
      title: "Model usage history",
      credits: 60,
      tokens: 1200,
      member: null,
      lastActivityAt: "2026-03-21T10:00:00Z",
      breakdown: [
        {
          kind: "model",
          credits: 60,
          providers: [
            {
              provider: "gpt-6-luna",
              credits: 10,
              usageKinds: [{ kind: "model", credits: 10 }],
            },
            {
              provider: "openai/gpt-6-luna",
              credits: 20,
              usageKinds: [{ kind: "model", credits: 20 }],
            },
            {
              provider: "okou-1.0",
              credits: 5,
              usageKinds: [{ kind: "model", credits: 5 }],
            },
            {
              provider: "@preset/removed-history",
              credits: 25,
              usageKinds: [{ kind: "model", credits: 25 }],
            },
          ],
        },
      ],
    },
  ]);
  await openUsageSettings("usage-records");
  await screen.findByText("Model usage history");
  const user = userEvent.setup();
  await user.hover(screen.getByTestId("usage-kind-segment-model"));
  await expect(screen.findByText("Models - 60")).resolves.toBeInTheDocument();
  expect(screen.getByText("GPT 6 Luna").parentElement).toHaveTextContent(
    "GPT 6 Luna30",
  );
  expect(screen.getByText("Auto").parentElement).toHaveTextContent("Auto30");
  expect(screen.queryByText(/@preset\//u)).not.toBeInTheDocument();
});
