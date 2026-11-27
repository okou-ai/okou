import { mockNow } from "../../../lib/time.ts";
import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackManagementContract,
  type BillingStatusResponse,
  type UsagePackUsd,
} from "@okouai/api-contracts/contracts/billing";
import { waitFor } from "@testing-library/react";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  defaultBillingStatus,
  billingPlanCapabilities,
} from "../../../mocks/handlers/api-billing.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export const april = "2026-04-01T12:00:00.000Z";
export function billing(
  tier: string,
  overrides: Partial<BillingStatusResponse> = {},
): BillingStatusResponse {
  return {
    ...defaultBillingStatus(),
    ...billingPlanCapabilities(tier),
    tier,
    hasSubscription: tier !== "limited-free-1",
    subscriptionStatus: tier === "limited-free-1" ? null : "active",
    showUsagePack: true,
    ...overrides,
  };
}
export function setBilling(
  context: TestContext,
  read: () => BillingStatusResponse,
) {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, read());
  });
}
export function openWorkspace(
  context: TestContext,
  path = "/?settings=billing",
) {
  context.mocks.data.org({
    id: "org_finance",
    name: "Finance team",
    role: "admin",
  });
  context.mocks.data.orgMembers({ name: "Finance team", role: "admin" });
  mockNow(new Date("2026-03-15T12:00:00Z"), context.signal);
  return setupPage({
    context,
    path,
    host: "app.okou.ai",
    auth: {
      user: { id: "alex", fullName: "Alex", email: "alex@example.org" },
      organization: {
        activeOrg: { id: "org_finance", name: "Finance team" },
        memberships: [{ id: "org_finance", role: "org:admin" }],
      },
    },
  });
}
export function findAction(name: string, scope: ParentNode = document.body) {
  return queryAllByRoleFast("button", scope).find((el) => {
    return (
      el.getAttribute("aria-label") === name || el.textContent?.trim() === name
    );
  });
}
export function action(name: string, scope?: ParentNode) {
  return waitFor(() => {
    const item = findAction(name, scope);
    if (!item) {
      throw new Error("Missing action " + name);
    }
    return item;
  });
}
export function packages(
  context: TestContext,
  catalogReady: Promise<void> = Promise.resolve(),
) {
  const option = (usagePackUsd: UsagePackUsd, bonusCredits: number) => {
    return {
      usagePackUsd,
      priceUsd: usagePackUsd,
      purchasedCredits: 1000 * usagePackUsd,
      bonusCredits,
      totalCredits: 1000 * usagePackUsd + bonusCredits,
    };
  };
  context.mocks.api(
    billingUsagePackCatalogContract.get,
    async ({ respond }) => {
      await catalogReady;
      return respond(200, {
        supportsFreeMembers: true,
        usagePacks: [
          option(20, 1234),
          option(50, 4321),
          option(100, 9999),
          option(200, 25_000),
        ],
      });
    },
  );
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No recurring packages" },
    });
  });
}
export function addParticipants(context: TestContext) {
  context.mocks.data.orgMembers({
    name: "Finance team",
    role: "admin",
    members: [
      {
        userId: "beck",
        firstName: "Beck",
        lastName: null,
        email: "beck@example.org",
        role: "member",
        imageUrl: "",
        joinedAt: "2025-10-01T12:00:00Z",
      },
    ],
    pendingInvitations: [
      {
        id: "pending-finance",
        email: "invite@example.org",
        createdAt: "2026-03-14T12:00:00Z",
        role: "member",
      },
    ],
  });
}
