import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  createSidebarAccountHelpers,
  openAccountMenu,
} from "./sidebar-account-test-helpers.ts";

const context = testContext();
const {
  mockAdminAccountSidebar,
  mockAdminBillingStatus,
  mockMemberAccountSidebar,
} = createSidebarAccountHelpers(context);

test("Show a member’s latest package credits in the account menu", async () => {
  mockMemberAccountSidebar();
  let usagePackCredits = 20_400;
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      tier: "pro",
      ...billingPlanCapabilities("pro"),
      showUsagePack: true,
      credits: 12_500,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
    });
  });
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: usagePackCredits,
      purchasedCredits: Math.max(0, usagePackCredits - 400),
      bonusCredits: 400,
      creditGrants: [],
    });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });
  const menu = await openAccountMenu();
  const usagePackItem = await within(menu).findByTestId(
    "account-menu-credit-balance",
  );
  expect(within(usagePackItem).getByText("20,400 credits")).toBeInTheDocument();
  expect(within(menu).queryByText("32,900 credits")).toBeNull();

  usagePackCredits = 500;
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  const refreshedMenu = await openAccountMenu();
  const refreshedUsagePackItem = await within(refreshedMenu).findByTestId(
    "account-menu-credit-balance",
  );
  await waitFor(() => {
    expect(
      within(refreshedUsagePackItem).getByText("500 credits"),
    ).toBeInTheDocument();
  });

  click(refreshedUsagePackItem);

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Credit balance" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("usage-pack-credit-card")).toBeInTheDocument();
  });
});

test("Combine workspace and member-package credits for administrators", async () => {
  mockAdminAccountSidebar();
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      creditGrants: [],
    });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();
  const creditItem = await within(menu).findByTestId(
    "account-menu-credit-balance",
  );
  expect(within(creditItem).getByText("32,900 credits")).toBeInTheDocument();
  expect(within(menu).queryByText("12,500 credits")).toBeNull();
  expect(within(menu).queryByText("20,400 credits")).toBeNull();
});

test.each([
  [-23_000, 50_000, "50,000 credits"],
  [-23_000, 0, "0 credits"],
])(
  "Organization debt %i does not cancel %i prepaid member credits",
  async (orgCredits, packCredits, label) => {
    mockAdminAccountSidebar();
    mockAdminBillingStatus(orgCredits);
    context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
      return respond(200, {
        totalCredits: packCredits,
        purchasedCredits: packCredits,
        bonusCredits: 0,
        creditGrants: [],
      });
    });
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      auth: {
        user: {
          id: "test-user-123",
          fullName: "Alex Rivera",
          email: "alex.rivera@example.test",
        },
      },
    });
    const menu = await openAccountMenu();
    const creditItem = await within(menu).findByTestId(
      "account-menu-credit-balance",
    );
    await waitFor(() => {
      expect(creditItem).toHaveTextContent(label);
    });
  },
);

test("Export account data from the account menu", async () => {
  mockAdminAccountSidebar();
  const openMock = context.mocks.browser.open(null);

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();

  await waitFor(() => {
    expect(within(menu).getByText("12,500 credits")).toBeInTheDocument();
    expect(within(menu).getByText("Export data")).toBeInTheDocument();
  });

  click(within(menu).getByText("Export data"));

  await waitFor(() => {
    expect(
      openMock.calls.some((call) => {
        return call.url?.endsWith("/export") ?? false;
      }),
    ).toBeTruthy();
  });
});

test("Open workspace Credit balance from the account menu", async () => {
  mockAdminAccountSidebar();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();

  await waitFor(() => {
    expect(within(menu).getByText("12,500 credits")).toBeInTheDocument();
  });

  click(within(menu).getByText("12,500 credits"));

  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Credit balance" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("credit-balance-info")).toBeInTheDocument();
    expect(screen.getByText("12,500")).toBeInTheDocument();
  });
});
