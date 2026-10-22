import { billingInvoicesContract } from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { unixSecondsFromIso } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function linkByLabel(label: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!link) {
    throw new Error(`Link with label "${label}" not found`);
  }
  return link;
}

function mockInvoicesStory(): void {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(billingInvoicesContract.get, ({ respond }) => {
    return respond(200, {
      invoices: [
        {
          id: "in_2026_0001",
          number: "INV-2026-0001",
          date: unixSecondsFromIso("2026-03-15T00:00:00.000Z"),
          amount: 2000,
          status: "paid",
          hostedInvoiceUrl: "https://billing.stripe.com/invoice/test",
        },
        {
          id: "in_2026_0002",
          number: "INV-2026-0002",
          date: unixSecondsFromIso("2026-03-01T00:00:00.000Z"),
          amount: 1000,
          status: "paid",
          hostedInvoiceUrl: "https://billing.stripe.com/invoice/test-2",
        },
        {
          id: "in_2026_0003",
          number: "INV-2026-0003",
          date: unixSecondsFromIso("2026-02-15T00:00:00.000Z"),
          amount: 3000,
          status: "paid",
          hostedInvoiceUrl: "https://billing.stripe.com/invoice/test-3",
        },
        {
          id: "in_2025_0004",
          number: "INV-2025-0004",
          date: unixSecondsFromIso("2025-12-15T00:00:00.000Z"),
          amount: 4000,
          status: "paid",
          hostedInvoiceUrl: "https://billing.stripe.com/invoice/test-4",
        },
      ],
    });
  });
}

async function openInvoicesTab(): Promise<void> {
  await setupPage({ context, path: "/?settings=invoices" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Invoices" }),
    ).toBeInTheDocument();
  });
}

test("Open an individual invoice from invoice history", async () => {
  const user = userEvent.setup();
  mockInvoicesStory();
  await openInvoicesTab();

  await expect(screen.findByText("INV-2026-0001")).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Paid")).toHaveLength(4);
  expect(screen.getByText("3/15/2026")).toBeInTheDocument();
  expect(screen.getByText("$20.00")).toBeInTheDocument();
  const invoiceLink = linkByLabel("Download March 2026 invoice");
  expect(invoiceLink).toHaveAttribute(
    "href",
    "https://billing.stripe.com/invoice/test",
  );
  expect(invoiceLink).toHaveAttribute("target", "_blank");
  await user.click(invoiceLink);
});
