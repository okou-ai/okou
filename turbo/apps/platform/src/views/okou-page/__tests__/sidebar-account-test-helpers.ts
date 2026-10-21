import { screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function createSidebarAccountHelpers(context: TestContext) {
  return {
    prepareDefaultAgent: (targetContext = context) => {
      return prepareDefaultAgent(targetContext);
    },
    setupAddAccountPage: () => {
      return setupAddAccountPage(context);
    },
    mockAdminBillingStatus: (
      credits: number,
      options?: MockAdminBillingStatusOptions,
    ) => {
      return mockAdminBillingStatus(context, credits, options);
    },
    mockAdminAccountSidebar: () => {
      return mockAdminAccountSidebar(context);
    },
    mockMemberAccountSidebar: () => {
      return mockMemberAccountSidebar(context);
    },
  };
}

export const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
export function connectedPersonalCodexProvider(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000301",
    type: "codex-oauth-token",
    framework: "codex",
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

export function connectedPersonalClaudeCodeProvider(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000302",
    type: "claude-code-oauth-token",
    framework: "claude-code",
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

export function prepareDefaultAgent(targetContext: TestContext): void {
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

export function buttonByText(
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

export function linkByText(text: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`${text} link not found`);
  }
  return link;
}

export function formatResetInTimeZone(
  resetAt: string,
  timeZone: string,
): string {
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

export function mockBrowserTimeZone(timeZone: string): void {
  const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolvedOptions,
    timeZone,
  });
}

export function expectVisibleText(text: string): void {
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

export async function openAccountMenu(): Promise<HTMLElement> {
  const accountButton = await findAccountMenuTrigger();
  click(accountButton);
  return screen.findByRole("menu");
}

export function setupAddAccountPage(context: TestContext): Promise<void> {
  prepareDefaultAgent(context);
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

export function mockAdminBillingStatus(
  context: TestContext,
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

export function mockAdminAccountSidebar(context: TestContext): void {
  prepareDefaultAgent(context);
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockAdminBillingStatus(context, 12_500);
}

export function mockMemberAccountSidebar(context: TestContext): void {
  prepareDefaultAgent(context);
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
}
