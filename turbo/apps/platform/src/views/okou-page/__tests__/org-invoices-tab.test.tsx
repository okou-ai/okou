import { billingInvoicesContract } from "@okouai/api-contracts/contracts/billing";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("Open an individual invoice from invoice history", async () => {
  const hostedInvoice = "https://invoice.stripe.test/i/acct_1/inv_march";
  context.mocks.data.org({ id: "org_invoices", name: "Acme", role: "admin" });
  context.mocks.api(billingInvoicesContract.get, ({ respond }) => {
    return respond(200, {
      invoices: [
        {
          id: "in_march_2026",
          number: "OKOU-0326",
          date: Date.parse("2026-03-15T12:00:00.000Z") / 1000,
          amount: 4900,
          status: "paid",
          hostedInvoiceUrl: hostedInvoice,
        },
      ],
    });
  });

  await setupPage({ context, path: "/?settings=invoices" });

  const invoice = await screen.findByLabelText("Download March 2026 invoice");
  expect(invoice).toHaveAttribute("href", hostedInvoice);
  expect(invoice).toHaveAttribute("target", "_blank");
  expect(invoice).toHaveAttribute("rel", "noopener noreferrer");
});
