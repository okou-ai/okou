import { screen, waitFor, within } from "@testing-library/react";

import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

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

function accountMenuTrigger(userName = "Alex Rivera"): HTMLElement {
  return within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
    userName,
  );
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
  return setupPage({
    context,
    path: `/`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });
}
