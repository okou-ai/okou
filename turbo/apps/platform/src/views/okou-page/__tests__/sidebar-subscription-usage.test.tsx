import {
  fireEvent,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";

import {
  AGENT_ID,
  connectedPersonalClaudeCodeProvider,
  connectedPersonalCodexProvider,
  context,
  expectVisibleText,
  formatResetInTimeZone,
  mockAdminAccountSidebar,
  mockBrowserTimeZone,
  openAccountMenu,
} from "./sidebar-account-test-helpers.ts";

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

  expect(within(panel).queryByText("Subscriptions")).not.toBeInTheDocument();
  expect(
    within(panel).queryByLabelText("Refresh subscriptions"),
  ).not.toBeInTheDocument();
  expect(
    within(panel).getByRole("heading", { name: "Your ChatGPT plan" }),
  ).toBeInTheDocument();
  expect(
    within(panel).getByRole("heading", { name: "Your Claude plan" }),
  ).toBeInTheDocument();
  // Each plan shows both windows, 5h and Week.
  expect(within(panel).getAllByText("5h")).toHaveLength(2);
  expect(within(panel).getAllByText("Week")).toHaveLength(2);
  expect(within(panel).getByText("82%")).toBeInTheDocument();
  expect(within(panel).getByText("55%")).toBeInTheDocument();
  expect(within(panel).getByText("88%")).toBeInTheDocument();
  expect(within(panel).getByText("76%")).toBeInTheDocument();
  const resetCredits = within(panel).getByLabelText("2 resets left");
  expect(within(resetCredits).getByText("2 resets left")).toBeInTheDocument();
  expect(within(panel).queryByText("Reset")).not.toBeInTheDocument();
  expect(within(panel).queryByText(/Resets in /)).not.toBeInTheDocument();
  expect(
    within(panel).queryByText(/codex\.user@example\.com/),
  ).not.toBeInTheDocument();

  const codexFiveHour = within(panel).getByRole("meter", {
    name: "Your ChatGPT plan 5h remaining",
  });
  expect(codexFiveHour).toHaveAttribute("aria-valuenow", "82");
  const codexWeek = within(panel).getByRole("meter", {
    name: "Your ChatGPT plan Week remaining",
  });
  expect(codexWeek).toHaveAttribute("aria-valuenow", "55");
  fireEvent.focus(codexWeek);

  await waitFor(() => {
    expectVisibleText("Resets in 5d 23h");
    expectVisibleText(
      formatResetInTimeZone("2030-01-07T00:00:00.000Z", "America/New_York"),
    );
  });
  fireEvent.blur(codexWeek);
  await user.hover(resetCredits);
  await waitFor(() => {
    expectVisibleText("2 resets left · expires in 3d");
  });

  const credits = within(menu).getByText("12,500 credits");
  const codex = within(panel).getByRole("heading", {
    name: "Your ChatGPT plan",
  });
  expect(
    codex.compareDocumentPosition(resetCredits) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    resetCredits.compareDocumentPosition(codexFiveHour) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    codexFiveHour.compareDocumentPosition(codexWeek) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    credits.compareDocumentPosition(codex) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test("Show the reset time of a plan that is running low", async () => {
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
    name: "Your ChatGPT plan usage",
  });
  expect(
    within(codex).getByRole("meter", {
      name: "Your ChatGPT plan 5h remaining",
    }),
  ).toHaveAttribute("aria-valuenow", "12");
  expect(within(codex).getByText("12%")).toBeInTheDocument();
  expect(within(codex).getByText("47%")).toBeInTheDocument();
  expect(within(codex).getByText("5h · Resets in 4h 12m")).toBeInTheDocument();
  const claude = within(panel).getByRole("region", {
    name: "Your Claude plan usage",
  });
  expect(within(claude).queryByText(/Resets in /)).not.toBeInTheDocument();
});

test("Show an exhausted week with its own reset time", async () => {
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([
    connectedPersonalCodexProvider({
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
    name: "Your ChatGPT plan Week remaining",
  });
  expect(week).toHaveAttribute("aria-valuenow", "0");
  // An exhausted week also stops the 5h window, and the reset line names the week.
  expect(
    within(panel).getByRole("meter", {
      name: "Your ChatGPT plan 5h remaining",
    }),
  ).toHaveAttribute("aria-valuenow", "0");
  expect(within(panel).getAllByText("0%")).toHaveLength(2);
  expect(
    within(panel).getByText("Week · Resets in 5d 23h"),
  ).toBeInTheDocument();
  await userEvent.setup().hover(week);
  await waitFor(() => {
    expectVisibleText(
      formatResetInTimeZone("2030-01-07T00:00:00.000Z", "America/New_York"),
    );
  });
  expect(screen.queryByText("invalid reset")).not.toBeInTheDocument();
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
  const resetCredits = within(panel).getByLabelText("2 resets left");
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
  expect(within(panel).getByLabelText("1 reset left")).toBeInTheDocument();
});

test("Keep exhausted Codex resets disabled in the account menu", async () => {
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([
    connectedPersonalCodexProvider({ subscriptionResetCredits: 0 }),
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
  const resetCredits = within(panel).getByLabelText("0 resets left");
  expect(resetCredits).toHaveAttribute("aria-disabled", "true");

  click(resetCredits);

  expect(menu).toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Reset Codex usage?" }),
  ).not.toBeInTheDocument();
});

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
