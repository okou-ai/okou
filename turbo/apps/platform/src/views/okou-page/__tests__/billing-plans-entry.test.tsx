import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackManagementContract,
  billingUsagePackMigrationContract,
} from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function usagePackCatalogResponse() {
  return {
    supportsFreeMembers: true as const,
    usagePacks: [
      {
        usagePackUsd: 20 as const,
        priceUsd: 20,
        purchasedCredits: 20_000,
        bonusCredits: 2000,
        totalCredits: 22_000,
      },
    ],
  };
}

/** A new workspace with no active plan, so the sidebar offers the Pro upgrade. */
function prepareUpgradeFlow(): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier: "limited-free-1",
      ...billingPlanCapabilities("limited-free-1"),
      onboardingPaymentPending: false,
      concurrencyLimit: 2,
    });
  });
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  context.mocks.data.agents([
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
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, usagePackCatalogResponse());
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "NOT_FOUND",
        message: "No usage-pack subscription",
      },
    });
  });
}

async function clickSidebarUpgradeCard(): Promise<void> {
  const upgradeCard = (await screen.findByText("Get Pro")).closest("button");
  if (!upgradeCard) {
    throw new Error("Sidebar upgrade card is not mounted");
  }
  click(upgradeCard);
}

async function dismissPlansDialog(): Promise<void> {
  const plansDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  click(within(plansDialog).getByLabelText("Close"));
}

test("Dismissing the sidebar upgrade flow returns to the chat screen", async () => {
  prepareUpgradeFlow();

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  await clickSidebarUpgradeCard();
  await screen.findByText("Start with Pro");
  await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(
    screen.queryByRole("dialog", { name: "Settings" }),
  ).not.toBeInTheDocument();
  await dismissPlansDialog();

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
  });
  expect(
    screen.queryByRole("dialog", { name: "Settings" }),
  ).not.toBeInTheDocument();
  expect(search()).not.toContain("settings=billing");
});

test("Loading eligibility keeps the same modal through plan selection and configuration", async () => {
  prepareUpgradeFlow();
  const migrationReady = context.mocks.deferred<void>();
  const catalogReady = context.mocks.deferred<void>();
  context.mocks.api(
    billingUsagePackCatalogContract.get,
    async ({ respond }) => {
      await catalogReady.promise;
      return respond(200, usagePackCatalogResponse());
    },
  );
  context.mocks.api(
    billingUsagePackMigrationContract.get,
    async ({ respond }) => {
      await migrationReady.promise;
      return respond(404, {
        error: { code: "NOT_FOUND", message: "No legacy subscription" },
      });
    },
  );

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  await clickSidebarUpgradeCard();
  const modal = await screen.findByRole("dialog", { name: "Billing" });
  expect(within(modal).getByRole("status")).toBeInTheDocument();
  expect(within(modal).queryByText("Start with Pro")).not.toBeInTheDocument();

  migrationReady.resolve();
  const plansModal = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  expect(plansModal).toBe(modal);
  expect(within(modal).queryByText("Start with Pro")).not.toBeInTheDocument();
  catalogReady.resolve();
  const start = await within(modal).findByText("Start with Pro");
  click(start);
  const configurationModal = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  expect(configurationModal).toBe(modal);
  expect(within(modal).getByText("Step 2 of 2")).toBeInTheDocument();

  click(within(modal).getByLabelText("Back"));
  await within(modal).findByText("Start with Pro");
  expect(screen.getByRole("dialog", { name: "Choose a plan" })).toBe(modal);
  await dismissPlansDialog();
  await waitFor(() => {
    expect(modal).not.toBeInTheDocument();
  });
});

test("A failed eligibility request does not become a normal plan checkout", async () => {
  prepareUpgradeFlow();
  const migrationReady = context.mocks.deferred<void>();
  context.mocks.api(
    billingUsagePackMigrationContract.get,
    async ({ respond }) => {
      await migrationReady.promise;
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Eligibility unavailable",
        },
      });
    },
  );

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  await clickSidebarUpgradeCard();
  const modal = await screen.findByRole("dialog", { name: "Billing" });
  migrationReady.resolve();
  await within(modal).findByText("Could not load billing status.");
  expect(screen.getByRole("dialog", { name: "Billing" })).toBe(modal);
  expect(within(modal).queryByText("Start with Pro")).not.toBeInTheDocument();
  click(within(modal).getByLabelText("Close"));
  await waitFor(() => {
    expect(modal).not.toBeInTheDocument();
  });
  expect(search()).not.toContain("settings=billing");
});

test("Closing pending eligibility does not reopen the modal when the response arrives", async () => {
  prepareUpgradeFlow();
  const migrationReady = context.mocks.deferred<void>();
  context.mocks.api(
    billingUsagePackMigrationContract.get,
    async ({ respond }) => {
      await migrationReady.promise;
      return respond(404, {
        error: { code: "NOT_FOUND", message: "No legacy subscription" },
      });
    },
  );

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  await clickSidebarUpgradeCard();
  const modal = await screen.findByRole("dialog", { name: "Billing" });
  click(within(modal).getByLabelText("Close"));
  await waitFor(() => {
    expect(modal).not.toBeInTheDocument();
  });
  migrationReady.resolve();
  await clickSidebarUpgradeCard();
  const reopened = await screen.findByRole("dialog", { name: "Choose a plan" });
  await within(reopened).findByText("Start with Pro");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(within(reopened).getByText("Step 1 of 2")).toBeInTheDocument();
});

test.each(["applying", "scheduled"] as const)(
  "Loading a %s migration keeps the same modal for its progress",
  async (status) => {
    prepareUpgradeFlow();
    const migrationReady = context.mocks.deferred<void>();
    context.mocks.api(
      billingUsagePackMigrationContract.get,
      async ({ respond }) => {
        await migrationReady.promise;
        return respond(200, {
          tier: "pro",
          targetTier: "pro",
          status,
          migrationId: "3ea4b7cf-d71e-45dc-8273-8bc8b9712490",
          effectiveAt: "2026-11-01T00:00:00.000Z",
          hostedInvoiceUrl: null,
        });
      },
    );

    await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await clickSidebarUpgradeCard();
    const modal = await screen.findByRole("dialog", { name: "Billing" });
    migrationReady.resolve();
    const progress = await screen.findByRole("dialog", {
      name: "Convert legacy plan",
    });
    expect(progress).toBe(modal);
    expect(within(modal).queryByText("Start with Pro")).not.toBeInTheDocument();
    click(within(modal).getByLabelText("Back"));
    await waitFor(() => {
      expect(modal).not.toBeInTheDocument();
    });
    expect(search()).not.toContain("settings=billing");
  },
);

test("A billing refresh retains the modal and selected configuration step", async () => {
  prepareUpgradeFlow();
  const refreshReady = context.mocks.deferred<void>();
  const refreshStarted = context.mocks.deferred<void>();
  let refreshing = false;
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    if (refreshing) {
      refreshStarted.resolve();
      await refreshReady.promise;
    }
    return respond(200, {
      ...defaultBillingStatus(),
      tier: "limited-free-1",
      ...billingPlanCapabilities("limited-free-1"),
      onboardingPaymentPending: false,
      concurrencyLimit: 2,
    });
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  await clickSidebarUpgradeCard();
  const modal = await screen.findByRole("dialog", { name: "Choose a plan" });
  const start = await within(modal).findByText("Start with Pro");
  click(start);
  await screen.findByRole("dialog", { name: "Configure member packages" });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });

  refreshing = true;
  context.mocks.ably.trigger("billing:changed");
  await refreshStarted.promise;
  expect(
    screen.getByRole("dialog", { name: "Configure member packages" }),
  ).toBe(modal);
  expect(within(modal).getByText("Step 2 of 2")).toBeInTheDocument();
  refreshReady.resolve();
  const refreshed = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  expect(refreshed).toBe(modal);
  expect(within(modal).getByText("Step 2 of 2")).toBeInTheDocument();
});
