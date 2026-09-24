import {
  fireEvent,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import {
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { platformOkouWordmarkLightImg } from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
function connectedPersonalCodexProvider(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000301",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    selectedModel: null,
    workspaceName: "Personal ChatGPT",
    planType: "pro",
    accountEmail: "codex.user@example.com",
    subscriptionResetPeriod: "Weekly",
    subscriptionNextResetAt: "2030-01-07T00:00:00.000Z",
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 18,
        remainingPercent: 82,
        resetAt: "2030-01-01T05:00:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 45,
        remainingPercent: 55,
        resetAt: "2030-01-07T00:00:00.000Z",
        windowSeconds: 604_800,
      },
    },
    subscriptionResetCredits: 2,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
    ...overrides,
  };
}

function connectedPersonalClaudeCodeProvider(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000302",
    type: "claude-code-oauth-token",
    framework: "claude-code",
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    workspaceName: "claude.user@example.com",
    planType: "pro",
    subscriptionResetPeriod: "weekly",
    subscriptionNextResetAt: "2030-01-07T00:00:00.000Z",
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 12,
        remainingPercent: 88,
        resetAt: "2030-01-01T05:00:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 24,
        remainingPercent: 76,
        resetAt: "2030-01-07T00:00:00.000Z",
        windowSeconds: 604_800,
      },
    },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
    ...overrides,
  };
}

function prepareDefaultAgent(targetContext = context): void {
  targetContext.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function linkByText(text: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`${text} link not found`);
  }
  return link;
}

function formatResetInTimeZone(resetAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(resetAt));
}

function mockBrowserTimeZone(timeZone: string): void {
  const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolvedOptions,
    timeZone,
  });
}

function expectVisibleText(text: string): void {
  const matches = screen.getAllByText(text);
  const visibleMatch = matches.find((element) => {
    try {
      expect(element).toBeVisible();
      return true;
    } catch {
      return false;
    }
  });
  expect(visibleMatch).toBeDefined();
}

function accountMenuTrigger(userName = "Alex Rivera"): HTMLElement {
  const rail = screen.queryByTestId("labeled-nav-rail");
  if (rail) {
    return within(rail).getByLabelText(userName);
  }

  const minimalSidebar = document.querySelector(
    '[data-slot="sidebar-expanded"]',
  );
  if (!(minimalSidebar instanceof HTMLElement)) {
    throw new Error("Account menu container not found");
  }
  const accountName = within(minimalSidebar).getByText(userName);
  const button = accountName.closest("button");
  if (!button) {
    throw new Error("Account menu trigger not found");
  }
  return button;
}

function findAccountMenuTrigger(
  userName = "Alex Rivera",
): Promise<HTMLElement> {
  return waitFor(() => {
    return accountMenuTrigger(userName);
  });
}

async function openAccountMenu(): Promise<HTMLElement> {
  const accountButton = await findAccountMenuTrigger();
  click(accountButton);
  return screen.findByRole("menu");
}

function setupAddAccountPage(): Promise<void> {
  prepareDefaultAgent();
  return setupPage({
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
}

interface MockAdminBillingStatusOptions {
  readonly failFirstRequest?: boolean;
  readonly firstRequestGate?: {
    readonly onStarted: () => void;
    readonly waitUntil: Promise<void>;
  };
}

function mockAdminBillingStatus(
  credits: number,
  options: MockAdminBillingStatusOptions = {},
): void {
  let requestCount = 0;
  context.mocks.api(
    billingStatusContract.get,
    async ({ respond, withSignal }) => {
      requestCount += 1;
      if (requestCount === 1 && options.firstRequestGate) {
        options.firstRequestGate.onStarted();
        await withSignal(options.firstRequestGate.waitUntil);
      }
      if (options.failFirstRequest && requestCount === 1) {
        return respond(500, {
          error: {
            message: "Failed to load billing status",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }
      return respond(200, {
        showUsagePack: false,
        tier: "pro",
        ...billingPlanCapabilities("pro"),
        credits,
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
    },
  );
}

function mockAdminAccountSidebar(): void {
  prepareDefaultAgent();
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockAdminBillingStatus(12_500);
}

function mockMemberAccountSidebar(): void {
  prepareDefaultAgent();
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
}

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
    within(panel).getByRole("heading", { name: "Codex" }),
  ).toBeInTheDocument();
  expect(
    within(panel).getByRole("heading", { name: "Claude Code" }),
  ).toBeInTheDocument();
  expect(within(panel).getAllByText("5H")).toHaveLength(2);
  expect(within(panel).getAllByText("Week")).toHaveLength(2);
  expect(within(panel).getByText("82%")).toBeInTheDocument();
  expect(within(panel).getByText("55%")).toBeInTheDocument();
  expect(within(panel).getByText("88%")).toBeInTheDocument();
  expect(within(panel).getByText("76%")).toBeInTheDocument();
  const resetCredits = within(panel).getByLabelText("2 resets left");
  expect(within(resetCredits).getByText("2 resets left")).toBeInTheDocument();
  expect(within(panel).queryByText("Reset")).not.toBeInTheDocument();
  expect(within(panel).queryByText(/^resets /)).not.toBeInTheDocument();
  expect(
    within(panel).queryByText(/codex\.user@example\.com/),
  ).not.toBeInTheDocument();

  const codexFiveHour = within(panel).getByRole("progressbar", {
    name: "Codex 5H remaining",
  });
  expect(codexFiveHour).toHaveAttribute("aria-valuenow", "82");
  fireEvent.focus(codexFiveHour);

  await waitFor(() => {
    expectVisibleText("Resets in 4h 12m");
    expectVisibleText(
      formatResetInTimeZone("2030-01-01T05:00:00.000Z", "America/New_York"),
    );
  });
  fireEvent.blur(codexFiveHour);
  await user.hover(resetCredits);
  await waitFor(() => {
    expectVisibleText("2 resets left · expires in 3d");
  });

  const credits = within(menu).getByText("12,500 credits");
  const codex = within(panel).getByRole("heading", { name: "Codex" });
  expect(
    codex.compareDocumentPosition(resetCredits) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    resetCredits.compareDocumentPosition(codexFiveHour) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    credits.compareDocumentPosition(codex) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test("Reset Codex usage from the account menu", async () => {
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([connectedPersonalCodexProvider()]);
  context.mocks.api(
    personalModelProvidersByTypeContract.resetSubscriptionUsage,
    ({ respond }) => {
      const provider = connectedPersonalCodexProvider({
        subscriptionResetCredits: 1,
      });
      context.mocks.data.personalModelProviders([provider]);
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

test("Open personal Settings and manage account security", async () => {
  prepareDefaultAgent();
  context.mocks.data.userPreferences({
    captureNetworkBodiesRemaining: 0,
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
    featureSwitches: {
      [FeatureSwitchKey.MorningBrief]: true,
      [FeatureSwitchKey.OkouDebug]: true,
    },
  });

  const menu = await openAccountMenu();
  expect(within(menu).getByText("Alex Rivera")).toBeInTheDocument();
  expect(
    within(menu).getByText("alex.rivera@example.test"),
  ).toBeInTheDocument();

  click(within(menu).getByText("Settings"));

  await waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Preference" }),
    ).toBeInTheDocument();
    // Scoped to the dialog: the sidebar account row also carries the name.
    expect(within(dialog).getByText("Account & security")).toBeInTheDocument();
    expect(within(dialog).getByText("Alex Rivera")).toBeInTheDocument();
    expect(
      within(dialog).getByText("alex.rivera@example.test"),
    ).toBeInTheDocument();
    const morningBrief = within(dialog).getByTestId("morning-brief-preference");
    expect(
      within(dialog).getByRole("region", { name: "Email subscriptions" }),
    ).toContainElement(morningBrief);
    expect(within(dialog).queryByText("Send now")).toBeNull();
  });

  const openedSettingsDialog = screen.getByRole("dialog", {
    name: "Settings",
  });
  await waitFor(() => {
    const activeElement = document.activeElement;
    expect(openedSettingsDialog).not.toHaveFocus();
    expect(activeElement).toBeInstanceOf(HTMLElement);
    expect(openedSettingsDialog).toContainElement(activeElement as HTMLElement);
  });

  const userProfileLink = linkByText("Manage");
  expect(userProfileLink).toHaveAttribute(
    "href",
    "https://accounts.example.test/user",
  );
  expect(userProfileLink).toHaveAttribute("target", "_blank");
  expect(userProfileLink).toHaveAttribute("rel", "noreferrer");
});

test("Toggle network-body capture in Debug settings", async () => {
  prepareDefaultAgent();
  const user = userEvent.setup({ delay: null });
  const submitted: number[] = [];
  let preferences: UserPreferencesResponse = {
    timezone: null,
    locale: "en-US",
    supportedLocales: ["en-US"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
  };
  context.mocks.data.userPreferences(preferences);
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.captureNetworkBodiesRemaining !== undefined) {
      submitted.push(body.captureNetworkBodiesRemaining);
    }
    preferences = { ...preferences, ...body };
    context.mocks.data.userPreferences(preferences);
    return respond(200, preferences);
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
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  const menu = await openAccountMenu();
  expect(within(menu).getByText("Alex Rivera")).toBeInTheDocument();
  expect(
    within(menu).getByText("alex.rivera@example.test"),
  ).toBeInTheDocument();

  click(within(menu).getByText("Settings"));

  await waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Preference" }),
    ).toBeInTheDocument();
    // Scoped to the dialog: the sidebar account row also carries the name.
    expect(within(dialog).getByText("Account & security")).toBeInTheDocument();
    expect(within(dialog).getByText("Alex Rivera")).toBeInTheDocument();
    expect(
      within(dialog).getByText("alex.rivera@example.test"),
    ).toBeInTheDocument();
  });

  click(buttonByText("Debug"));

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Debug" })).toBeInTheDocument();
    expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  const captureSwitch = screen.getByRole("switch", {
    name: "Capture network bodies",
    checked: false,
  });
  expect(captureSwitch).toHaveAccessibleDescription("Disabled");
  await user.click(captureSwitch);

  await waitFor(() => {
    expect(
      screen.getByRole("switch", {
        name: "Capture network bodies",
        checked: true,
      }),
    ).toHaveAccessibleDescription("Enabled for the next 3 runs");
  });
  expect(submitted).toStrictEqual([3]);

  captureSwitch.focus();
  expect(captureSwitch).toHaveFocus();
  await user.keyboard("[Space]");

  await waitFor(() => {
    expect(
      screen.getByRole("switch", {
        name: "Capture network bodies",
        checked: false,
      }),
    ).toHaveAccessibleDescription("Disabled");
  });
  expect(submitted).toStrictEqual([3, 0]);

  await user.click(screen.getByText("Capture network bodies"));
  await waitFor(() => {
    expect(
      screen.getByRole("switch", {
        name: "Capture network bodies",
        checked: true,
      }),
    ).toHaveAccessibleDescription("Enabled for the next 3 runs");
  });
  expect(submitted).toStrictEqual([3, 0, 3]);
});

test("Hide Debug settings without Debug access", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?settings=debug`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    within(dialog).getByRole("heading", { name: "Preference" }),
  ).toBeInTheDocument();
  expect(within(dialog).queryByText("Debug")).not.toBeInTheDocument();
});

test.each(["success", "failure", "pending task"])(
  "Switch accounts: %s",
  async (outcome) => {
    prepareDefaultAgent();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      auth: {
        user: {
          id: "test-user-123",
          fullName: "Alex Rivera",
          email: "alex.rivera@example.test",
          imageUrl: "https://cdn.okou.test/users/alex.png",
          clientSessions: [
            {
              id: "test-session-id",
              status: "active",
              user: {
                fullName: "Alex Rivera",
                imageUrl: "https://cdn.okou.test/users/alex.png",
                primaryEmailAddress: {
                  emailAddress: "alex.rivera@example.test",
                },
              },
            },
            {
              id: "session-jamie",
              status: "active",
              ...(outcome === "pending task"
                ? { currentTask: { key: "choose-organization" } }
                : {}),
              user: {
                fullName: "Jamie Chen",
                imageUrl: "https://cdn.okou.test/users/jamie.png",
                primaryEmailAddress: {
                  emailAddress: "jamie.chen@example.test",
                },
              },
            },
          ],
        },
      },
    });

    const finishSwitch = context.mocks.deferred<void>();
    const setActive = mockedClerk.setActive.getMockImplementation();
    if (!setActive) {
      throw new Error("Expected the Clerk setActive mock");
    }
    let appWasUnmounted = false;
    mockedClerk.setActive.mockImplementation(async (params) => {
      appWasUnmounted =
        document.querySelector('[data-slot="app-shell"]') === null;
      await finishSwitch.promise;
      await setActive(params);
    });
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {});
    const reloadedUrls: string[] = [];
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {
        reloadedUrls.push(window.location.href);
      });
    const originalUrl = window.location.href;
    const lifecycle = window._okou;
    expect(
      document.querySelector('[data-slot="app-shell"]'),
    ).toBeInTheDocument();

    const menu = await openAccountMenu();
    click(within(menu).getByText("Switch account"));

    await waitFor(() => {
      expect(screen.getByText("Jamie Chen")).toBeInTheDocument();
      expect(screen.getByText("jamie.chen@example.test")).toBeInTheDocument();
    });

    click(await screen.findByText("Jamie Chen"));

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledWith(
        expect.objectContaining({ session: "session-jamie" }),
      );
    });
    expect(appWasUnmounted).toBeTruthy();
    expect(lifecycle?.rootSignal.aborted).toBeTruthy();
    expect(window._okou).toBe(lifecycle);
    expect(context.signal.aborted).toBeFalsy();
    expect(replace).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    if (outcome === "failure") {
      finishSwitch.reject(new Error("Session switch failed"));
    } else {
      finishSwitch.resolve();
    }
    const destination =
      outcome === "pending task" ? "/sign-in/tasks/choose-organization" : "/";
    await waitFor(() => {
      expect(replace.mock.calls).toStrictEqual(
        outcome === "failure" ? [] : [[destination]],
      );
      expect(reloadedUrls).toStrictEqual(
        outcome === "failure" ? [originalUrl] : [],
      );
    });
  },
);

test("Add account opens the hosted Clerk account switcher with the shared appearance", async () => {
  context.mocks.browser.matchMedia(true);
  const clerk = context.mocks.clerk();
  await setupAddAccountPage();
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");

  const menu = await openAccountMenu();
  click(within(menu).getByText("Add account"));

  await waitFor(() => {
    expect(mockedClerk.openSignIn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        appearance: expect.objectContaining({
          theme: "simple",
          options: expect.objectContaining({
            logoImageUrl: platformOkouWordmarkLightImg,
            logoLinkUrl: "/",
          }),
          elements: expect.objectContaining({
            formButtonPrimary: expect.stringContaining("bg-primary"),
            formFieldInput: expect.stringContaining("bg-input"),
          }),
        }),
        fallbackRedirectUrl: "/",
        forceRedirectUrl: "/",
      }),
    );
  });
  expect(clerk.uiRequests).toStrictEqual([
    "https://app.example.test/assets/clerk-ui-test.js",
  ]);
});

test("Sign out from the account menu", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    host: "app.okou.ai",
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
  click(within(menu).getByText("Sign out"));

  await waitFor(() => {
    expect(mockedClerk.signOut).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-session-id",
        redirectUrl: expect.stringMatching(
          /(?=.*\/sign-in#\/\?)(?=.*redirect_url=)/,
        ),
      }),
    );
  });
});

test.each([null] as const)(
  "Keep an active session open when provider loading remains unauthorized (saved locale: %s)",
  async (locale) => {
    mockAdminAccountSidebar();
    context.mocks.data.userPreferences({ locale });
    const providerResponse = context.mocks.deferred<void>();
    let menuOpened = false;

    context.mocks.api(
      personalModelProvidersMainContract.list,
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
