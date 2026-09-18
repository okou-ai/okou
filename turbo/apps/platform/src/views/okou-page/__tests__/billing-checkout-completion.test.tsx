import {
  billingCheckoutContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
  billingUsagePackManagementContract,
} from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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
  ).resolves.toBeInTheDocument();
  expect(window.history.replaceState).toHaveBeenLastCalledWith(
    {},
    "",
    "/agents",
  );
});

test("A confirmed subscription completes checkout and clears its return parameters", async () => {
  context.mocks.api(billingCheckoutContract.complete, ({ respond }) => {
    return respond(200, { completed: true });
  });

  await setupPage({
    context,
    path: "/agents?billing=team&billing_session_id=cs_completed_subscription",
    host: "app.okou.ai",
  });

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(window.history.replaceState).toHaveBeenLastCalledWith(
      {},
      "",
      "/agents",
    );
  });
});

test("A confirmed usage-pack purchase displays its confirmation", async () => {
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
  ).resolves.toBeInTheDocument();
});
