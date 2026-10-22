import { randomUUID } from "node:crypto";

import { billingInvoicesContract } from "@okouai/api-contracts/contracts/billing";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockListStripeInvoices } from "../../external/stripe-client";
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
        },
        {
          id: "inv_002",
          number: "INV-2026-002",
          created: 1_737_400_000,
          amount_paid: 4000,
          status: "paid",
          hosted_invoice_url: "https://stripe.com/invoice/inv_002",
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
