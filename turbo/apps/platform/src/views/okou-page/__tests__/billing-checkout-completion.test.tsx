import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
  billingUsagePackManagementContract,
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
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const CONCURRENCY_ADDED =
  "Concurrency added. Your new slots will become available after Stripe confirms the subscription.";

test("Returning from concurrency checkout confirms purchased capacity", async () => {
  await setupPage({ context, path: "/agents?concurrency=purchased" });

  await expect(
    screen.findByText(CONCURRENCY_ADDED),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/agents");
  expect(
    new URLSearchParams(window.location.search).has("concurrency"),
  ).toBeFalsy();
});

test("A confirmed usage-pack purchase displays its confirmation", async () => {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier: "limited-free-1",
      ...billingPlanCapabilities("limited-free-1"),
    });
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No usage packs" },
    });
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 2000,
          bonusCredits: 200,
          totalCredits: 2200,
        },
      ],
      supportsFreeMembers: true,
    });
  });
  const previewToken = "usage-pack-preview-token";
  context.mocks.api(
    billingUsagePackCheckoutContract.create,
    ({ body, respond }) => {
      expect(body.tier).toBe("pro");
      if (body.previewToken === previewToken) {
        return respond(200, { status: "completed", hostedInvoiceUrl: null });
      }
      return respond(200, {
        status: "preview",
        purchaseType: "usage_pack",
        tier: "pro",
        immediateAmountCents: 2000,
        nextRecurringAmountCents: 2000,
        currency: "usd",
        expiresAt: "2099-01-01T00:00:00.000Z",
        previewToken,
      });
    },
  );
  await setupPage({ context, path: "/?settings=billing&billingView=plans" });
  const plans = await screen.findByRole("dialog", { name: "Choose a plan" });
  const pro = await within(plans).findByRole("article", { name: "Pro plan" });

  click(getAction("button", "Start with Pro", pro));
  await expect(
    within(plans).findByText("Configure member packages"),
  ).resolves.toBeInTheDocument();
  const summary = within(plans).getByRole("region", { name: "Order summary" });
  click(await findAction("button", "Upgrade to Pro", summary));
  const order = await screen.findByRole("dialog", { name: "Order summary" });
  click(await findAction("button", "Confirm", order));

  await expect(
    screen.findByText("Subscription change confirmed."),
  ).resolves.toBeInTheDocument();
});
