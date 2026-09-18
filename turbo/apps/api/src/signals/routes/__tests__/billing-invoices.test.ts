import { randomUUID } from "node:crypto";

import { billingInvoicesContract } from "@okouai/api-contracts/contracts/billing";
import AdmZip from "adm-zip";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { mockListStripeInvoices } from "../../external/stripe-client";
import { createDeferredPromise } from "../../utils";
import {
  deleteInvoicesOrg$,
  seedInvoicesOrg$,
  type InvoicesOrgFixture,
} from "./helpers/billing-invoices";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { billingInvoicesRoutes } from "../billing-invoices";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

describe("GET /api/billing/invoices", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context, routes: billingInvoicesRoutes })(
      billingInvoicesContract,
    );

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the user has no active org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context, routes: billingInvoicesRoutes })(
      billingInvoicesContract,
    );

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 403 for a non-admin org member", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: billingInvoicesRoutes })(
      billingInvoicesContract,
    );

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can view invoices",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns invoices for an admin's org with active subscription", async () => {
    const customerId = `cus-inv-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub-inv-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    let receivedCustomerId: string | null = null;
    mockListStripeInvoices((stripeCustomerId) => {
      receivedCustomerId = stripeCustomerId;
      return Promise.resolve([
        {
          id: "inv_001",
          number: "INV-2026-001",
          created: 1_740_000_000,
          amount_paid: 4000,
          status: "paid",
          hosted_invoice_url: "https://stripe.com/invoice/inv_001",
          invoice_pdf: "https://stripe.com/invoice/inv_001.pdf",
        },
        {
          id: "inv_002",
          number: "INV-2026-002",
          created: 1_737_400_000,
          amount_paid: 4000,
          status: "paid",
          hosted_invoice_url: "https://stripe.com/invoice/inv_002",
          invoice_pdf: "https://stripe.com/invoice/inv_002.pdf",
        },
      ]);
    });

    const client = setupApp({ context, routes: billingInvoicesRoutes })(
      billingInvoicesContract,
    );

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(receivedCustomerId).toBe(customerId);
    expect(response.body).toStrictEqual({
      invoices: [
        {
          id: "inv_001",
          number: "INV-2026-001",
          date: 1_740_000_000,
          amount: 4000,
          status: "paid",
          hostedInvoiceUrl: "https://stripe.com/invoice/inv_001",
        },
        {
          id: "inv_002",
          number: "INV-2026-002",
          date: 1_737_400_000,
          amount: 4000,
          status: "paid",
          hostedInvoiceUrl: "https://stripe.com/invoice/inv_002",
        },
      ],
    });
  });

  it("downloads all receipts for a selected month as a ZIP", async () => {
    const customerId = `cus-receipts-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub-receipts-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    let receivedCustomerId: string | null = null;
    let receivedRange: { readonly gte: number; readonly lt: number } | null =
      null;
    mockListStripeInvoices((stripeCustomerId, created) => {
      receivedCustomerId = stripeCustomerId;
      receivedRange = created ?? null;
      return Promise.resolve([
        {
          id: "inv_july_001",
          number: "INV-JULY-001",
          created: Date.UTC(2026, 6, 10) / 1000,
          amount_paid: 2000,
          status: "paid",
          hosted_invoice_url: "https://stripe.test/invoice/inv_july_001",
          invoice_pdf: "https://stripe.test/invoice/inv_july_001.pdf",
        },
        {
          id: "inv_july_002",
          number: "INV-JULY-002",
          created: Date.UTC(2026, 6, 20) / 1000,
          amount_paid: 3000,
          status: "paid",
          hosted_invoice_url: "https://stripe.test/invoice/inv_july_002",
          invoice_pdf: "https://stripe.test/invoice/inv_july_002.pdf",
        },
      ]);
    });
    server.use(
      http.get("https://stripe.test/invoice/inv_july_001.pdf", () => {
        return new HttpResponse("first receipt", {
          headers: { "Content-Type": "application/pdf" },
        });
      }),
      http.get("https://stripe.test/invoice/inv_july_002.pdf", () => {
        return new HttpResponse("second receipt", {
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const client = setupApp({ context, routes: billingInvoicesRoutes })(
      billingInvoicesContract,
    );
    const response = await accept(
      client.downloadReceipts({
        headers: { authorization: "Bearer clerk-session" },
        query: { startMonth: "2026-06", endMonth: "2026-07" },
      }),
      [200],
    );

    expect(receivedCustomerId).toBe(customerId);
    expect(receivedRange).toStrictEqual({
      gte: Date.UTC(2026, 5, 1) / 1000,
      lt: Date.UTC(2026, 7, 1) / 1000,
    });
    const archive = new AdmZip(Buffer.from(await response.body.arrayBuffer()));
    expect(
      archive.getEntries().map((entry) => {
        return entry.entryName;
      }),
    ).toStrictEqual(["receipt-INV-JULY-001.pdf", "receipt-INV-JULY-002.pdf"]);
    expect(archive.readAsText("receipt-INV-JULY-001.pdf")).toBe(
      "first receipt",
    );
    expect(archive.readAsText("receipt-INV-JULY-002.pdf")).toBe(
      "second receipt",
    );
  });

  it("limits concurrent receipt downloads and retries transient failures", async () => {
    const customerId = `cus-bounded-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub-bounded-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const invoices = Array.from({ length: 11 }, (_, index) => {
      const suffix = String(index + 1).padStart(3, "0");
      return {
        id: `inv_bounded_${suffix}`,
        number: `INV-BOUNDED-${suffix}`,
        created: Date.UTC(2026, 6, 10) / 1000,
        amount_paid: 2000,
        status: "paid",
        hosted_invoice_url: `https://stripe.test/invoice/inv_bounded_${suffix}`,
        invoice_pdf: `https://stripe.test/receipts/inv_bounded_${suffix}`,
      };
    });
    mockListStripeInvoices(() => {
      return Promise.resolve(invoices);
    });

    const firstWaveStarted = createDeferredPromise<void>(context.signal);
    const releaseFirstWave = createDeferredPromise<void>(context.signal);
    let firstWaveRequests = 0;
    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    let transientAttempts = 0;
    server.use(
      http.get(
        "https://stripe.test/receipts/:invoiceId",
        async ({ params }) => {
          activeDownloads += 1;
          maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
          firstWaveRequests += 1;
          if (firstWaveRequests <= 10) {
            if (firstWaveRequests === 10) {
              firstWaveStarted.resolve(undefined);
            }
            await releaseFirstWave.promise;
          }

          const invoiceId = String(params.invoiceId);
          let response: Response;
          if (invoiceId === "inv_bounded_002") {
            transientAttempts += 1;
            if (transientAttempts === 1) {
              response = new HttpResponse(null, { status: 429 });
            } else if (transientAttempts === 2) {
              response = new HttpResponse(null, { status: 503 });
            } else {
              response = new HttpResponse(`receipt for ${invoiceId}`, {
                headers: { "Content-Type": "application/pdf" },
              });
            }
          } else {
            response = new HttpResponse(`receipt for ${invoiceId}`, {
              headers: { "Content-Type": "application/pdf" },
            });
          }
          activeDownloads -= 1;
          return response;
        },
      ),
    );

    const client = setupApp({ context, routes: billingInvoicesRoutes })(
      billingInvoicesContract,
    );
    const responsePromise = accept(
      client.downloadReceipts({
        headers: { authorization: "Bearer clerk-session" },
        query: { startMonth: "2026-07", endMonth: "2026-07" },
      }),
      [200],
    );
    await firstWaveStarted.promise;
    const nextTurn = createDeferredPromise<void>(context.signal);
    setImmediate(() => {
      nextTurn.resolve(undefined);
    });
    await nextTurn.promise;
    releaseFirstWave.resolve(undefined);
    const response = await responsePromise;

    expect(maxActiveDownloads).toBe(10);
    expect(transientAttempts).toBe(3);
    const archive = new AdmZip(Buffer.from(await response.body.arrayBuffer()));
    expect(archive.getEntries()).toHaveLength(11);
    expect(archive.readAsText("receipt-INV-BOUNDED-002.pdf")).toBe(
      "receipt for inv_bounded_002",
    );
  });

  it("returns 502 after transient receipt retries are exhausted", async () => {
    const customerId = `cus-failed-receipt-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub-failed-receipt-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    mockListStripeInvoices(() => {
      return Promise.resolve([
        {
          id: "inv_failed_receipt",
          number: "INV-FAILED-RECEIPT",
          created: Date.UTC(2026, 6, 10) / 1000,
          amount_paid: 2000,
          status: "paid",
          hosted_invoice_url: "https://stripe.test/invoice/inv_failed_receipt",
          invoice_pdf: "https://stripe.test/receipts/inv_failed_receipt",
        },
      ]);
    });
    let attempts = 0;
    server.use(
      http.get("https://stripe.test/receipts/inv_failed_receipt", () => {
        attempts += 1;
        return new HttpResponse(null, { status: 503 });
      }),
    );

    const client = setupApp({ context, routes: billingInvoicesRoutes })(
      billingInvoicesContract,
    );
    const response = await accept(
      client.downloadReceipts({
        headers: { authorization: "Bearer clerk-session" },
        query: { startMonth: "2026-07", endMonth: "2026-07" },
      }),
      [502],
    );

    expect(attempts).toBe(3);
    expect(response.body).toStrictEqual({
      error: {
        message: "Failed to download receipts from Stripe",
        code: "BAD_GATEWAY",
      },
    });
  });

  it("returns an empty list when the org has no Stripe customer", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockListStripeInvoices(() => {
      throw new Error("Stripe invoices should not be listed without customer");
    });

    const client = setupApp({ context, routes: billingInvoicesRoutes })(
      billingInvoicesContract,
    );

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      invoices: [],
    });
  });

  it("returns an empty list when Stripe returns no invoices", async () => {
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: `cus-empty-${randomUUID().slice(0, 8)}`,
          stripeSubscriptionId: `sub-empty-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    mockListStripeInvoices(() => {
      return Promise.resolve([]);
    });

    const client = setupApp({ context, routes: billingInvoicesRoutes })(
      billingInvoicesContract,
    );

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      invoices: [],
    });
  });
});
