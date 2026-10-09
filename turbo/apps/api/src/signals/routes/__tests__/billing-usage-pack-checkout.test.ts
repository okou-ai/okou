import { randomUUID } from "node:crypto";
import {
  USAGE_PACKS_USD,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
} from "@okouai/api-contracts/contracts/billing";
import StripeSDK from "stripe";
import { onTestFinished } from "vitest";
import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { mockStripeClient } from "../../external/stripe-client";
import { createDeferredPromise } from "../../utils";
import { billingCheckoutRoutes } from "../billing-checkout";

import { createBillingCheckoutFixture } from "./helpers/billing-checkout-fixture";

const {
  context,
  usagePackStateAction,
  APP_ORIGIN,
  TEST_PRICE_USAGE_PACK_PLAN_PRO,
  TEST_PRICE_USAGE_PACK_PLAN_TEAM,
  TEST_PRICE_USAGE_PACK_20,
  TEST_PRICE_USAGE_PACK_50,
  TEST_PRICE_USAGE_PACK_100,
  TEST_PRICE_USAGE_PACK_200,
  ClerkApiResponseTestError,
  setTierPrices,
  setUsagePackPrices,
  mockUsagePackCatalog,
  currentSecond,
  stripeInputMetadata,
  mockStatefulUsagePackCheckoutSessions,
  createOrgFixture,
  usagePackCheckoutBody,
  authenticateOrg,
  readBillingStatus,
  createStripeCustomerOrgForFixture,
  createUsagePackAtomGrantOrg,
} = createBillingCheckoutFixture();

describe("POST /api/billing/usage-pack-checkout", () => {
  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setTierPrices();
    setUsagePackPrices();
    mockUsagePackCatalog();
  });

  it("returns the server-validated Stripe usage pack catalog", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCatalogContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          totalCredits: 20_400,
        },
        {
          usagePackUsd: 50,
          priceUsd: 50,
          purchasedCredits: 50_000,
          bonusCredits: 2600,
          totalCredits: 52_600,
        },
        {
          usagePackUsd: 100,
          priceUsd: 100,
          purchasedCredits: 100_000,
          bonusCredits: 8700,
          totalCredits: 108_700,
        },
        {
          usagePackUsd: 200,
          priceUsd: 200,
          purchasedCredits: 200_000,
          bonusCredits: 22_200,
          totalCredits: 222_200,
        },
      ],
    });
  });

  it.each(["pro", "team"] as const)(
    "rejects %s checkout without a paid usage pack",
    async (tier) => {
      const fixture = createOrgFixture();
      authenticateOrg(fixture);

      const response = await accept(
        setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackCheckoutContract,
        ).create({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            tier,
            memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 0 }],
            successUrl: `${APP_ORIGIN}/billing?billing=success`,
            cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: "At least one member must have a paid usage pack",
          code: "BAD_REQUEST",
        },
      });
    },
  );

  it.each(["pro", "team"] as const)(
    "checks out %s with both paid and no-package members",
    async (tier) => {
      const fixture = createOrgFixture();
      const freeMemberId = `user_${randomUUID()}`;
      authenticateOrg(fixture);
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              role: "org:admin",
              publicUserData: { userId: fixture.userId },
              createdAt: now(),
            },
            {
              role: "org:member",
              publicUserData: { userId: freeMemberId },
              createdAt: now(),
            },
          ],
        },
      );
      context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
        { data: [] },
      );
      context.mocks.stripe.customers.create.mockResolvedValue({
        id: `cus_${randomUUID()}`,
      });
      let snapshotId: string | null = null;
      context.mocks.stripe.checkout.sessions.create.mockImplementation(
        (input) => {
          const metadata = stripeInputMetadata(input);
          snapshotId = metadata.usagePackSubscriptionId ?? null;
          if (!snapshotId) {
            throw new Error("Expected a subscription snapshot");
          }
          return Promise.resolve({
            id: `cs_${randomUUID()}`,
            url: "https://checkout.stripe.com/session/no-package-member",
          });
        },
      );
      await accept(
        setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackCheckoutContract,
        ).create({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            tier,
            memberUsagePacks: [
              { memberId: fixture.userId, usagePackUsd: 20 },
              { memberId: freeMemberId, usagePackUsd: 0 },
            ],
            successUrl: `${APP_ORIGIN}/billing?billing=success`,
            cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          },
        }),
        [200],
      );
      const createdSnapshotId = snapshotId;
      if (!createdSnapshotId) {
        throw new Error("Checkout did not create a snapshot");
      }
      onTestFinished(async () => {
        await usagePackStateAction({
          action: "cleanup",
          orgId: fixture.orgId,
          usagePackSubscriptionId: createdSnapshotId,
          deleteGrants: false,
          deleteOrgMetadata: false,
        });
      });
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [
            {
              price:
                tier === "pro"
                  ? TEST_PRICE_USAGE_PACK_PLAN_PRO
                  : TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              quantity: 1,
            },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
          ],
        }),
        expect.any(Object),
      );
    },
  );

  it("checks out the new plan", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const memberIds = Array.from({ length: 101 }, (_, index) => {
      return index === 0 ? fixture.userId : `user_${randomUUID()}`;
    });
    const invitationId = `inv_${randomUUID()}`;
    const customerId = `cus_${randomUUID()}`;
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      (args) => {
        const offset =
          typeof args === "object" &&
          args !== null &&
          "offset" in args &&
          typeof args.offset === "number"
            ? args.offset
            : 0;
        const limit =
          typeof args === "object" &&
          args !== null &&
          "limit" in args &&
          typeof args.limit === "number"
            ? args.limit
            : 100;
        return Promise.resolve({
          data: memberIds.slice(offset, offset + limit).map((userId) => {
            return {
              role: "org:member",
              publicUserData: { userId },
              createdAt: now(),
            };
          }),
        });
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: [
          {
            id: invitationId,
            emailAddress: "pending@example.com",
            role: "org:member",
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    let createdUsagePackSubscriptionId: string | null = null;
    const checkoutSessionId = `cs_${randomUUID()}`;
    context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
      (input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("metadata" in input) ||
          typeof input.metadata !== "object" ||
          input.metadata === null ||
          !("usagePackSubscriptionId" in input.metadata) ||
          typeof input.metadata.usagePackSubscriptionId !== "string"
        ) {
          throw new Error("Expected usage pack subscription metadata");
        }
        createdUsagePackSubscriptionId = input.metadata.usagePackSubscriptionId;
        return Promise.resolve({
          id: checkoutSessionId,
          url: "https://checkout.stripe.com/session/usage-pack",
        });
      },
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "team",
          memberUsagePacks: [
            ...memberIds.map((memberId, index) => {
              return {
                memberId,
                usagePackUsd: USAGE_PACKS_USD[index] ?? 20,
              };
            }),
            { memberId: invitationId, usagePackUsd: 20 },
          ],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/usage-pack",
    });
    if (!createdUsagePackSubscriptionId) {
      throw new Error("Checkout did not expose its usage pack subscription ID");
    }
    const createdSnapshotId = createdUsagePackSubscriptionId;
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: createdSnapshotId,
        deleteGrants: false,
        deleteOrgMetadata: false,
      });
    });
    const metadata = {
      orgId: fixture.orgId,
      tier: "team",
      priceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
      purpose: "usage_pack_subscription",
      usagePackSubscriptionId: createdSnapshotId,
    };
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      {
        mode: "subscription",
        customer: expect.any(String),
        line_items: [
          { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_20, quantity: 99 },
          { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_200, quantity: 1 },
        ],
        allow_promotion_codes: true,
        success_url: `${APP_ORIGIN}/billing?billing=success`,
        cancel_url: `${APP_ORIGIN}/billing?billing=canceled`,
        metadata,
        subscription_data: { metadata },
      },
      { idempotencyKey: `usage-pack-checkout:${createdSnapshotId}` },
    );
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenNthCalledWith(1, {
      organizationId: fixture.orgId,
      limit: 100,
      offset: 0,
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenNthCalledWith(2, {
      organizationId: fixture.orgId,
      limit: 100,
      offset: 100,
    });
  });

  it("separates the immediate balance-adjusted charge from the recurring amount", async () => {
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    authenticateOrg(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input !== "object" ||
        input === null ||
        !("preview_mode" in input)
      ) {
        throw new Error("Expected a usage pack invoice preview mode");
      }
      return Promise.resolve({
        id: `in_preview_${randomUUID()}`,
        customer: customerId,
        amount_due: input.preview_mode === "next" ? 2000 : 4000,
        currency: "usd",
        status: null,
        metadata: {},
        hosted_invoice_url: null,
        lines: { has_more: false, data: [] },
        parent: null,
      });
    });

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "pro",
          supportsInAppPreview: true,
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "preview",
      purchaseType: "usage_pack",
      tier: "pro",
      immediateAmountCents: 2000,
      nextRecurringAmountCents: 4000,
      currency: "usd",
      expiresAt: expect.any(String),
      previewToken: expect.any(String),
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({ preview_mode: "next" }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({ preview_mode: "recurring" }),
    );
    if (!("previewToken" in response.body)) {
      throw new Error("Expected a usage pack purchase preview");
    }

    const subscriptionId = `sub_${randomUUID()}`;
    const invoiceId = `in_${randomUUID()}`;
    const billingPeriod = {
      start: currentSecond(),
      end: currentSecond() + 30 * 86_400,
    };
    let usagePackSubscriptionId: string | undefined;
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.create.mockImplementation((input) => {
      const metadata = stripeInputMetadata(input);
      usagePackSubscriptionId = metadata.usagePackSubscriptionId;
      const paidInvoice = {
        id: invoiceId,
        customer: customerId,
        metadata,
        status: "paid" as const,
        paid: true,
        amount_due: 2000,
        amount_paid: 2000,
        currency: "usd",
        hosted_invoice_url: null,
        parent: {
          subscription_details: { subscription: subscriptionId, metadata },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID()}`,
              amount: 2000,
              subtotal: 2000,
              quantity: 1,
              price: { id: TEST_PRICE_USAGE_PACK_20 },
              period: billingPeriod,
              parent: {
                type: "subscription_item_details" as const,
                subscription_item_details: { proration: false },
              },
            },
          ],
        },
      };
      const subscription = {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        cancel_at: null,
        cancel_at_period_end: false,
        schedule: null,
        metadata,
        items: {
          data: [
            {
              id: `si_${randomUUID()}`,
              price: {
                id: TEST_PRICE_USAGE_PACK_PLAN_PRO,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 1,
              current_period_start: billingPeriod.start,
              current_period_end: billingPeriod.end,
            },
            {
              id: `si_${randomUUID()}`,
              price: {
                id: TEST_PRICE_USAGE_PACK_20,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 1,
              current_period_start: billingPeriod.start,
              current_period_end: billingPeriod.end,
            },
          ],
        },
        latest_invoice: paidInvoice,
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      return Promise.resolve(subscription);
    });

    const confirmation = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).confirm({
        body: { previewToken: response.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    if (!usagePackSubscriptionId) {
      throw new Error("Expected the confirmed usage pack subscription ID");
    }
    const confirmedUsagePackSubscriptionId = usagePackSubscriptionId;
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: confirmedUsagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });
  });

  it("recovers usage pack checkout from a transient Clerk server failure", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const checkoutSessionId = `cs_${randomUUID()}`;
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.organizations.getOrganizationMembershipList
      .mockRejectedValueOnce(new ClerkApiResponseTestError(2, 521))
      .mockResolvedValue({
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      });
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: `cus_${randomUUID()}`,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: checkoutSessionId,
      url: "https://checkout.stripe.com/session/usage-pack-recovered",
    });

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: usagePackCheckoutBody(fixture.userId),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const checkoutCall =
      context.mocks.stripe.checkout.sessions.create.mock.calls[0];
    const usagePackSubscriptionId = checkoutCall
      ? stripeInputMetadata(checkoutCall[0]).usagePackSubscriptionId
      : undefined;
    if (!usagePackSubscriptionId) {
      throw new Error("Checkout did not expose its usage pack subscription ID");
    }
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/usage-pack-recovered",
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(2);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );
  });

  it("returns a non-cacheable 503 on the first Clerk rate limit", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(7),
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: usagePackCheckoutBody(fixture.userId),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Billing organization members are temporarily unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("preserves non-rate-limit Clerk checkout failures", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new Error("Clerk membership read failed"),
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: usagePackCheckoutBody(fixture.userId),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("stops sibling Clerk pagination after a checkout directory rate limit", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const invitationPage = createDeferredPromise<{
      readonly data: readonly {
        readonly id: string;
        readonly emailAddress: string;
        readonly role: string;
        readonly createdAt: number;
      }[];
    }>(context.signal);
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(1),
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockReturnValueOnce(
      invitationPage.promise,
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: usagePackCheckoutBody(fixture.userId),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.headers.get("Retry-After")).toBe("1");
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();

    invitationPage.resolve({
      data: Array.from({ length: 100 }, (_, index) => {
        return {
          id: `inv_${index}`,
          emailAddress: `pending-${index}@example.com`,
          role: "org:member",
          createdAt: now(),
        };
      }),
    });
    await invitationPage.promise;
    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList,
    ).toHaveBeenCalledTimes(1);
  });

  it("stops Clerk 5xx retries when usage pack checkout is cancelled", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const controller = new AbortController();
    const retryStarted = createDeferredPromise<void>(context.signal);
    let retrySignal: AbortSignal | undefined;
    context.mocks.signalTimers.delay.mockImplementation((_ms, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Expected Clerk retry delay to receive a signal");
      }
      retrySignal = signal;
      retryStarted.resolve();
      return createDeferredPromise<void>(signal).promise;
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(1, 521),
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    const request = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    ).create({
      body: usagePackCheckoutBody(fixture.userId),
      headers: { authorization: "Bearer clerk-session" },
      fetchOptions: { signal: controller.signal },
    });

    await retryStarted.promise;
    const abortError = new Error("usage pack checkout cancelled");
    abortError.name = "AbortError";
    controller.abort(abortError);
    const response = await accept(request, [500]);

    expect(response.status).toBe(500);
    expect(retrySignal?.aborted).toBeTruthy();
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it.each(["pro", "team"] as const)(
    "configures the current %s plan after an Atom grant",
    async (tier) => {
      const fixture = await createUsagePackAtomGrantOrg(tier);
      await fixture.run(async () => {
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
          {
            data: [
              {
                role: "org:admin",
                publicUserData: { userId: fixture.userId },
                createdAt: now(),
              },
            ],
          },
        );
        context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
          { data: [] },
        );
        context.mocks.stripe.customers.create.mockResolvedValue({
          id: `cus_checkout_${randomUUID().slice(0, 8)}`,
        });
        const checkoutSessions = [
          {
            id: `cs_${randomUUID().slice(0, 8)}`,
            url: "https://checkout.stripe.com/session/atom-usage-pack",
          },
          {
            id: `cs_${randomUUID().slice(0, 8)}`,
            url: "https://checkout.stripe.com/session/atom-usage-pack-replaced",
          },
        ] as const;
        const usagePackSubscriptionIds: string[] = [];
        let checkoutAttempt = 0;
        context.mocks.stripe.checkout.sessions.create.mockImplementation(
          (input) => {
            if (
              typeof input !== "object" ||
              input === null ||
              !("metadata" in input) ||
              typeof input.metadata !== "object" ||
              input.metadata === null ||
              !("usagePackSubscriptionId" in input.metadata) ||
              typeof input.metadata.usagePackSubscriptionId !== "string"
            ) {
              throw new Error("Expected usage pack subscription metadata");
            }
            const session = checkoutSessions[checkoutAttempt];
            if (!session) {
              throw new Error("Unexpected extra usage pack Checkout Session");
            }
            checkoutAttempt += 1;
            usagePackSubscriptionIds.push(
              input.metadata.usagePackSubscriptionId,
            );
            return Promise.resolve(session);
          },
        );

        const client = setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackCheckoutContract,
        );
        const response = await fixture.run(() => {
          return accept(
            client.create({
              body: {
                tier,
                memberUsagePacks: [
                  { memberId: fixture.userId, usagePackUsd: 20 },
                ],
                successUrl: `${APP_ORIGIN}/billing?billing=success`,
                cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
              },
              headers: { authorization: "Bearer clerk-session" },
            }),
            [200],
          );
        });

        if (!("url" in response.body)) {
          throw new Error("Expected hosted usage pack checkout response");
        }
        expect(response.body.url).toBe(checkoutSessions[0].url);
        expect(
          context.mocks.stripe.checkout.sessions.create,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({
              orgId: fixture.orgId,
              tier,
              purpose: "usage_pack_subscription",
            }),
            line_items: [
              {
                price:
                  tier === "pro"
                    ? TEST_PRICE_USAGE_PACK_PLAN_PRO
                    : TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                quantity: 1,
              },
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ],
          }),
          expect.objectContaining({
            idempotencyKey: expect.stringContaining("usage-pack-checkout:"),
          }),
        );
        let retrievedSessions = 0;
        context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
          (id) => {
            expect(id).toBe(checkoutSessions[0].id);
            retrievedSessions += 1;
            if (retrievedSessions > 2) {
              throw new Error(
                "Unexpected extra Atom checkout session retrieval",
              );
            }
            return Promise.resolve({
              id: checkoutSessions[0].id,
              status: "open",
              url: checkoutSessions[0].url,
              customer: null,
              subscription: null,
              metadata: null,
            });
          },
        );

        const retried = await fixture.run(() => {
          return accept(
            client.create({
              body: {
                tier,
                memberUsagePacks: [
                  { memberId: fixture.userId, usagePackUsd: 20 },
                ],
                successUrl: `${APP_ORIGIN}/billing?billing=success`,
                cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
              },
              headers: { authorization: "Bearer clerk-session" },
            }),
            [200],
          );
        });

        if (!("url" in retried.body)) {
          throw new Error("Expected hosted usage pack checkout response");
        }
        expect(retried.body.url).toBe(checkoutSessions[0].url);
        expect(
          context.mocks.stripe.checkout.sessions.retrieve,
        ).toHaveBeenCalledWith(checkoutSessions[0].id);
        expect(
          context.mocks.stripe.checkout.sessions.create,
        ).toHaveBeenCalledTimes(1);

        let expiredSession = false;
        context.mocks.stripe.checkout.sessions.expire.mockImplementation(
          (id) => {
            expect(id).toBe(checkoutSessions[0].id);
            if (expiredSession) {
              throw new Error(
                "Unexpected extra Atom checkout session expiration",
              );
            }
            expiredSession = true;
            return Promise.resolve({
              id: checkoutSessions[0].id,
              status: "expired",
            });
          },
        );

        const replaced = await fixture.run(() => {
          return accept(
            client.create({
              body: {
                tier,
                memberUsagePacks: [
                  { memberId: fixture.userId, usagePackUsd: 50 },
                ],
                successUrl: `${APP_ORIGIN}/billing?billing=success`,
                cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
              },
              headers: { authorization: "Bearer clerk-session" },
            }),
            [200],
          );
        });

        if (!("url" in replaced.body)) {
          throw new Error("Expected hosted usage pack checkout response");
        }
        expect(replaced.body.url).toBe(checkoutSessions[1].url);
        expect(
          context.mocks.stripe.checkout.sessions.expire,
        ).toHaveBeenCalledWith(checkoutSessions[0].id);
        expect(
          context.mocks.stripe.checkout.sessions.create,
        ).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            line_items: [
              {
                price:
                  tier === "pro"
                    ? TEST_PRICE_USAGE_PACK_PLAN_PRO
                    : TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                quantity: 1,
              },
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
            ],
          }),
          expect.objectContaining({
            idempotencyKey: expect.stringContaining("usage-pack-checkout:"),
          }),
        );
        const [firstUsagePackSubscriptionId, replacementSubscriptionId] =
          usagePackSubscriptionIds;
        if (!firstUsagePackSubscriptionId || !replacementSubscriptionId) {
          throw new Error("Checkout did not create usage pack subscriptions");
        }
      });
    },
  );

  it("keeps only one payable Checkout across concurrent different configurations", async () => {
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    await createStripeCustomerOrgForFixture(fixture, customerId);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    const sessionStates = mockStatefulUsagePackCheckoutSessions();
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const before = await readBillingStatus(fixture);
    const body = (usagePackUsd: 20 | 50 | 100) => {
      return {
        tier: "pro" as const,
        memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd }],
        successUrl: `${APP_ORIGIN}/billing?billing=success`,
        cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
      };
    };

    const responses = await Promise.all([
      accept(
        client.create({
          body: body(20),
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200, 409],
      ),
      accept(
        client.create({
          body: body(50),
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200, 409],
      ),
    ]);

    expect(responses).toHaveLength(2);
    expect(
      responses.some((response) => {
        return response.status === 200;
      }),
    ).toBeTruthy();
    const createdSessions =
      context.mocks.stripe.checkout.sessions.create.mock.calls.length;
    expect(createdSessions).toBeOneOf([1, 2]);
    if (createdSessions === 2) {
      // A request that already created a known Session must expire its
      // noncanonical object. An earlier local conflict creates none.
      for (const price of [
        TEST_PRICE_USAGE_PACK_20,
        TEST_PRICE_USAGE_PACK_50,
      ]) {
        expect(
          context.mocks.stripe.checkout.sessions.create,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            line_items: expect.arrayContaining([{ price, quantity: 1 }]),
          }),
          expect.any(Object),
        );
      }
    } else {
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: expect.arrayContaining([
            {
              price: expect.toBeOneOf([
                TEST_PRICE_USAGE_PACK_20,
                TEST_PRICE_USAGE_PACK_50,
              ]),
              quantity: 1,
            },
          ]),
        }),
        expect.any(Object),
      );
    }
    expect(
      [...sessionStates.values()].filter((status) => {
        return status === "open";
      }),
    ).toHaveLength(1);
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledTimes(
      createdSessions - 1,
    );

    // Replacing the winner changes the purchase, but not the number of pending
    // purchases. It must remain usable without activating any unpaid credits.
    const replacement = await accept(
      client.create({
        body: body(100),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(replacement.body).toStrictEqual({
      url: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//),
    });
    expect(
      [...sessionStates.values()].filter((status) => {
        return status === "open";
      }),
    ).toHaveLength(1);
    const after = await readBillingStatus(fixture);
    expect(after.tier).toBe(before.tier);
    expect(after.credits).toBe(before.credits);

    for (const [input] of context.mocks.stripe.checkout.sessions.create.mock
      .calls) {
      const usagePackSubscriptionId =
        stripeInputMetadata(input).usagePackSubscriptionId;
      if (!usagePackSubscriptionId) {
        throw new Error("Checkout did not expose a usage pack subscription ID");
      }
      onTestFinished(async () => {
        await usagePackStateAction({
          action: "cleanup",
          orgId: fixture.orgId,
          usagePackSubscriptionId,
          deleteGrants: false,
          deleteOrgMetadata: false,
        });
      });
    }
  });

  it("renews the expiry of a reused purchase preview", async () => {
    const startedAt = new Date("2035-05-15T00:00:00.000Z");
    mockNow(startedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    authenticateOrg(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const body = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: [
        { memberId: fixture.userId, usagePackUsd: 20 as const },
      ],
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };

    const first = await accept(
      client.create({
        body,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in first.body)) {
      throw new Error("Expected an initial usage pack purchase preview");
    }
    expect(first.body.expiresAt).toBe(
      new Date(startedAt.getTime() + 15 * 60 * 1000).toISOString(),
    );
    mockNow(new Date(startedAt.getTime() + 14 * 60 * 1000));

    const reused = await accept(
      client.create({
        body,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in reused.body)) {
      throw new Error("Expected a reused usage pack purchase preview");
    }
    expect(reused.body.expiresAt).toBe(
      new Date(startedAt.getTime() + 29 * 60 * 1000).toISOString(),
    );
  });

  it("rejects a usage pack preview after a replacement retires its snapshot", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const purchaseBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: [
        { memberId: fixture.userId, usagePackUsd: 20 as const },
      ],
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };
    const firstPreview = await accept(
      client.create({
        body: purchaseBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await accept(
      client.create({
        body: {
          ...purchaseBody,
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 50 }],
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in firstPreview.body)) {
      throw new Error("Expected a usage pack purchase preview");
    }

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: firstPreview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(confirmation.body).toStrictEqual({
      error: {
        message: "Usage pack purchase preview is no longer valid",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it("rejects a replacement usage pack purchase while a confirmation owns the claim", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const purchaseBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: [
        { memberId: fixture.userId, usagePackUsd: 20 as const },
      ],
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };
    const preview = await accept(
      client.create({
        body: purchaseBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a usage pack purchase preview");
    }

    // The confirmation claimed its snapshot before calling Stripe. A
    // replacement purchase started while the subscription is being created
    // cannot retire that claim; it is a deterministic conflict instead.
    const subscriptionId = `sub_${randomUUID()}`;
    let confirmedSnapshotId: string | undefined;
    let replacementStatus: number | undefined;
    let confirmedMetadata: Record<string, string> | undefined;
    context.mocks.stripe.subscriptions.create.mockImplementation(
      async (input) => {
        const metadata = stripeInputMetadata(input);
        confirmedSnapshotId = metadata.usagePackSubscriptionId;
        confirmedMetadata = metadata;
        const replacement = await client.create({
          body: {
            ...purchaseBody,
            memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 50 }],
          },
          headers: { authorization: "Bearer clerk-session" },
        });
        replacementStatus = replacement.status;
        return {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          metadata,
          items: { data: [{ price: { id: TEST_PRICE_USAGE_PACK_PLAN_PRO } }] },
          latest_invoice: null,
        };
      },
    );

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: preview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(replacementStatus).toBe(409);
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    if (!confirmedSnapshotId) {
      throw new Error("Expected the confirmed usage pack snapshot ID");
    }
    expect(confirmation.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    const publishedMetadata = confirmedMetadata;
    if (!publishedMetadata) {
      throw new Error("Expected the published Stripe correlation metadata");
    }
    context.mocks.stripe.subscriptions.retrieve.mockImplementation((id) => {
      expect(id).toBe(subscriptionId);
      return Promise.resolve({
        id: subscriptionId,
        customer: customerId,
        status: "active",
        metadata: publishedMetadata,
        items: { data: [{ price: { id: TEST_PRICE_USAGE_PACK_PLAN_PRO } }] },
        latest_invoice: null,
      });
    });
    const repeated = await accept(
      client.confirm({
        body: { previewToken: preview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(repeated.body).toStrictEqual(confirmation.body);
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      subscriptionId,
      { expand: ["latest_invoice"] },
    );
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it("attempts the saved card for an open usage pack invoice", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.com/usage-pack-authentication";
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    const operationInvoice = {
      id: `in_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: "open" as const,
      metadata: {},
      hosted_invoice_url: hostedInvoiceUrl,
      lines: { has_more: false, data: [] },
      parent: null,
    };
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.create.mockResolvedValue({
      id: subscriptionId,
      customer: customerId,
      status: "incomplete",
      metadata: {},
      items: {
        data: [
          { price: { id: TEST_PRICE_USAGE_PACK_PLAN_PRO } },
          { price: { id: TEST_PRICE_USAGE_PACK_20 } },
        ],
      },
      latest_invoice: operationInvoice,
    });
    context.mocks.stripe.invoices.pay.mockRejectedValue(
      new Error("Payment requires customer authentication"),
    );
    context.mocks.stripe.invoices.retrieve.mockResolvedValue(operationInvoice);

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const start = await accept(
      client.create({
        body: {
          tier: "pro",
          supportsInAppPreview: true,
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in start.body)) {
      throw new Error("Expected a usage pack purchase preview");
    }

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: start.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      operationInvoice.id,
      {},
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          "billing-operation:usage-pack:",
        ),
      }),
    );
  });

  it("reuses concurrent usage pack previews after a delayed provider response", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    const invoicePreview = {
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    };
    const firstPreviewStarted = createDeferredPromise<void>(context.signal);
    const firstPreviewResponse = createDeferredPromise<typeof invoicePreview>(
      context.signal,
    );
    context.mocks.stripe.invoices.createPreview
      .mockResolvedValue(invoicePreview)
      .mockImplementationOnce(() => {
        firstPreviewStarted.resolve();
        return firstPreviewResponse.promise;
      });
    let createdSubscription:
      | {
          readonly id: string;
          readonly customer: string;
          readonly status: string;
          readonly metadata: Readonly<Record<string, string>>;
          readonly items: {
            readonly data: readonly {
              readonly price: { readonly id: string };
            }[];
          };
        }
      | undefined;
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    // The winner is held inside Stripe creation until the other
    // confirmation has answered, so both run against the same claim state.
    const otherConfirmationAnswered = createDeferredPromise<void>(
      context.signal,
    );
    context.mocks.stripe.subscriptions.create.mockImplementation(
      async (input) => {
        await otherConfirmationAnswered.promise;
        createdSubscription = {
          id: `sub_${randomUUID()}`,
          customer: customerId,
          status: "active",
          metadata: stripeInputMetadata(input),
          items: {
            data: [
              { price: { id: TEST_PRICE_USAGE_PACK_PLAN_PRO } },
              { price: { id: TEST_PRICE_USAGE_PACK_20 } },
            ],
          },
        };
        context.mocks.stripe.subscriptions.list.mockResolvedValue({
          data: [createdSubscription],
          has_more: false,
        });
        return {
          ...createdSubscription,
          latest_invoice: null,
        };
      },
    );
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId) => {
        if (!createdSubscription || subscriptionId !== createdSubscription.id) {
          throw new Error("Expected the created usage pack subscription");
        }
        return Promise.resolve({
          ...createdSubscription,
          latest_invoice: null,
        });
      },
    );

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const purchaseBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: [
        { memberId: fixture.userId, usagePackUsd: 20 as const },
      ],
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };
    const firstPreviewRequest = accept(
      client.create({
        body: purchaseBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    onTestFinished(async () => {
      if (!firstPreviewResponse.settled()) {
        firstPreviewResponse.resolve(invoicePreview);
      }
      if (!firstPreviewStarted.settled()) {
        firstPreviewStarted.resolve();
      }
      await Promise.allSettled([firstPreviewRequest]);
    });
    await firstPreviewStarted.promise;
    const secondPreview = await accept(
      client.create({
        body: purchaseBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    firstPreviewResponse.resolve(invoicePreview);
    const firstPreview = await firstPreviewRequest;
    if (
      !("previewToken" in firstPreview.body) ||
      !("previewToken" in secondPreview.body)
    ) {
      throw new Error("Expected two usage pack purchase previews");
    }
    for (const preview of [firstPreview.body, secondPreview.body]) {
      expect(preview).toMatchObject({
        immediateAmountCents: 4000,
        nextRecurringAmountCents: 4000,
        currency: "usd",
      });
    }
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: "limited-free-1",
      hasSubscription: false,
    });

    const confirmationRequests = [
      client.confirm({
        body: { previewToken: firstPreview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      client.confirm({
        body: { previewToken: secondPreview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
    ];
    onTestFinished(async () => {
      if (!otherConfirmationAnswered.settled()) {
        otherConfirmationAnswered.resolve();
      }
      await Promise.allSettled(confirmationRequests);
    });
    const firstAnswer = await Promise.race(confirmationRequests);
    expect(firstAnswer.status).toBe(409);
    otherConfirmationAnswered.resolve();
    const confirmations = await Promise.all(confirmationRequests);

    expect(
      confirmations
        .map(({ status }) => {
          return status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    // Both previews reuse one snapshot. Its claim admits exactly one
    // confirmation; the other is rejected before any provider write.
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: customerId,
        default_payment_method: paymentMethodId,
      }),
      expect.any(Object),
    );
  });

  it("reuses Checkout after its Session response outlives the cancelled request", async () => {
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    const checkoutSessionId = `cs_${randomUUID()}`;
    const checkoutUrl = "https://checkout.stripe.test/aborted-usage-pack";
    authenticateOrg(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    const controller = new AbortController();
    const abortError = new Error("API owner cancelled usage pack checkout");
    abortError.name = "AbortError";
    const ownerContext = {
      mocks: context.mocks,
      sessionHistoryBlobs: context.sessionHistoryBlobs,
      signal: controller.signal,
    };
    context.mocks.stripe.checkout.sessions.create.mockImplementation(() => {
      controller.abort(abortError);
      return Promise.resolve({ id: checkoutSessionId, url: checkoutUrl });
    });
    const body = usagePackCheckoutBody(fixture.userId);
    const headers = { authorization: "Bearer clerk-session" };
    const response = await setupApp({
      context: ownerContext,
      routes: billingCheckoutRoutes,
    })(billingUsagePackCheckoutContract).create({ body, headers });

    expect(response.status).toBe(500);
    expect(
      context.mocks.stripe.checkout.sessions.expire,
    ).not.toHaveBeenCalled();

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: checkoutSessionId,
      status: "open",
      url: checkoutUrl,
    });
    const reused = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({ body, headers }),
      [200],
    );
    expect(reused.body).toStrictEqual({ url: checkoutUrl });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledWith(checkoutSessionId);
    expect(
      context.mocks.stripe.checkout.sessions.expire,
    ).not.toHaveBeenCalled();
  });

  it("reuses an open Checkout when repeated usage pack previews lose their saved card", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    const checkoutSessionId = `cs_${randomUUID()}`;
    const checkoutUrl = "https://checkout.stripe.com/session/usage-pack-retry";
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    let customerRetrievalCount = 0;
    context.mocks.stripe.customers.retrieve.mockImplementation(() => {
      customerRetrievalCount += 1;
      return Promise.resolve({
        id: customerId,
        invoice_settings: {
          default_payment_method:
            customerRetrievalCount <= 2 ? paymentMethodId : null,
        },
        default_source: null,
      });
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: checkoutSessionId,
      url: checkoutUrl,
    });
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: checkoutSessionId,
      status: "open",
      url: checkoutUrl,
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const firstBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: [
        { memberId: fixture.userId, usagePackUsd: 20 as const },
      ],
      successUrl: `${APP_ORIGIN}/billing?billing=first-success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=first-canceled`,
    };
    const secondBody = {
      ...firstBody,
      successUrl: `${APP_ORIGIN}/settings?billing=second-success`,
      cancelUrl: `${APP_ORIGIN}/settings?billing=second-canceled`,
    };
    const firstPreview = await accept(
      client.create({
        body: firstBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const secondPreview = await accept(
      client.create({
        body: secondBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (
      !("previewToken" in firstPreview.body) ||
      !("previewToken" in secondPreview.body)
    ) {
      throw new Error("Expected two usage pack purchase previews");
    }

    const firstConfirmation = await accept(
      client.create({
        body: {
          ...firstBody,
          previewToken: firstPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const secondConfirmation = await accept(
      client.create({
        body: {
          ...secondBody,
          previewToken: secondPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const repeatedPurchase = await accept(
      client.create({
        body: secondBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(firstConfirmation.body).toStrictEqual({
      status: "checkout_required",
      checkoutUrl,
    });
    expect(secondConfirmation.body).toStrictEqual(firstConfirmation.body);
    expect(repeatedPurchase.body).toStrictEqual({ url: checkoutUrl });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledTimes(2);
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledWith(checkoutSessionId);
  });

  it("rejects stale member selections before creating checkout", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
          {
            role: "org:member",
            publicUserData: { userId: `user_${randomUUID()}` },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "pro",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Organization members changed; refresh billing and try again",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });
});
