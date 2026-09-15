import {
  billingUsagePackCatalogContract,
  billingUsagePackManagementContract,
} from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

/** A new workspace with no active plan, so the sidebar offers the Pro upgrade. */
function prepareUpgradeFlow(): void {
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
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 2000,
          totalCredits: 22_000,
        },
      ],
    });
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

test("Relaunching the upgrade flow after dismissing a plans deep link", async () => {
  prepareUpgradeFlow();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?settings=billing&billingView=plans`,
  });

  await dismissPlansDialog();

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  await clickSidebarUpgradeCard();

  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
});
