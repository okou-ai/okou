import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import {
  billingCheckoutContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
  billingUsagePackManagementContract,
} from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

type GoogleTag = (
  command: "event",
  eventName: "conversion",
  parameters: {
    readonly send_to: string;
    readonly value: number;
    readonly currency: "USD";
    readonly transaction_id?: string;
  },
) => void;

function getButton(name: string, container: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

test("Returning from concurrency checkout confirms purchased capacity", async () => {
  await setupPage({
    context,
    path: "/agents?concurrency=purchased",
    host: "app.okou.ai",
  });

  await expect(
    screen.findByText(
      "Concurrency added. Your new slots will become available after Stripe confirms the subscription.",
    ),
  ).resolves.toBeVisible();
  expect(window.history.replaceState).toHaveBeenLastCalledWith(
    {},
    "",
    "/agents",
  );
});

test.each(["7935750692", "1001302527", undefined])(
  "A confirmed subscription reports a browser conversion only for the new account: %s",
  async (accountId) => {
    const googleTag = vi.fn<GoogleTag>();
    vi.stubGlobal("gtag", googleTag);
    context.mocks.api(billingCheckoutContract.complete, ({ respond }) => {
      return respond(200, {
        completed: true,
        googleAdsConversion: {
          googleAdsAccountId: accountId,
          transactionId: "invoice_subscription_123",
          valueUsd: 160,
        },
      });
    });

    await setupPage({
      context,
      path: "/agents?billing=team&billing_session_id=cs_paid_subscription",
      host: "app.okou.ai",
    });

    await expect(
      screen.findByRole("heading", { name: "Agents" }),
    ).resolves.toBeVisible();
    await waitFor(() => {
      expect(window.history.replaceState).toHaveBeenLastCalledWith(
        {},
        "",
        "/agents",
      );
      expect(googleTag).toHaveBeenCalledTimes(
        accountId === "7935750692" ? 1 : 0,
      );
    });
    if (accountId !== "7935750692") {
      return;
    }
    expect(googleTag).toHaveBeenCalledWith("event", "conversion", {
      send_to: "AW-18407336975/ePWuCPuRrOccEI_YpslE",
      value: 40,
      currency: "USD",
      transaction_id: "invoice_subscription_123",
    });
  },
);

test("A confirmed usage-pack purchase reports the paid conversion", async () => {
  const googleTag = vi.fn<GoogleTag>();
  vi.stubGlobal("gtag", googleTag);
  context.mocks.api(
    acquisitionAttributionContract.googleAdsMilestones,
    ({ respond }) => {
      return respond(200, { milestones: [] });
    },
  );
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
        {
          usagePackUsd: 50,
          priceUsd: 50,
          purchasedCredits: 50_000,
          bonusCredits: 7500,
          totalCredits: 57_500,
        },
        {
          usagePackUsd: 100,
          priceUsd: 100,
          purchasedCredits: 100_000,
          bonusCredits: 20_000,
          totalCredits: 120_000,
        },
        {
          usagePackUsd: 200,
          priceUsd: 200,
          purchasedCredits: 200_000,
          bonusCredits: 50_000,
          totalCredits: 250_000,
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
  context.mocks.api(
    billingUsagePackCheckoutContract.create,
    ({ body, respond }) => {
      if (body.previewToken === undefined) {
        return respond(200, {
          status: "preview",
          purchaseType: "usage_pack",
          tier: "pro",
          immediateAmountCents: 4000,
          nextRecurringAmountCents: 4000,
          currency: "usd",
          expiresAt: "2026-09-01T01:00:00.000Z",
          previewToken: "usage-pack-preview-123",
        });
      }
      return respond(200, {
        status: "completed",
        hostedInvoiceUrl: null,
        googleAdsConversion: {
          googleAdsAccountId: "7935750692",
          transactionId: "invoice_usage_pack_123",
          valueUsd: 40,
        },
      });
    },
  );

  await setupPage({
    context,
    path: "/agents?settings=billing&billingView=plans",
    host: "app.okou.ai",
  });

  const plansDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  const selectPro = await waitFor(() => {
    return getButton("Start with Pro", plansDialog);
  });
  click(selectPro);

  const packagesDialog = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  click(getButton("Upgrade to Pro", packagesDialog));

  const confirmationDialog = await screen.findByRole("dialog", {
    name: "Order summary",
  });
  click(getButton("Confirm", confirmationDialog));

  await expect(
    screen.findByText("Subscription change confirmed."),
  ).resolves.toBeVisible();
  expect(googleTag).toHaveBeenCalledTimes(1);
  expect(googleTag).toHaveBeenCalledWith("event", "conversion", {
    send_to: "AW-18407336975/ePWuCPuRrOccEI_YpslE",
    value: 40,
    currency: "USD",
    transaction_id: "invoice_usage_pack_123",
  });
});
