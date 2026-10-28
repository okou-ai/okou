import {
  billingStatusContract,
  billingUsagePackCatalogContract,
} from "@okouai/api-contracts/contracts/billing";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

async function openUpgradeChat(tier = "limited-free-1") {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier,
      ...billingPlanCapabilities(tier),
      onboardingPaymentPending: false,
    });
  });
  installCapabilityChat({
    events: completedConversation(
      "[Compare plans](https://app.okou.ai/?settings=billing&billingView=plans)",
    ),
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  return screen.findByTestId("plan-upgrade-card");
}

test("Show the lowest paid catalog price and open the existing plans dialog", async () => {
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 50,
          priceUsd: 45,
          purchasedCredits: 50_000,
          bonusCredits: 5000,
          totalCredits: 55_000,
        },
        {
          usagePackUsd: 20,
          priceUsd: 18,
          purchasedCredits: 20_000,
          bonusCredits: 2000,
          totalCredits: 22_000,
        },
      ],
    });
  });

  const card = await openUpgradeChat();
  await expect(within(card).findByText("$18")).resolves.toBeVisible();
  expect(within(card).queryByText("$0")).toBeNull();
  expect(within(card).queryByText(/tasks? left/u)).toBeNull();
  expect(within(card).queryByText(/400/u)).toBeNull();
  click(await findEnabledButton("Upgrade now", card));
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
});

test("Keep the upgrade action usable when the price catalog is unavailable", async () => {
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Catalog unavailable" },
    });
  });

  const card = await openUpgradeChat();
  await expect(
    within(card).findByText("See plans for current pricing"),
  ).resolves.toBeVisible();
  expect(within(card).queryByText(/\$/u)).toBeNull();
  await expect(findEnabledButton("Upgrade now", card)).resolves.toBeEnabled();
});

test("Keep the general plans action for an existing paid workspace", async () => {
  const card = await openUpgradeChat("pro");
  await expect(
    within(card).findByText("Upgrade your workspace"),
  ).resolves.toBeVisible();
  expect(within(card).queryByText("Do more with Pro")).toBeNull();
  click(await findEnabledButton("Compare plans", card));
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
});
