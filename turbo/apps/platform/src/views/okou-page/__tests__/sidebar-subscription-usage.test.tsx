import {
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  connectedPersonalClaudeCodeProvider,
  connectedPersonalCodexProvider,
  createSidebarAccountHelpers,
  expectVisibleText,
  formatResetInTimeZone,
  mockBrowserTimeZone,
  openAccountMenu,
} from "./sidebar-account-test-helpers.ts";

const context = testContext();
const { mockAdminAccountSidebar } = createSidebarAccountHelpers(context);

test("Hide subscription usage when the account-menu feature is off", async () => {
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([
    connectedPersonalCodexProvider(),
    connectedPersonalClaudeCodeProvider(),
  ]);

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
  expect(
    within(menu).queryByTestId("account-menu-subscriptions"),
  ).not.toBeInTheDocument();
});

test("Review personal subscription usage in the account menu", async () => {
  const user = userEvent.setup();
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([
    connectedPersonalCodexProvider({
      subscriptionResetCreditsNextExpiresAt: "2030-01-04T00:48:00.000Z",
      subscriptionCredits: { balance: 1250.5, unlimited: false },
    }),
    connectedPersonalClaudeCodeProvider(),
  ]);

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
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });

  const menu = await openAccountMenu();
  const panel = await within(menu).findByTestId("account-menu-subscriptions");

  const codex = within(panel).getByRole("region", { name: "ChatGPT usage" });
  const claude = within(panel).getByRole("region", { name: "Claude usage" });
  expect(
    within(codex).getByRole("heading", { name: "ChatGPT" }),
  ).toBeInTheDocument();
  expect(
    within(claude).getByRole("heading", { name: "Claude" }),
  ).toBeInTheDocument();
  expect(within(codex).getAllByRole("meter")).toHaveLength(1);
  expect(within(claude).getAllByRole("meter")).toHaveLength(2);
  expect(within(codex).getByText("55% left")).toBeInTheDocument();
  expect(within(claude).getByText("88% left")).toBeInTheDocument();
  expect(within(claude).getByText("76% left")).toBeInTheDocument();
  expect(within(panel).queryByText("Credits")).not.toBeInTheDocument();
  expect(within(panel).queryByText("Reset usage")).not.toBeInTheDocument();
  expect(within(panel).queryByText(/Resets in /)).not.toBeInTheDocument();

  // Keyboard focus exposes details for the entire information block.
  const codexInformation = within(codex).getByLabelText("ChatGPT usage");
  await user.keyboard("ChatGPT");
  expect(codexInformation).toHaveFocus();
  await waitFor(() => {
    expectVisibleText("Resets in 5d 23h");
    expectVisibleText(
      formatResetInTimeZone("2030-01-07T00:00:00.000Z", "America/New_York"),
    );
  });
  await user.keyboard("{ArrowDown}");
  expect(within(claude).getByLabelText("Claude usage")).toHaveFocus();
  // The heading is part of the hover target, alongside both Claude meters.
  await user.hover(within(claude).getByRole("heading", { name: "Claude" }));
  await waitFor(() => {
    expectVisibleText(
      formatResetInTimeZone("2030-01-01T05:00:00.000Z", "America/New_York"),
    );
    expectVisibleText(
      formatResetInTimeZone("2030-01-07T00:00:00.000Z", "America/New_York"),
    );
  });
  click(within(claude).getByLabelText("Claude usage"));
  expect(menu).toBeInTheDocument();
  await user.keyboard("{ArrowDown}");
  await waitFor(() => {
    expect(screen.queryByText("Resets in 4h 12m")).not.toBeInTheDocument();
  });
  await user.keyboard("{Escape}");
  const accountTrigger = queryAllByRoleFast("button").find((button) => {
    return (
      (button.getAttribute("aria-label") ?? button.textContent)?.trim() ===
      "Alex Rivera"
    );
  });
  await waitFor(() => {
    expect(accountTrigger).toHaveAttribute("aria-expanded", "false");
    expect(accountTrigger).toHaveFocus();
  });
});

test.each<{
  name: string;
  credits: ModelProviderResponse["subscriptionCredits"];
  expected: string;
}>([
  { name: "zero", credits: { balance: 0, unlimited: false }, expected: "0" },
  { name: "unavailable", credits: null, expected: "—" },
  {
    name: "unlimited",
    credits: { balance: null, unlimited: true },
    expected: "Unlimited",
  },
  {
    name: "small positive",
    credits: { balance: 0.0001, unlimited: false },
    expected: "< 0.01",
  },
])(
  "Show $name provider credits when weekly usage is exhausted",
  async ({ credits, expected }) => {
    mockAdminAccountSidebar();
    context.mocks.browser.languages(["zh-CN"]);
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider({
        subscriptionUsage: {
          fiveHour: null,
          weekly: {
            usedPercent: 100,
            remainingPercent: 0,
            resetAt: "2030-01-07T00:00:00.000Z",
            windowSeconds: 604_800,
          },
        },
        subscriptionNextResetAt: null,
        subscriptionResetPeriod: null,
        subscriptionResetCredits: 0,
        subscriptionCredits: credits,
      }),
    ]);
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      locale: "zh-Hans",
      auth: { user: { id: "test-user-123", fullName: "Alex Rivera" } },
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });
    const menu = await openAccountMenu();
    const panel = await within(menu).findByTestId("account-menu-subscriptions");
    // Page tests use en-US copy through the shared locale-resource fixture.
    expect(document.documentElement).toHaveAttribute("lang", "zh-Hans");
    expect(within(panel).getByText("Credits")).toBeInTheDocument();
    expect(within(panel).getByText(expected)).toBeInTheDocument();
    expect(within(menu).getByText("12,500 credits")).toBeInTheDocument();
  },
);

test("Keep ChatGPT summary and actions tied to its weekly limit", async () => {
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([
    connectedPersonalCodexProvider({
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 88,
          remainingPercent: 12,
          resetAt: "2030-01-01T05:00:00.000Z",
          windowSeconds: 18_000,
        },
        weekly: {
          usedPercent: 53,
          remainingPercent: 47,
          resetAt: "2030-01-07T00:00:00.000Z",
          windowSeconds: 604_800,
        },
      },
    }),
    connectedPersonalClaudeCodeProvider(),
  ]);
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
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });

  const menu = await openAccountMenu();
  const panel = await within(menu).findByTestId("account-menu-subscriptions");
  const codex = within(panel).getByRole("region", {
    name: "ChatGPT usage",
  });
  expect(within(codex).getAllByRole("meter")).toHaveLength(1);
  expect(
    within(codex).getByRole("meter", {
      name: "ChatGPT Weekly limit remaining",
    }),
  ).toHaveAttribute("aria-valuenow", "47");
  expect(within(codex).getByText("47% left")).toBeInTheDocument();
  expect(within(codex).queryByText("Reset usage")).not.toBeInTheDocument();
  expect(within(codex).queryByText(/Resets in /)).not.toBeInTheDocument();
});

test("Show an exhausted week with its own reset time", async () => {
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([
    connectedPersonalCodexProvider({
      subscriptionResetCredits: 0,
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetAt: "invalid reset",
          windowSeconds: 18_000,
        },
        weekly: {
          usedPercent: 100,
          remainingPercent: null,
          resetAt: "2030-01-07T00:00:00.000Z",
          windowSeconds: 604_800,
        },
      },
    }),
  ]);
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
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });

  const menu = await openAccountMenu();
  const panel = await within(menu).findByTestId("account-menu-subscriptions");
  const week = within(panel).getByRole("meter", {
    name: "ChatGPT Weekly limit remaining",
  });
  expect(week).toHaveAttribute("aria-valuenow", "0");
  expect(within(panel).getAllByRole("meter")).toHaveLength(1);
  expect(within(panel).getByText("0% left")).toBeInTheDocument();
  expect(within(panel).getByText("Resets in 5d 23h")).toBeInTheDocument();
  expect(within(panel).queryByText("Reset usage")).not.toBeInTheDocument();
  await userEvent.setup().hover(week);
  await waitFor(() => {
    expectVisibleText(
      formatResetInTimeZone("2030-01-07T00:00:00.000Z", "America/New_York"),
    );
  });
});

test("Keep Codex reset pending until refreshed account-menu usage is ready", async () => {
  mockAdminAccountSidebar();
  const refreshStarted = context.mocks.deferred<void>();
  const finishRefresh = context.mocks.deferred<void>();
  let resetCompleted = false;
  context.mocks.api(
    thirdPartySubscriptionsMainContract.list,
    async ({ respond }) => {
      if (resetCompleted) {
        refreshStarted.resolve();
        await finishRefresh.promise;
      }
      return respond(200, {
        subscriptions: [
          connectedPersonalCodexProvider({
            subscriptionResetCredits: resetCompleted ? 1 : 2,
            subscriptionCredits: { balance: 1250.5, unlimited: false },
            subscriptionUsage: {
              fiveHour: null,
              weekly: {
                usedPercent: resetCompleted ? 0 : 100,
                remainingPercent: resetCompleted ? 100 : 0,
                resetAt: "2030-01-07T00:00:00.000Z",
                windowSeconds: 604_800,
              },
            },
          }),
        ],
      });
    },
  );
  context.mocks.api(
    personalModelProvidersByTypeContract.resetSubscriptionUsage,
    ({ respond }) => {
      resetCompleted = true;
      return respond(200, { outcome: "reset" });
    },
  );

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
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });

  let menu = await openAccountMenu();
  let panel = await within(menu).findByTestId("account-menu-subscriptions");
  const resetCredits = within(panel).getByText("Reset usage");
  expect(within(panel).getByText("Credits")).toBeInTheDocument();
  expect(resetCredits).toBeInTheDocument();
  click(resetCredits);

  const confirmDialog = await screen.findByRole("dialog", {
    name: "Reset Codex usage?",
  });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(within(confirmDialog).getByText(/2 resets left/)).toBeInTheDocument();
  const resetButton = queryAllByRoleFast("button", confirmDialog).find(
    (button) => {
      return button.textContent === "Reset usage";
    },
  );
  if (!resetButton) {
    throw new Error("Reset usage button not found");
  }
  click(resetButton);

  await refreshStarted.promise;
  expect(confirmDialog).toBeInTheDocument();
  await waitFor(() => {
    expect(
      queryAllByRoleFast("button", confirmDialog).find((button) => {
        return button.textContent === "Cancel";
      }),
    ).toBeDisabled();
  });
  finishRefresh.resolve();

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Reset Codex usage?" }),
    ).not.toBeInTheDocument();
  });

  menu = await openAccountMenu();
  panel = await within(menu).findByTestId("account-menu-subscriptions");
  expect(within(panel).getByText("100% left")).toBeInTheDocument();
  expect(within(panel).queryByText("Credits")).not.toBeInTheDocument();
  expect(within(panel).queryByText("Reset usage")).not.toBeInTheDocument();
});

test.each([0, null, undefined])(
  "Keep reset unavailable when the reset balance is %s",
  async (resetCredits) => {
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider({
        subscriptionResetCredits: resetCredits,
        subscriptionUsage: {
          fiveHour: null,
          weekly: {
            usedPercent: 100,
            remainingPercent: 0,
            resetAt: "2030-01-07T00:00:00.000Z",
            windowSeconds: 604_800,
          },
        },
      }),
    ]);
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      auth: { user: { id: "test-user-123", fullName: "Alex Rivera" } },
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });
    const menu = await openAccountMenu();
    const panel = await within(menu).findByTestId("account-menu-subscriptions");
    expect(within(panel).queryByText("Reset usage")).not.toBeInTheDocument();
    expect(within(panel).getByText(/Resets in /)).toBeInTheDocument();
  },
);

test.each([null] as const)(
  "Keep an active session open when provider loading remains unauthorized (saved locale: %s)",
  async (locale) => {
    mockAdminAccountSidebar();
    context.mocks.data.userPreferences({ locale });
    const providerResponse = context.mocks.deferred<void>();
    let menuOpened = false;

    context.mocks.api(
      thirdPartySubscriptionsMainContract.list,
      async ({ respond }) => {
        if (menuOpened) {
          await providerResponse.promise;
        }
        return respond(401, {
          error: {
            code: "UNAUTHORIZED",
            message: "Unauthorized",
          },
        });
      },
    );

    await setupPage({
      context,
      path: "/workflows",
      auth: {
        user: {
          id: "test-user-123",
          fullName: "Alex Rivera",
          email: "alex.rivera@example.test",
        },
      },
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });

    const workflows = await screen.findByRole("heading", { name: "Workflows" });
    menuOpened = true;
    const menu = await openAccountMenu();
    const loadingSubscriptions = await within(menu).findByTestId(
      "account-menu-subscriptions",
    );

    providerResponse.resolve();
    await waitForElementToBeRemoved(loadingSubscriptions);
    await expect(
      within(menu).findByText("12,500 credits"),
    ).resolves.toBeInTheDocument();
    expect(workflows).toBeInTheDocument();
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
    expect(mockedClerk.signOut).not.toHaveBeenCalled();
    expect(screen.queryByText("Unauthorized")).not.toBeInTheDocument();

    click(within(menu).getByText("Settings"));
    await expect(
      screen.findByRole("dialog", { name: "Settings" }),
    ).resolves.toBeInTheDocument();
  },
);
