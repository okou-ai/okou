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

function buttonByText(text: string): HTMLElement {
  const element = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === text;
  });
  if (!element) {
    throw new Error(`Button with text "${text}" not found`);
  }
  return element;
}

function linkByLabel(label: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!link) {
    throw new Error(`Link with label "${label}" not found`);
  }
  return link;
}

function selectOptionByText(text: string): HTMLElement {
  const option = screen.getAllByText(text).find((candidate) => {
    return candidate.closest('[role="option"]') !== null;
  });
  if (!option) {
    throw new Error(`Select option with text "${text}" not found`);
  }
  return option;
}

function mockInvoicesStory(): void {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(billingInvoicesContract.get, ({ respond }) => {
    return respond(200, {
      receiptDownloadsSupported: true,
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
  const invoiceLink = linkByLabel("Download March 2026 invoice");
  expect(invoiceLink).toHaveAttribute(
    "href",
    "https://billing.stripe.com/invoice/test",
  );
  expect(invoiceLink).toHaveAttribute("target", "_blank");
  await user.click(invoiceLink);
});

test("Download receipts for a valid month range", async () => {
  const user = userEvent.setup();
  const browserDownload = context.mocks.browser.blobDownload();
  let requestedRange: {
    readonly startMonth: string;
    readonly endMonth: string;
  } | null = null;
  const receiptsReady = context.mocks.deferred<void>();
  mockInvoicesStory();
  context.mocks.api(
    billingInvoicesContract.downloadReceipts,
    async ({ query, respond }) => {
      requestedRange = query;
      await receiptsReady.promise;
      return respond(
        200,
        new Blob(["monthly receipts"], { type: "application/zip" }),
      );
    },
  );
  await openInvoicesTab();

  await waitFor(() => {
    expect(screen.getByText("INV-2026-0001")).toBeInTheDocument();
    expect(screen.getAllByText("Paid")).toHaveLength(4);
    expect(screen.getByText("3/15/2026")).toBeInTheDocument();
    expect(screen.getByText("$20.00")).toBeInTheDocument();
  });
  expect(
    screen.getAllByLabelText("Download March 2026 invoice")[0],
  ).toHaveAttribute("href", "https://billing.stripe.com/invoice/test");

  await user.click(buttonByText("Download receipts"));
  expect(
    screen.getByRole("heading", { name: "Download receipts" }),
  ).toBeInTheDocument();
  await user.click(screen.getByLabelText("From month"));
  await user.click(selectOptionByText("December 2025"));
  expect(
    screen.getByText("Select a range of no more than 3 consecutive months."),
  ).toBeInTheDocument();
  expect(buttonByText("Download ZIP")).toBeDisabled();

  await user.click(screen.getByLabelText("From month"));
  await user.click(selectOptionByText("February 2026"));
  expect(buttonByText("Download ZIP")).not.toBeDisabled();
  await user.click(buttonByText("Download ZIP"));

  await expect(
    screen.findByText("Preparing receipt download..."),
  ).resolves.toBeInTheDocument();
  receiptsReady.resolve();
  await waitFor(() => {
    expect(requestedRange).toStrictEqual({
      startMonth: "2026-02",
      endMonth: "2026-03",
    });
    expect(browserDownload.downloads).toHaveLength(1);
    expect(screen.getByText("Receipts downloaded")).toBeInTheDocument();
  });
  expect(browserDownload.downloads[0]?.filename).toBe(
    "receipts-2026-02-to-2026-03.zip",
  );
});
