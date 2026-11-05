import { act, screen, waitFor, within } from "@testing-library/react";
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

async function openSubscriptionUsage(): Promise<HTMLElement> {
  const entry = await within(
    screen.getByTestId("labeled-nav-rail"),
  ).findByLabelText(/^Subscription usage/);
  click(entry);
  return screen.findByTestId("account-menu-subscriptions");
}

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
    screen.queryByLabelText(/^Subscription usage/),
  ).not.toBeInTheDocument();
});

test("Open subscriptions by clicking the rail and open Models in Settings", async () => {
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

  const panel = await openSubscriptionUsage();

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

  const entry = within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
    "Subscription usage",
  );
  expect(entry).toHaveAccessibleDescription(
    "ChatGPT: 55% left; Claude: 76% left",
  );
  const codexInformation = within(codex).getByLabelText("ChatGPT usage");
  await user.hover(codexInformation);
  await waitFor(() => {
    expectVisibleText("Resets in 5d 23h");
    expectVisibleText(
      formatResetInTimeZone("2030-01-07T00:00:00.000Z", "America/New_York"),
    );
  });
  await user.hover(within(claude).getByRole("heading", { name: "Claude" }));
  await waitFor(() => {
    expectVisibleText(
      formatResetInTimeZone("2030-01-01T05:00:00.000Z", "America/New_York"),
    );
  });
  click(within(claude).getByLabelText("Claude usage"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(settings).findByRole("heading", { name: "Use more models" }),
  ).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(entry).toHaveFocus();
    expect(entry).toHaveAttribute("aria-expanded", "false");
  });
  expect(
    screen.queryByTestId("account-menu-subscriptions"),
  ).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  await expect(
    screen.findByRole("dialog", { name: "Subscription usage" }),
  ).resolves.toBeInTheDocument();
  expect(entry).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(entry).toHaveFocus();
    expect(entry).toHaveAttribute("aria-expanded", "false");
  });
  await user.keyboard(" ");
  const reopenedPreview = await screen.findByRole("dialog", {
    name: "Subscription usage",
  });
  const chatGpt = within(
    within(reopenedPreview).getByRole("region", { name: "ChatGPT usage" }),
  ).getByLabelText("ChatGPT usage");
  chatGpt.focus();
  expect(chatGpt).toHaveFocus();
  await user.keyboard("{Enter}");
  const reopenedSettings = await screen.findByRole("dialog", {
    name: "Settings",
  });
  await expect(
    within(reopenedSettings).findByRole("heading", { name: "Use more models" }),
  ).resolves.toBeInTheDocument();
});

test.each(["Escape", "Close"])(
  "Keep the usage preview closed after dismissing Settings with %s",
  async (dismiss) => {
    const user = userEvent.setup();
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });

    const entry = await within(
      screen.getByTestId("labeled-nav-rail"),
    ).findByLabelText("Subscription usage");
    await user.click(entry);
    const preview = await screen.findByRole("dialog", {
      name: "Subscription usage",
    });
    click(
      within(
        within(preview).getByRole("region", { name: "ChatGPT usage" }),
      ).getByLabelText("ChatGPT usage"),
    );
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    if (dismiss === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      click(within(settings).getByLabelText("Close"));
    }
    await waitFor(() => {
      expect(entry).toHaveFocus();
      expect(entry).toHaveAttribute("aria-expanded", "false");
    });
    expect(
      screen.queryByTestId("account-menu-subscriptions"),
    ).not.toBeInTheDocument();

    // A fresh keyboard activation still opens the preview.
    act(() => {
      entry.blur();
      entry.focus();
    });
    expect(entry).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    await expect(
      screen.findByTestId("account-menu-subscriptions"),
    ).resolves.toBeInTheDocument();
    expect(entry).toHaveFocus();
  },
);

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
    const panel = await openSubscriptionUsage();
    // Page tests use en-US copy through the shared locale-resource fixture.
    expect(document.documentElement).toHaveAttribute("lang", "zh-Hans");
    expect(within(panel).getByText("Credits")).toBeInTheDocument();
    expect(within(panel).getByText(expected)).toBeInTheDocument();
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

  const panel = await openSubscriptionUsage();
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
  expect(
    within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
      "Subscription usage",
    ),
  ).toHaveAccessibleDescription("ChatGPT: 47% left; Claude: 76% left");
  expect(
    within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
      "Subscription usage",
    ),
  ).toBeInTheDocument();
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

  const panel = await openSubscriptionUsage();
  const week = within(panel).getByRole("meter", {
    name: "ChatGPT Weekly limit remaining",
  });
  expect(week).toHaveAttribute("aria-valuenow", "0");
  expect(within(panel).getAllByRole("meter")).toHaveLength(1);
  expect(within(panel).getByText("0% left")).toBeInTheDocument();
  expect(
    within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
      /^Subscription usage/,
    ),
  ).toHaveAccessibleDescription("ChatGPT: 0% left");
  expect(within(panel).getByText("Resets in 5d 23h")).toBeInTheDocument();
  expect(within(panel).queryByText("Reset usage")).not.toBeInTheDocument();
  await userEvent.setup().hover(week);
  await waitFor(() => {
    expectVisibleText(
      formatResetInTimeZone("2030-01-07T00:00:00.000Z", "America/New_York"),
    );
  });
});

test.each(["Escape", "Cancel"])(
  "Keep the usage preview closed after dismissing reset confirmation with %s",
  async (dismiss) => {
    const user = userEvent.setup();
    mockAdminAccountSidebar();
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
      }),
    ]);
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });

    const panel = await openSubscriptionUsage();
    const entry = within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
      /^Subscription usage/,
    );
    click(within(panel).getByText("Reset usage"));
    const confirmation = await screen.findByRole("dialog", {
      name: "Reset Codex usage?",
    });
    if (dismiss === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      const cancel = queryAllByRoleFast("button", confirmation).find(
        (button) => {
          return button.textContent === "Cancel";
        },
      );
      if (!cancel) {
        throw new Error("Cancel button not found");
      }
      click(cancel);
    }
    await waitFor(() => {
      expect(entry).toHaveFocus();
      expect(entry).toHaveAttribute("aria-expanded", "false");
    });
    expect(
      screen.queryByTestId("account-menu-subscriptions"),
    ).not.toBeInTheDocument();
    click(entry);
    await expect(
      screen.findByTestId("account-menu-subscriptions"),
    ).resolves.toBeInTheDocument();
  },
);

test("Keep Codex reset pending until refreshed sidebar usage is ready", async () => {
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

  let panel = await openSubscriptionUsage();
  const resetCredits = within(panel).getByText("Reset usage");
  expect(within(panel).getByText("Credits")).toBeInTheDocument();
  expect(resetCredits).toBeInTheDocument();
  click(resetCredits);

  const confirmDialog = await screen.findByRole("dialog", {
    name: "Reset Codex usage?",
  });
  expect(
    within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
      /^Subscription usage/,
    ),
  ).toHaveAttribute("aria-expanded", "false");
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
  await waitFor(() => {
    const entry = within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
      /^Subscription usage/,
    );
    expect(entry).toHaveFocus();
    expect(entry).toHaveAttribute("aria-expanded", "false");
  });

  panel = await openSubscriptionUsage();
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
    const panel = await openSubscriptionUsage();
    expect(within(panel).queryByText("Reset usage")).not.toBeInTheDocument();
    expect(within(panel).getByText(/Resets in /)).toBeInTheDocument();
  },
);

test.each([null] as const)(
  "Keep an active session open when provider loading remains unauthorized (saved locale: %s)",
  async (locale) => {
    mockAdminAccountSidebar();
    context.mocks.data.userPreferences({ locale });

    context.mocks.api(
      thirdPartySubscriptionsMainContract.list,
      ({ respond }) => {
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
    const menu = await openAccountMenu();
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

test.each([
  { type: "codex-oauth-token" as const, window: "weekly" as const },
  { type: "claude-code-oauth-token" as const, window: "fiveHour" as const },
  { type: "claude-code-oauth-token" as const, window: "weekly" as const },
])(
  "Warn when $type $window has little remaining usage",
  async ({ type, window }) => {
    mockAdminAccountSidebar();
    const provider =
      type === "codex-oauth-token"
        ? connectedPersonalCodexProvider()
        : connectedPersonalClaudeCodeProvider();
    context.mocks.data.personalModelProviders([
      {
        ...provider,
        subscriptionUsage: {
          fiveHour: null,
          weekly: null,
          ...provider.subscriptionUsage,
          [window]: {
            usedPercent: 88,
            remainingPercent: 12,
            resetAt: "2030-01-07T00:00:00.000Z",
            windowSeconds: 604_800,
          },
        },
      },
    ]);
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });
    const entry = await screen.findByLabelText(
      "Subscription usage: less than 20% remaining",
    );
    click(entry);
    const panel = await screen.findByRole("dialog", {
      name: "Subscription usage",
    });
    expect(within(panel).getByText("12% left")).toBeInTheDocument();
    click(entry);
    await waitFor(() => {
      expect(entry).toHaveAttribute("aria-expanded", "false");
    });
    click(entry);
    await waitFor(() => {
      expect(entry).toHaveAttribute("aria-expanded", "true");
    });
    const reopenedPanel = await screen.findByRole("dialog", {
      name: "Subscription usage",
    });
    const providerLabel =
      type === "codex-oauth-token" ? "ChatGPT usage" : "Claude usage";
    click(
      within(
        within(reopenedPanel).getByRole("region", { name: providerLabel }),
      ).getByLabelText(providerLabel),
    );
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await expect(
      within(settings).findByRole("heading", { name: "Use more models" }),
    ).resolves.toBeInTheDocument();
  },
);

test("Keep the account menu available without a subscription entry", async () => {
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([]);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: { user: { id: "test-user-123", fullName: "Alex Rivera" } },
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });
  const menu = await openAccountMenu();
  await expect(
    within(menu).findByText("12,500 credits"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByLabelText(/^Subscription usage/),
  ).not.toBeInTheDocument();
});

test("Describe connected usage with an unknown percentage without treating it as empty", async () => {
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([
    connectedPersonalClaudeCodeProvider({
      subscriptionUsage: {
        fiveHour: null,
        weekly: {
          usedPercent: null,
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
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });
  const entry = await within(
    screen.getByTestId("labeled-nav-rail"),
  ).findByLabelText("Subscription usage");
  expect(entry).toHaveAccessibleDescription("Claude: —");
  const panel = await openSubscriptionUsage();
  expect(within(panel).getByText("—")).toBeInTheDocument();
});
