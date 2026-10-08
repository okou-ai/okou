import { randomUUID } from "node:crypto";
import {
  billingConcurrencyCheckoutContract,
  billingConcurrencySubscriptionContract,
  billingDowngradeContract,
} from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import StripeSDK from "stripe";
import { onTestFinished } from "vitest";
import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { mockStripeClient } from "../../external/stripe-client";
import { billingConcurrencyCheckoutRoutes } from "../billing-concurrency-checkout";
import { billingConcurrencySubscriptionRoutes } from "../billing-concurrency-subscriptions";
import { billingDowngradeRoutes } from "../billing-downgrade";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import {
  postSubscriptionInvoicePaid,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";

import { createBillingCheckoutFixture } from "./helpers/billing-checkout-fixture";

const {
  context,
  mocks,
  APP_ORIGIN,
  TEST_PRICE_PRO,
  TEST_PRICE_TEAM,
  TEST_PRICE_CUSTOM,
  TEST_PRICE_USAGE_ALLOWANCE,
  TEST_PRICE_CONCURRENCY,
  setTierPrices,
  currentSecond,
  okouToken,
  readBillingStatus,
  createSubscriptionOrg,
  createOwnedBillingOrg,
  createPublicBillingOrg,
  createUsagePackAtomGrantOrg,
  createConcurrencySubscriptionOrg,
  createMergedConcurrencySubscriptionOrg,
  createMergedUsageAllowanceConcurrencySubscriptionOrg,
  seedMemberRole,
} = createBillingCheckoutFixture();

describe("POST /api/billing/concurrency-checkout", () => {
  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setTierPrices();
  });

  function recurringConcurrencyPreviewInvoice(quantity: number) {
    const line = {
      id: `il_${randomUUID()}`,
      amount: 10_000 * quantity,
      subtotal: 10_000 * quantity,
      quantity,
      price: { id: TEST_PRICE_CONCURRENCY },
      period: { start: 4_075_660_800, end: 4_078_252_800 },
      parent: {
        type: "subscription_item_details" as const,
        subscription_item_details: { proration: false },
      },
    };
    return {
      id: `in_recurring_${randomUUID()}`,
      amount_due: line.amount,
      currency: "usd",
      lines: { has_more: false, data: [line] },
    };
  }

  it("requires an active Plan subscription for a concurrency purchase", async () => {
    const fixture = await createUsagePackAtomGrantOrg("team");
    await fixture.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const response = await accept(
        setupApp({
          context,
          routes: billingConcurrencyCheckoutRoutes,
        })(billingConcurrencyCheckoutContract).create({
          body: {
            quantity: 3,
            successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
            cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: "An active Plan subscription is required to buy concurrency",
          code: "BAD_REQUEST",
        },
      });
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).not.toHaveBeenCalled();
    });
  });

  it("previews and adds concurrency to a Custom usage allowance subscription", async () => {
    const fixture = createOwnedBillingOrg();
    await fixture.run(async () => {
      await fixture.initialize();
      const customerId = `cus_${randomUUID().slice(0, 8)}`;
      const subscriptionId = `sub_${randomUUID()}`;
      const periodStart = new Date(now() - 86_400_000);
      const periodEnd = new Date(now() + 30 * 86_400_000);
      await postSubscriptionInvoicePaid(context.signal, {
        ...fixture,
        tier: "custom",
        customerId,
        subscriptionId,
        currentPeriodEnd: periodEnd,
      });
      await postUsageAllowanceInvoicePaid(context.signal, {
        ...fixture,
        customerId,
        subscriptionId,
        shortWindowSeconds: 18_000,
        shortWindowUnits: 625_000,
        weeklyWindowSeconds: 604_800,
        weeklyWindowUnits: 5_000_000,
        effectiveAt: periodStart,
        expiresAt: periodEnd,
      });
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const paymentMethodId = `pm_${randomUUID()}`;
      const allowanceItem = {
        id: `si_${TEST_PRICE_USAGE_ALLOWANCE}`,
        price: { id: TEST_PRICE_USAGE_ALLOWANCE },
        quantity: 1,
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subscriptionId,
        customer: customerId,
        default_payment_method: paymentMethodId,
        latest_invoice: null,
        pending_update: null,
        items: { data: [allowanceItem] },
      });
      const recurringInvoice = recurringConcurrencyPreviewInvoice(3);
      const allowanceLine = {
        ...recurringInvoice.lines.data[0],
        id: `il_${randomUUID()}`,
        amount: 200_000,
        subtotal: 200_000,
        quantity: 1,
        price: { id: TEST_PRICE_USAGE_ALLOWANCE },
      };
      context.mocks.stripe.invoices.createPreview
        .mockImplementationOnce((input) => {
          if (
            typeof input !== "object" ||
            input === null ||
            !("subscription_details" in input) ||
            typeof input.subscription_details !== "object" ||
            input.subscription_details === null ||
            !("proration_date" in input.subscription_details) ||
            typeof input.subscription_details.proration_date !== "number"
          ) {
            throw new Error("Expected a concurrency proration preview");
          }
          return Promise.resolve({
            id: `in_preview_${randomUUID()}`,
            amount_due: 5500,
            currency: "usd",
            lines: {
              data: [
                {
                  id: `il_${randomUUID()}`,
                  amount: 5500,
                  pricing: {
                    price_details: { price: TEST_PRICE_CONCURRENCY },
                  },
                  parent: {
                    subscription_item_details: { proration: true },
                  },
                  period: { start: input.subscription_details.proration_date },
                },
              ],
            },
          });
        })
        .mockResolvedValueOnce({
          ...recurringInvoice,
          amount_due: 230_000,
          lines: {
            has_more: false,
            data: [allowanceLine, ...recurringInvoice.lines.data],
          },
        });
      context.mocks.stripe.subscriptions.update.mockResolvedValue({
        id: subscriptionId,
        latest_invoice: null,
        pending_update: null,
        items: {
          data: [
            allowanceItem,
            {
              id: `si_${TEST_PRICE_CONCURRENCY}`,
              price: { id: TEST_PRICE_CONCURRENCY },
              quantity: 3,
            },
          ],
        },
      });

      const client = setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract);
      const preview = await accept(
        client.preview({
          body: {
            quantity: 3,
            supportsInAppPreview: true,
            returnUrl: `${APP_ORIGIN}/billing`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      const paymentMethodPreviewToken = preview.body.paymentMethodPreviewToken;
      if (!paymentMethodPreviewToken) {
        throw new Error("Expected a saved-payment-method preview token");
      }
      const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
      const purchase = await accept(
        client.create({
          body: {
            quantity: 3,
            paymentMethodPreviewToken,
            successUrl,
            cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(preview.body).toStrictEqual({
        currentQuantity: 0,
        targetQuantity: 3,
        immediateAmountCents: 5500,
        nextRecurringAmountCents: 30_000,
        currency: "usd",
        paymentMethodPreviewToken: expect.any(String),
      });
      expect(purchase.body).toStrictEqual({ url: successUrl });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        subscription: subscriptionId,
        preview_mode: "next",
        subscription_details: {
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
          proration_behavior: "always_invoice",
          proration_date: expect.any(Number),
        },
      });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        subscription: subscriptionId,
        preview_mode: "recurring",
        subscription_details: {
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
          proration_behavior: "none",
        },
      });
      expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
        1,
        subscriptionId,
        {
          default_payment_method: paymentMethodId,
        },
      );
      expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
        2,
        subscriptionId,
        {
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
          payment_behavior: "pending_if_incomplete",
          proration_behavior: "always_invoice",
          proration_date: expect.any(Number),
          expand: ["latest_invoice"],
        },
      );
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).not.toHaveBeenCalled();
    });
  });

  it("preserves an Atom allowance schedule and returns one payment page when adding concurrency", async () => {
    const fixture = createOwnedBillingOrg();
    await fixture.run(async () => {
      await fixture.initialize();
      const customerId = `cus_${randomUUID().slice(0, 8)}`;
      const subscriptionId = `sub_${randomUUID()}`;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const periodStart = new Date(now() - 86_400_000);
      const allowanceEnd = new Date(now() + 30 * 86_400_000);
      const customEnd = new Date(now() + 180 * 86_400_000);
      const legacyAllowanceCancelAt = new Date(
        allowanceEnd.getTime() + 86_400_000,
      ).toISOString();
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      await postSubscriptionInvoicePaid(context.signal, {
        ...fixture,
        tier: "custom",
        customerId,
        subscriptionId,
        currentPeriodEnd: customEnd,
      });
      await postUsageAllowanceInvoicePaid(context.signal, {
        ...fixture,
        customerId,
        subscriptionId,
        shortWindowSeconds: 18_000,
        shortWindowUnits: 625_000,
        weeklyWindowSeconds: 604_800,
        weeklyWindowUnits: 5_000_000,
        effectiveAt: periodStart,
        expiresAt: allowanceEnd,
      });
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const periodStartUnix = Math.floor(periodStart.getTime() / 1000);
      const allowanceEndUnix = Math.floor(allowanceEnd.getTime() / 1000);
      const customEndUnix = Math.floor(customEnd.getTime() / 1000);
      const customItem = {
        id: `si_${TEST_PRICE_CUSTOM}`,
        price: { id: TEST_PRICE_CUSTOM },
        quantity: 1,
        metadata: {},
      };
      const allowanceMetadata = {
        allowanceStatus: "active",
        allowanceCancelAt: allowanceEnd.toISOString(),
        purpose: "usage_allowance",
        source: "atom_usage_allowance",
        orgId: fixture.orgId,
      };
      const allowanceItem = {
        id: `si_${TEST_PRICE_USAGE_ALLOWANCE}`,
        price: { id: TEST_PRICE_USAGE_ALLOWANCE },
        quantity: 1,
        metadata: allowanceMetadata,
      };
      const discountId = `di_${randomUUID()}`;
      const couponId = `coupon_${randomUUID()}`;
      const phaseDiscounts = [
        {
          coupon: null,
          discount: discountId,
          promotion_code: null,
        },
        {
          coupon: couponId,
          discount: null,
          promotion_code: null,
        },
      ];
      const schedule = {
        id: scheduleId,
        end_behavior: "cancel",
        current_phase: {
          start_date: periodStartUnix,
          end_date: allowanceEndUnix,
        },
        phases: [
          {
            start_date: periodStartUnix,
            end_date: allowanceEndUnix,
            currency: "usd",
            discounts: phaseDiscounts,
            metadata: {
              allowanceStatus: "active",
              allowanceCancelAt: legacyAllowanceCancelAt,
            },
            items: [customItem, allowanceItem],
            proration_behavior: "create_prorations",
          },
          {
            start_date: allowanceEndUnix,
            end_date: customEndUnix,
            currency: "usd",
            metadata: {
              allowanceStatus: "active",
              allowanceCancelAt: legacyAllowanceCancelAt,
              phase: "after-allowance",
            },
            items: [customItem],
            proration_behavior: "create_prorations",
          },
        ],
      };
      const subscription = {
        id: subscriptionId,
        customer: customerId,
        default_payment_method: null,
        default_source: null,
        status: "active",
        cancel_at: null,
        cancel_at_period_end: false,
        latest_invoice: null,
        metadata: {
          allowanceStatus: "canceled",
          allowanceCancelAt: allowanceEnd.toISOString(),
        },
        pending_update: null,
        schedule: scheduleId,
        items: { data: [customItem, allowanceItem] },
      };
      const concurrencyInvoiceId = `in_concurrency_${randomUUID()}`;
      const updatedSubscription = {
        ...subscription,
        latest_invoice: {
          id: concurrencyInvoiceId,
          status: "draft",
          paid: false,
          hosted_invoice_url: null,
        },
        items: {
          data: [
            customItem,
            allowanceItem,
            {
              id: `si_${TEST_PRICE_CONCURRENCY}`,
              price: { id: TEST_PRICE_CONCURRENCY },
              quantity: 3,
            },
          ],
        },
      };
      context.mocks.stripe.subscriptions.retrieve.mockReset();
      context.mocks.stripe.subscriptions.retrieve
        .mockResolvedValueOnce(subscription)
        .mockResolvedValueOnce(subscription)
        .mockResolvedValueOnce(subscription)
        .mockResolvedValueOnce(updatedSubscription);
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        invoice_settings: { default_payment_method: null },
        default_source: null,
      });
      context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
      context.mocks.stripe.subscriptionSchedules.retrieve.mockReset();
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
        schedule,
      );
      context.mocks.stripe.subscriptionSchedules.update.mockReset();
      context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
      });
      context.mocks.stripe.invoices.createPreview.mockReset();
      context.mocks.stripe.invoices.createPreview.mockImplementation(
        (input) => {
          if (
            typeof input === "object" &&
            input !== null &&
            "subscription_details" in input &&
            typeof input.subscription_details === "object" &&
            input.subscription_details !== null &&
            "proration_date" in input.subscription_details &&
            typeof input.subscription_details.proration_date === "number"
          ) {
            return Promise.resolve({
              id: `in_preview_${randomUUID()}`,
              amount_due: 15_000,
              currency: "usd",
              lines: {
                has_more: false,
                data: [
                  {
                    id: `il_${randomUUID()}`,
                    amount: 15_000,
                    price: { id: TEST_PRICE_CONCURRENCY },
                    period: {
                      start: input.subscription_details.proration_date,
                    },
                    parent: {
                      subscription_item_details: { proration: true },
                    },
                  },
                ],
              },
            });
          }
          return Promise.resolve(recurringConcurrencyPreviewInvoice(3));
        },
      );
      const hostedInvoiceUrl = `https://invoice.stripe.test/${concurrencyInvoiceId}`;
      const openConcurrencyInvoice = {
        id: concurrencyInvoiceId,
        status: "open",
        paid: false,
        hosted_invoice_url: hostedInvoiceUrl,
      };
      context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue(
        openConcurrencyInvoice,
      );
      context.mocks.stripe.invoices.pay.mockRejectedValue(
        new Error("No payment method"),
      );
      context.mocks.stripe.invoices.retrieve.mockResolvedValue(
        openConcurrencyInvoice,
      );

      const client = setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract);
      const preview = await accept(
        client.preview({
          body: {
            quantity: 3,
            supportsInAppPreview: true,
            returnUrl: `${APP_ORIGIN}/billing`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
      const purchase = await accept(
        client.create({
          body: {
            quantity: 3,
            successUrl,
            cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      const expectedPhases = [
        {
          start_date: periodStartUnix,
          end_date: allowanceEndUnix,
          currency: "usd",
          metadata: {
            allowanceStatus: "canceled",
            allowanceCancelAt: allowanceEnd.toISOString(),
          },
          items: [
            {
              price: TEST_PRICE_CUSTOM,
              quantity: 1,
              metadata: {},
            },
            {
              price: TEST_PRICE_USAGE_ALLOWANCE,
              quantity: 1,
              metadata: allowanceMetadata,
            },
            { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
          ],
          proration_behavior: "create_prorations",
          discounts: [{ discount: discountId }, { coupon: couponId }],
        },
        {
          start_date: allowanceEndUnix,
          end_date: customEndUnix,
          currency: "usd",
          items: [
            {
              price: TEST_PRICE_CUSTOM,
              quantity: 1,
              metadata: {},
            },
            { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
          ],
          metadata: {
            allowanceStatus: "canceled",
            allowanceCancelAt: allowanceEnd.toISOString(),
            phase: "after-allowance",
          },
          proration_behavior: "create_prorations",
        },
      ];
      expect(preview.body).toStrictEqual({
        currentQuantity: 0,
        targetQuantity: 3,
        immediateAmountCents: 15_000,
        nextRecurringAmountCents: 30_000,
        currency: "usd",
      });
      expect(preview.body).not.toHaveProperty("checkoutUrl");
      expect(preview.body).not.toHaveProperty("paymentMethodPreviewToken");
      expect(purchase.body).toStrictEqual({ url: hostedInvoiceUrl });
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).not.toHaveBeenCalled();
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        schedule: scheduleId,
        preview_mode: "next",
        schedule_details: {
          end_behavior: "cancel",
          proration_behavior: "none",
          phases: expectedPhases,
        },
      });
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).toHaveBeenCalledWith(
        scheduleId,
        {
          end_behavior: "cancel",
          proration_behavior: "always_invoice",
          phases: expectedPhases,
        },
        {
          idempotencyKey: expect.stringMatching(
            /^concurrency-change:[^:]+:[^:]+:schedule-update$/u,
          ),
        },
      );
      expect(
        context.mocks.stripe.subscriptionSchedules.release,
      ).not.toHaveBeenCalled();
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.invoices.finalizeInvoice,
      ).toHaveBeenCalledWith(
        concurrencyInvoiceId,
        {},
        {
          idempotencyKey: `concurrency-change:${subscriptionId}:${concurrencyInvoiceId}:finalize`,
        },
      );
      expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
        concurrencyInvoiceId,
        {},
        {
          idempotencyKey: `concurrency-change:${subscriptionId}:${concurrencyInvoiceId}:pay`,
        },
      );
    });
  });

  it("schedules a concurrency reduction at its monthly renewal inside an Atom allowance schedule", async () => {
    const fixture = createOwnedBillingOrg();
    await fixture.run(async () => {
      await fixture.initialize();
      const customerId = `cus_${randomUUID().slice(0, 8)}`;
      const subscriptionId = `sub_${randomUUID()}`;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const currentTimestamp = currentSecond();
      const periodStart = new Date((currentTimestamp - 86_400) * 1000);
      const concurrencyPeriodEnd = new Date(
        (currentTimestamp + 29 * 86_400) * 1000,
      );
      const allowanceEnd = new Date((currentTimestamp + 90 * 86_400) * 1000);
      const customEnd = new Date((currentTimestamp + 180 * 86_400) * 1000);
      const legacyAllowanceCancelAt = new Date(
        (currentTimestamp + 91 * 86_400) * 1000,
      ).toISOString();
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      await postSubscriptionInvoicePaid(context.signal, {
        ...fixture,
        tier: "custom",
        customerId,
        subscriptionId,
        currentPeriodEnd: customEnd,
      });
      await postUsageAllowanceInvoicePaid(context.signal, {
        ...fixture,
        customerId,
        subscriptionId,
        shortWindowSeconds: 18_000,
        shortWindowUnits: 625_000,
        weeklyWindowSeconds: 604_800,
        weeklyWindowUnits: 5_000_000,
        effectiveAt: periodStart,
        expiresAt: allowanceEnd,
      });
      const periodStartUnix = Math.floor(periodStart.getTime() / 1000);
      const concurrencyPeriodEndUnix = Math.floor(
        concurrencyPeriodEnd.getTime() / 1000,
      );
      const allowanceEndUnix = Math.floor(allowanceEnd.getTime() / 1000);
      const customEndUnix = Math.floor(customEnd.getTime() / 1000);
      const concurrencyItemId = `si_${TEST_PRICE_CONCURRENCY}`;
      const concurrencyInvoiceEvent = {
        type: "invoice.paid",
        data: {
          object: {
            id: `in_${randomUUID()}`,
            customer: customerId,
            metadata: {},
            parent: {
              subscription_details: {
                subscription: subscriptionId,
                metadata: {},
              },
            },
            lines: {
              has_more: false,
              data: [
                {
                  id: `il_${randomUUID()}`,
                  quantity: 10,
                  price: { id: TEST_PRICE_CONCURRENCY },
                  parent: { type: "subscription_item_details" },
                  period: {
                    start: periodStartUnix,
                    end: concurrencyPeriodEndUnix,
                  },
                },
              ],
            },
          },
        },
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
        id: subscriptionId,
        customer: customerId,
        status: "active",
        cancel_at_period_end: false,
        items: {
          data: [
            { price: { id: TEST_PRICE_CUSTOM }, quantity: 1 },
            {
              id: concurrencyItemId,
              price: { id: TEST_PRICE_CONCURRENCY },
              quantity: 10,
              current_period_end: concurrencyPeriodEndUnix,
            },
          ],
        },
      });
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(
        concurrencyInvoiceEvent,
      );
      await accept(
        setupApp({ context, routes: webhooksStripeRoutes })(
          webhookStripeContract,
        ).post({
          body: JSON.stringify(concurrencyInvoiceEvent),
          extraHeaders: { "stripe-signature": "t=1,v1=concurrency-monthly" },
        }),
        [200],
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const customItem = {
        id: `si_${TEST_PRICE_CUSTOM}`,
        price: { id: TEST_PRICE_CUSTOM },
        quantity: 1,
      };
      const allowanceMetadata = {
        purpose: "usage_allowance",
        source: "atom_usage_allowance",
        orgId: fixture.orgId,
      };
      const allowanceItem = {
        id: `si_${TEST_PRICE_USAGE_ALLOWANCE}`,
        price: { id: TEST_PRICE_USAGE_ALLOWANCE },
        quantity: 1,
        metadata: allowanceMetadata,
      };
      const concurrencyItem = {
        id: concurrencyItemId,
        price: {
          id: TEST_PRICE_CONCURRENCY,
          recurring: { interval: "month" as const, interval_count: 1 },
        },
        quantity: 10,
        current_period_start: periodStartUnix,
        current_period_end: concurrencyPeriodEndUnix,
      };
      const schedule = {
        id: scheduleId,
        end_behavior: "cancel" as const,
        current_phase: {
          start_date: periodStartUnix,
          end_date: allowanceEndUnix,
        },
        phases: [
          {
            start_date: periodStartUnix,
            end_date: allowanceEndUnix,
            currency: "usd",
            metadata: {
              allowanceStatus: "active",
              allowanceCancelAt: legacyAllowanceCancelAt,
            },
            items: [customItem, allowanceItem, concurrencyItem],
            proration_behavior: "none" as const,
          },
          {
            start_date: allowanceEndUnix,
            end_date: customEndUnix,
            currency: "usd",
            metadata: {
              allowanceStatus: "active",
              allowanceCancelAt: legacyAllowanceCancelAt,
              phase: "after-allowance",
            },
            items: [customItem, concurrencyItem],
            proration_behavior: "none" as const,
          },
        ],
      };
      const subscription = {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        cancel_at_period_end: false,
        latest_invoice: null,
        metadata: {
          allowanceStatus: "canceled",
          allowanceCancelAt: allowanceEnd.toISOString(),
        },
        pending_update: null,
        schedule: scheduleId,
        items: { data: [customItem, allowanceItem, concurrencyItem] },
      };
      context.mocks.stripe.subscriptions.retrieve.mockReset();
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      context.mocks.stripe.subscriptionSchedules.retrieve.mockReset();
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
        schedule,
      );
      context.mocks.stripe.subscriptionSchedules.update.mockReset();
      context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
      });
      context.mocks.stripe.invoices.createPreview.mockReset();
      context.mocks.stripe.invoices.createPreview.mockResolvedValue(
        recurringConcurrencyPreviewInvoice(5),
      );

      const client = setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract);
      const preview = await accept(
        client.previewChange({
          params: { subscriptionId },
          body: { quantity: 5 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      const expectedPhases = [
        {
          start_date: periodStartUnix,
          end_date: concurrencyPeriodEndUnix,
          currency: "usd",
          metadata: {
            allowanceStatus: "canceled",
            allowanceCancelAt: allowanceEnd.toISOString(),
          },
          items: [
            { price: TEST_PRICE_CUSTOM, quantity: 1 },
            {
              price: TEST_PRICE_USAGE_ALLOWANCE,
              quantity: 1,
              metadata: allowanceMetadata,
            },
            { price: TEST_PRICE_CONCURRENCY, quantity: 10 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: concurrencyPeriodEndUnix,
          end_date: allowanceEndUnix,
          currency: "usd",
          metadata: {
            allowanceStatus: "canceled",
            allowanceCancelAt: allowanceEnd.toISOString(),
          },
          items: [
            { price: TEST_PRICE_CUSTOM, quantity: 1 },
            {
              price: TEST_PRICE_USAGE_ALLOWANCE,
              quantity: 1,
              metadata: allowanceMetadata,
            },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: allowanceEndUnix,
          end_date: customEndUnix,
          currency: "usd",
          items: [
            { price: TEST_PRICE_CUSTOM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
          metadata: {
            allowanceStatus: "canceled",
            allowanceCancelAt: allowanceEnd.toISOString(),
            phase: "after-allowance",
          },
          proration_behavior: "none",
        },
      ];
      expect(preview.body).toStrictEqual({
        currentQuantity: 10,
        targetQuantity: 5,
        immediateAmountCents: 0,
        nextRecurringAmountCents: 50_000,
        currency: "usd",
        effectiveAt: concurrencyPeriodEnd.toISOString(),
      });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        schedule: scheduleId,
        preview_mode: "next",
        schedule_details: {
          end_behavior: "cancel",
          proration_behavior: "none",
          phases: expectedPhases,
        },
      });

      const confirmed = await accept(
        client.confirmChange({
          params: { subscriptionId },
          body: { quantity: 5 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(confirmed.body).toStrictEqual({
        status: "completed",
        hostedInvoiceUrl: null,
        effectiveAt: concurrencyPeriodEnd.toISOString(),
      });
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).toHaveBeenCalledWith(
        scheduleId,
        {
          end_behavior: "cancel",
          proration_behavior: "none",
          phases: expectedPhases,
        },
        { idempotencyKey: expect.any(String) },
      );
    });
  });

  it.each([false, true])(
    "previews a first concurrency purchase on the Plan subscription (neutral schedule: %s)",
    async (hasNeutralSchedule) => {
      context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
        data: [],
        has_more: false,
      });
      const fixture = await createSubscriptionOrg({ tier: "custom" });
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const scheduleId = `sub_sched_${randomUUID()}`;
      const periodStart = currentSecond() - 86_400;
      const periodEnd = currentSecond() + 29 * 86_400;
      const planItem = {
        id: `si_${TEST_PRICE_CUSTOM}`,
        price: { id: TEST_PRICE_CUSTOM },
        quantity: 1,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
        id: fixture.subscriptionId,
        customer: fixture.customerId,
        pending_update: null,
        schedule: hasNeutralSchedule ? scheduleId : null,
        items: { data: [planItem] },
      });
      if (hasNeutralSchedule) {
        context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
          id: scheduleId,
          end_behavior: "release",
          current_phase: { start_date: periodStart, end_date: periodEnd },
          phases: [
            {
              start_date: periodStart,
              end_date: periodEnd,
              items: [{ price: TEST_PRICE_CUSTOM, quantity: 1 }],
            },
            {
              start_date: periodEnd,
              end_date: periodEnd + 30 * 86_400,
              items: [{ price: TEST_PRICE_CUSTOM, quantity: 1 }],
            },
          ],
        });
      }
      const recurringInvoice = recurringConcurrencyPreviewInvoice(3);
      const planLine = {
        ...recurringInvoice.lines.data[0],
        id: `il_${randomUUID()}`,
        amount: 20_000,
        subtotal: 20_000,
        quantity: 1,
        price: { id: TEST_PRICE_TEAM },
      };
      context.mocks.stripe.invoices.listLineItems.mockResolvedValueOnce({
        has_more: false,
        data: [planLine, ...recurringInvoice.lines.data],
      });
      context.mocks.stripe.invoices.createPreview
        .mockImplementationOnce((input) => {
          if (
            typeof input !== "object" ||
            input === null ||
            !("subscription_details" in input) ||
            typeof input.subscription_details !== "object" ||
            input.subscription_details === null ||
            !("proration_date" in input.subscription_details) ||
            typeof input.subscription_details.proration_date !== "number"
          ) {
            throw new Error("Expected a concurrency proration preview");
          }
          const prorationDate = input.subscription_details.proration_date;
          return Promise.resolve({
            id: `in_preview_${randomUUID()}`,
            amount_due: 5500,
            currency: "usd",
            lines: {
              data: [
                {
                  id: `il_${randomUUID()}`,
                  amount: 5500,
                  pricing: {
                    price_details: { price: TEST_PRICE_CONCURRENCY },
                  },
                  parent: {
                    subscription_item_details: { proration: true },
                  },
                  period: { start: prorationDate },
                },
              ],
            },
          });
        })
        .mockImplementationOnce((input) => {
          if (
            hasNeutralSchedule &&
            typeof input === "object" &&
            input !== null &&
            "preview_mode" in input &&
            input.preview_mode === "recurring" &&
            "subscription" in input
          ) {
            throw new Error(
              "Recurring estimates do not support subscription schedules",
            );
          }
          return Promise.resolve({
            ...recurringInvoice,
            amount_due: 50_000,
            lines: { has_more: true, data: [planLine] },
          });
        });

      const response = await accept(
        setupApp({
          context,
          routes: billingConcurrencyCheckoutRoutes,
        })(billingConcurrencyCheckoutContract).preview({
          body: { quantity: 3 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        currentQuantity: 0,
        targetQuantity: 3,
        immediateAmountCents: 5500,
        nextRecurringAmountCents: 30_000,
        currency: "usd",
      });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        subscription: fixture.subscriptionId,
        preview_mode: "next",
        subscription_details: {
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
          proration_behavior: "always_invoice",
          proration_date: expect.any(Number),
        },
      });
      expect(context.mocks.stripe.invoices.listLineItems).toHaveBeenCalledWith(
        recurringInvoice.id,
        { limit: 100 },
      );
      if (hasNeutralSchedule) {
        expect(
          context.mocks.stripe.invoices.createPreview,
        ).toHaveBeenCalledWith({
          schedule: scheduleId,
          preview_mode: "next",
          schedule_details: {
            end_behavior: "release",
            proration_behavior: "none",
            phases: [
              {
                start_date: periodStart,
                end_date: periodEnd,
                items: [
                  { price: TEST_PRICE_CUSTOM, quantity: 1 },
                  { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
                ],
                proration_behavior: "none",
              },
              {
                start_date: periodEnd,
                end_date: periodEnd + 30 * 86_400,
                items: [
                  { price: TEST_PRICE_CUSTOM, quantity: 1 },
                  { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
                ],
                proration_behavior: "none",
              },
            ],
          },
        });
      } else {
        expect(
          context.mocks.stripe.invoices.createPreview,
        ).toHaveBeenCalledWith({
          subscription: fixture.subscriptionId,
          preview_mode: "recurring",
          subscription_details: {
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
            proration_behavior: "none",
          },
        });
      }
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.release,
      ).not.toHaveBeenCalled();
    },
  );

  it("allows concurrency to expire with a Team subscription canceling at period end", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const planItem = {
      id: `si_${TEST_PRICE_TEAM}`,
      price: { id: TEST_PRICE_TEAM },
      quantity: 1,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    const subscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: periodEnd,
      cancel_at_period_end: true,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: null,
      items: { data: [planItem] },
    };
    const concurrencyItem = {
      id: `si_${TEST_PRICE_CONCURRENCY}`,
      price: { id: TEST_PRICE_CONCURRENCY },
      quantity: 3,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptions.update.mockReset();
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...subscription,
      items: { data: [planItem, concurrencyItem] },
    });
    context.mocks.stripe.invoices.createPreview.mockReset();
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        "proration_date" in input.subscription_details &&
        typeof input.subscription_details.proration_date === "number"
      ) {
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 15_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 15_000,
                price: { id: TEST_PRICE_CONCURRENCY },
                period: { start: input.subscription_details.proration_date },
                parent: {
                  subscription_item_details: { proration: true },
                },
              },
            ],
          },
        });
      }
      return Promise.reject(
        new StripeSDK.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          message:
            "Recurring estimates do not support the following features: subscription prorations, trials, cancellations, prebilling, schedules, and invoice item additions.",
        }),
      );
    });

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const preview = await accept(
      client.preview({
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
    const purchase = await accept(
      client.create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });
    expect(purchase.body).toStrictEqual({ url: successUrl });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      1,
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: fixture.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        cancel_at_period_end: false,
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
      },
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("previews and applies a concurrency increase without restoring the ending Plan", async () => {
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(periodEnd * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const planItem = {
      id: `si_${TEST_PRICE_TEAM}`,
      price: { id: TEST_PRICE_TEAM },
      quantity: 1,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    const concurrencyItem = {
      id: fixture.concurrencyItemId,
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 5,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    const cancelingSubscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: periodEnd,
      cancel_at_period_end: false,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: null,
      items: { data: [planItem, concurrencyItem] },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      cancelingSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockReset();
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...cancelingSubscription,
      items: {
        data: [planItem, { ...concurrencyItem, quantity: 7 }],
      },
    });
    context.mocks.stripe.invoices.createPreview.mockReset();
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      const details =
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null
          ? input.subscription_details
          : null;
      if (
        details &&
        "proration_date" in details &&
        typeof details.proration_date === "number"
      ) {
        if (
          !("cancel_at" in details) ||
          details.cancel_at !== "" ||
          "cancel_at_period_end" in details
        ) {
          throw new Error("Expected the preview to simulate an active Plan");
        }
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 12_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 12_000,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: { start: details.proration_date },
              },
            ],
          },
        });
      }
      return Promise.reject(
        new StripeSDK.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          message:
            "Recurring estimates do not support the following features: subscription prorations, trials, cancellations, prebilling, schedules, and invoice item additions.",
        }),
      );
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    const preview = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 7 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 7,
      immediateAmountCents: 12_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 7 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "processing",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      1,
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: fixture.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        cancel_at: "",
        items: [{ id: fixture.concurrencyItemId, quantity: 7 }],
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
      },
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ id: fixture.concurrencyItemId, quantity: 7 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    const updateParams =
      context.mocks.stripe.subscriptions.update.mock.calls[0]?.[1];
    expect(updateParams).not.toHaveProperty("cancel_at");
    expect(updateParams).not.toHaveProperty("cancel_at_period_end");
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
  });

  it("rejects deferred concurrency changes that cannot precede the Plan end", async () => {
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(periodEnd * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const cancelingSubscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: periodEnd,
      cancel_at_period_end: true,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStart,
            current_period_end: periodEnd,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month" as const, interval_count: 1 },
            },
            quantity: 5,
            current_period_start: periodStart,
            current_period_end: periodEnd,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      cancelingSubscription,
    );
    context.mocks.stripe.invoices.createPreview.mockClear();
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.subscriptionSchedules.create.mockClear();
    context.mocks.stripe.subscriptionSchedules.update.mockClear();
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    const expectedReductionError = {
      error: {
        message:
          "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    };

    const preview = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    const confirm = await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    const canceled = await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(preview.body).toStrictEqual(expectedReductionError);
    expect(confirm.body).toStrictEqual(expectedReductionError);
    expect(canceled.body).toStrictEqual({
      error: {
        message:
          "Restore your Plan before canceling concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("rejects a concurrency reduction at the end of a Plan cancellation schedule", async () => {
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(periodEnd * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const items = [
      {
        id: `si_${TEST_PRICE_TEAM}`,
        price: { id: TEST_PRICE_TEAM },
        quantity: 1,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
      {
        id: fixture.concurrencyItemId,
        price: {
          id: TEST_PRICE_CONCURRENCY,
          recurring: { interval: "month" as const, interval_count: 1 },
        },
        quantity: 5,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
    ];
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: scheduleId,
      items: { data: items },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockReset();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "cancel",
      current_phase: { start_date: periodStart, end_date: periodEnd },
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
        },
      ],
    });
    context.mocks.stripe.invoices.createPreview.mockClear();
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("adds concurrency to an attached Team cancellation schedule", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const planItem = {
      id: `si_${TEST_PRICE_TEAM}`,
      price: { id: TEST_PRICE_TEAM },
      quantity: 1,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    const subscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: scheduleId,
      items: { data: [planItem] },
    };
    const schedule = {
      id: scheduleId,
      end_behavior: "cancel" as const,
      current_phase: { start_date: periodStart, end_date: periodEnd },
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
          proration_behavior: "none" as const,
        },
      ],
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockReset();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      schedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
      schedule,
    );
    context.mocks.stripe.invoices.createPreview.mockReset();
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        "proration_date" in input.subscription_details &&
        typeof input.subscription_details.proration_date === "number"
      ) {
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 15_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 15_000,
                price: { id: TEST_PRICE_CONCURRENCY },
                period: { start: input.subscription_details.proration_date },
                parent: {
                  subscription_item_details: { proration: true },
                },
              },
            ],
          },
        });
      }
      return Promise.reject(
        new StripeSDK.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          code: "invoice_upcoming_none",
          message: `No upcoming invoices for schedule: ${scheduleId}`,
        }),
      );
    });

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const preview = await accept(
      client.preview({
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
    const purchase = await accept(
      client.create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const phases = [
      {
        start_date: periodStart,
        end_date: periodEnd,
        items: [
          { price: TEST_PRICE_TEAM, quantity: 1 },
          { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
        ],
        proration_behavior: "none",
      },
    ];
    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });
    expect(purchase.body).toStrictEqual({ url: successUrl });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      2,
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases,
      },
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "always_invoice",
        phases,
      },
      {
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:[^:]+:[^:]+:schedule-update$/u,
        ),
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("rejects a concurrency purchase while the Plan has a scheduled change", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const scheduleId = `sub_sched_plan_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.invoices.createPreview.mockClear();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockClear();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "release",
      current_phase: { start_date: 1, end_date: 2 },
      phases: [
        {
          start_date: 1,
          end_date: 2,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
        {
          start_date: 2,
          end_date: 3,
          items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const preview = await accept(
      client.preview({
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    const purchase = await accept(
      client.create({
        body: {
          quantity: 3,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(preview.body).toStrictEqual({
      error: {
        message: "Complete the pending concurrency update before adding slots",
        code: "CONFLICT",
      },
    });
    expect(purchase.body).toStrictEqual(preview.body);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledTimes(2);
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledWith(scheduleId);
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("adds concurrency to the Plan subscription through a neutral schedule", async () => {
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodEndUnix = 4_102_444_800;
    const concurrencyItemId = `si_${TEST_PRICE_CONCURRENCY}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
      current_phase: { start_date: 1, end_date: 2 },
      phases: [
        {
          start_date: 1,
          end_date: 2,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
        {
          start_date: 2,
          end_date: 3,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_end: periodEndUnix,
          },
          {
            id: concurrencyItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 3,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract).create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ url: successUrl });
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      fixture.subscriptionId,
      { expand: ["latest_invoice"] },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, {
      preserve_cancel_date: true,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([]);
  });

  it("reactivates a zero-quantity concurrency item on the Plan subscription", async () => {
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const concurrencyItemId = `si_${TEST_PRICE_CONCURRENCY}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.test/pending-concurrency-purchase";
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
          {
            id: concurrencyItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 0,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: {
        id: `in_${randomUUID()}`,
        status: "open",
        hosted_invoice_url: hostedInvoiceUrl,
      },
      pending_update: {
        expires_at: 4_102_444_800,
        subscription_items: [
          {
            id: concurrencyItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 1,
          },
        ],
      },
    });

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract).create({
        body: {
          quantity: 1,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ url: hostedInvoiceUrl });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ id: concurrencyItemId, quantity: 1 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
  });

  it("activates concurrency on the Plan subscription without renewing Plan credits", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd,
    });

    const status = await readBillingStatus(fixture);
    expect(status.credits).toBe(fixture.planCredits);
    expect(status.hasSubscription).toBeTruthy();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        currentPeriodEnd: periodEnd.toISOString(),
      }),
    ]);
  });

  it("updates Plan and concurrency state from one shared subscription event", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd,
    });
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "past_due",
          cancel_at_period_end: true,
          cancel_at: null,
          schedule: null,
          metadata: {},
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_TEAM}`,
                price: { id: TEST_PRICE_TEAM },
                quantity: 1,
                current_period_end: Math.floor(periodEnd.getTime() / 1000),
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 3,
                current_period_end: Math.floor(periodEnd.getTime() / 1000),
              },
            ],
          },
        },
        previous_attributes: { cancel_at_period_end: false },
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      event.data.object,
    );
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);

    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
      }),
      [200],
    );

    const status = await readBillingStatus(fixture);
    expect(status.subscriptionStatus).toBe("past_due");
    expect(status.cancelAtPeriodEnd).toBeTruthy();
    expect(status.concurrencySubscriptions[0]).toStrictEqual(
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        cancelAtPeriodEnd: false,
      }),
    );
  });

  it("keeps shared concurrency active when a Custom plan has an explicit end", async () => {
    const concurrencyPeriodEnd = new Date("2099-05-20T00:00:00Z");
    const customExpiresAt = new Date("2100-05-20T00:00:00Z");
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd: concurrencyPeriodEnd,
    });
    mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "active",
          cancel_at_period_end: false,
          cancel_at: Math.floor(customExpiresAt.getTime() / 1000),
          schedule: null,
          metadata: {
            orgId: fixture.orgId,
            purpose: "custom_plan_subscription",
            tier: "custom",
            atomGrantExpiresAt: customExpiresAt.toISOString(),
          },
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_CUSTOM}`,
                price: { id: TEST_PRICE_CUSTOM },
                quantity: 1,
                current_period_end: Math.floor(
                  concurrencyPeriodEnd.getTime() / 1000,
                ),
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 3,
                current_period_end: Math.floor(
                  concurrencyPeriodEnd.getTime() / 1000,
                ),
              },
            ],
          },
        },
        previous_attributes: { cancel_at: null },
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      event.data.object,
    );
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);

    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
      }),
      [200],
    );

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("custom");
    expect(status.cancelAtPeriodEnd).toBeTruthy();
    expect(status.currentPeriodEnd).toBe(customExpiresAt.toISOString());
    expect(status.concurrencySubscriptions[0]).toStrictEqual(
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        currentPeriodEnd: concurrencyPeriodEnd.toISOString(),
        cancelAtPeriodEnd: false,
      }),
    );
  });

  it("does not activate a deleted concurrency subscription from a delayed first invoice", async () => {
    const fixture = await createSubscriptionOrg({ tier: "team" });
    const subscriptionId = `sub_${randomUUID()}`;
    const periodEnd = currentSecond() + 30 * 86_400;
    context.mocks.stripe.subscriptions.retrieve.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "resource_missing",
        message: `No such subscription: ${subscriptionId}`,
      }),
    );
    const event = {
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID()}`,
          customer: fixture.customerId,
          metadata: { purpose: "concurrency_subscription" },
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: { purpose: "concurrency_subscription" },
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                quantity: 3,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: { type: "subscription_item_details" },
                period: {
                  start: periodEnd - 30 * 86_400,
                  end: periodEnd,
                },
              },
            ],
          },
        },
      },
    };
    const client = setupApp({ context, routes: webhooksStripeRoutes })(
      webhookStripeContract,
    );
    for (let delivery = 0; delivery < 2; delivery++) {
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
      await accept(
        client.post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=delayed-paid-invoice" },
        }),
        [200],
      );
    }
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([]);
    expect(status.tier).toBe("team");
  });

  it("keeps authoritative cancellation across stale equal-quantity events and one clock tick", async () => {
    mockNow(new Date("2035-05-01T00:00:00Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const periodEnd = new Date("2035-06-01T00:00:00Z");
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId: `sub_${randomUUID()}`,
      slots: 2,
      periodEnd,
    });
    const currentSubscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: true,
      schedule: null,
      metadata: { purpose: "concurrency_subscription" },
      items: {
        data: [
          {
            id: `si_${randomUUID()}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 2,
            current_period_end: Math.floor(periodEnd.getTime() / 1000),
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    const client = setupApp({ context, routes: webhooksStripeRoutes })(
      webhookStripeContract,
    );
    // All three deliveries share the same application millisecond. Publication
    // must preserve PostgreSQL's timestamp precision after each actual write.
    for (const cancelAtPeriodEnd of [true, false, false]) {
      const event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            ...currentSubscription,
            cancel_at_period_end: cancelAtPeriodEnd,
          },
        },
      };
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
      await accept(
        client.post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
        }),
        [200],
      );
      const status = await readBillingStatus(fixture);
      expect(status.concurrencySubscriptions).toStrictEqual([
        expect.objectContaining({
          id: fixture.subscriptionId,
          quantity: 2,
          cancelAtPeriodEnd: true,
        }),
      ]);
    }
  });

  it("ends Plan and concurrency state when the shared subscription is deleted", async () => {
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
    });
    const event = {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "canceled",
          metadata: {},
        },
      },
    };
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);

    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
      }),
      [200],
    );

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("limited-free-1");
    expect(status.hasSubscription).toBeFalsy();
    expect(status.concurrencySubscriptions).toStrictEqual([]);
  });

  it("activates concurrency on a Custom usage allowance subscription", async () => {
    const owned = createOwnedBillingOrg({ foreverCustom: true });
    await owned.run(async () => {
      await owned.initialize();

      const periodEnd = new Date("2099-05-20T00:00:00Z");
      const fixture =
        await createMergedUsageAllowanceConcurrencySubscriptionOrg(
          {
            slots: 3,
            periodEnd,
          },
          owned,
        );

      const status = await readBillingStatus(fixture);
      expect(status.tier).toBe("custom");
      expect(status.usageAllowance).not.toBeNull();
      expect(status.concurrencySubscriptions).toStrictEqual([
        expect.objectContaining({
          id: fixture.subscriptionId,
          quantity: 3,
          currentPeriodEnd: periodEnd.toISOString(),
        }),
      ]);
    });
  });

  it("updates usage allowance and concurrency from one shared subscription event", async () => {
    const owned = createOwnedBillingOrg({ foreverCustom: true });
    await owned.run(async () => {
      await owned.initialize();

      const periodEnd = new Date("2099-05-20T00:00:00Z");
      const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
      const fixture =
        await createMergedUsageAllowanceConcurrencySubscriptionOrg(
          {
            slots: 3,
            periodEnd,
          },
          owned,
        );
      const initialStatus = await readBillingStatus(fixture);
      const event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: fixture.subscriptionId,
            customer: fixture.customerId,
            status: "past_due",
            cancel_at_period_end: true,
            cancel_at: periodEndUnix,
            schedule: null,
            metadata: { purpose: "usage_allowance" },
            items: {
              data: [
                {
                  id: fixture.allowanceItemId,
                  price: { id: TEST_PRICE_USAGE_ALLOWANCE },
                  quantity: 1,
                  current_period_end: periodEndUnix,
                },
                {
                  id: fixture.concurrencyItemId,
                  price: { id: TEST_PRICE_CONCURRENCY },
                  quantity: 3,
                  current_period_end: periodEndUnix,
                },
              ],
            },
          },
          previous_attributes: { cancel_at_period_end: false },
        },
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        event.data.object,
      );
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);

      await accept(
        setupApp({ context, routes: webhooksStripeRoutes })(
          webhookStripeContract,
        ).post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
        }),
        [200],
      );

      const status = await readBillingStatus(fixture);
      expect(status.tier).toBe("custom");
      expect(status.subscriptionStatus).toBe(initialStatus.subscriptionStatus);
      expect(status.usageAllowance).not.toBeNull();
      expect(status.concurrencySubscriptions[0]).toStrictEqual(
        expect.objectContaining({
          id: fixture.subscriptionId,
          quantity: 3,
          cancelAtPeriodEnd: true,
        }),
      );
    });
  });

  it("ends shared allowance and concurrency without ending the Custom plan", async () => {
    const owned = createOwnedBillingOrg({ foreverCustom: true });
    await owned.run(async () => {
      await owned.initialize();

      const fixture =
        await createMergedUsageAllowanceConcurrencySubscriptionOrg(
          {
            slots: 3,
            periodEnd: new Date("2099-05-20T00:00:00Z"),
          },
          owned,
        );
      const initialStatus = await readBillingStatus(fixture);
      const event = {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: fixture.subscriptionId,
            customer: fixture.customerId,
            status: "canceled",
            metadata: { purpose: "usage_allowance" },
          },
        },
      };
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);

      await accept(
        setupApp({ context, routes: webhooksStripeRoutes })(
          webhookStripeContract,
        ).post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
        }),
        [200],
      );

      const status = await readBillingStatus(fixture);
      expect(status.tier).toBe("custom");
      expect(status.subscriptionStatus).toBe(initialStatus.subscriptionStatus);
      expect(status.hasSubscription).toBeFalsy();
      expect(status.usageAllowance).toBeNull();
      expect(status.concurrencySubscriptions).toStrictEqual([]);
    });
  });

  it("previews and confirms a concurrency change without Portal", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const subscriptionItemId = `si_${randomUUID()}`;
      const hostedInvoiceUrl =
        "https://invoice.stripe.test/pending-concurrency-change";
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 2,
          periodEnd: new Date("2099-05-20T00:00:00Z"),
        },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const paymentMethodId = `pm_${randomUUID()}`;
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subscriptionId,
        customer: fixture.customerId,
        default_payment_method: paymentMethodId,
        pending_update: null,
        items: {
          data: [
            {
              id: subscriptionItemId,
              price: { id: TEST_PRICE_CONCURRENCY },
              quantity: 2,
            },
          ],
        },
      });
      context.mocks.stripe.invoices.createPreview
        .mockImplementationOnce((input) => {
          if (
            typeof input !== "object" ||
            input === null ||
            !("subscription_details" in input) ||
            typeof input.subscription_details !== "object" ||
            input.subscription_details === null ||
            !("proration_date" in input.subscription_details) ||
            typeof input.subscription_details.proration_date !== "number"
          ) {
            throw new Error("Expected a concurrency proration preview");
          }
          return Promise.resolve({
            id: `in_preview_${randomUUID()}`,
            amount_due: 17_000,
            currency: "usd",
            lines: {
              has_more: false,
              data: [
                {
                  id: `il_${randomUUID()}`,
                  amount: 15_000,
                  pricing: {
                    price_details: { price: TEST_PRICE_CONCURRENCY },
                  },
                  parent: {
                    subscription_item_details: { proration: true },
                  },
                  period: {
                    start: input.subscription_details.proration_date,
                  },
                },
                {
                  id: `il_${randomUUID()}`,
                  amount: 2000,
                  pricing: { price_details: { price: TEST_PRICE_TEAM } },
                  parent: {
                    subscription_item_details: { proration: false },
                  },
                  period: {
                    start: input.subscription_details.proration_date,
                  },
                },
              ],
            },
          });
        })
        .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(4));
      context.mocks.stripe.subscriptions.update.mockResolvedValue({
        id: subscriptionId,
        latest_invoice: {
          id: `in_${randomUUID()}`,
          status: "open",
          hosted_invoice_url: hostedInvoiceUrl,
        },
        pending_update: {
          expires_at: 4_102_444_800,
          subscription_items: [
            {
              id: subscriptionItemId,
              price: { id: TEST_PRICE_CONCURRENCY },
              quantity: 4,
            },
          ],
        },
      });

      const client = setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract);

      const preview = await accept(
        client.previewChange({
          params: { subscriptionId },
          body: {
            quantity: 4,
            supportsInAppPreview: true,
            returnUrl: `${APP_ORIGIN}/billing`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(preview.body).toStrictEqual({
        currentQuantity: 2,
        targetQuantity: 4,
        immediateAmountCents: 15_000,
        nextRecurringAmountCents: 40_000,
        currency: "usd",
        paymentMethodPreviewToken: expect.any(String),
      });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        subscription: subscriptionId,
        preview_mode: "next",
        subscription_details: {
          items: [{ id: subscriptionItemId, quantity: 4 }],
          proration_behavior: "always_invoice",
          proration_date: expect.any(Number),
        },
      });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        subscription: subscriptionId,
        preview_mode: "recurring",
        subscription_details: {
          items: [{ id: subscriptionItemId, quantity: 4 }],
          proration_behavior: "none",
        },
      });

      const paymentMethodPreviewToken = preview.body.paymentMethodPreviewToken;
      if (!paymentMethodPreviewToken) {
        throw new Error("Expected a saved-payment-method preview token");
      }
      const confirmed = await accept(
        client.confirmChange({
          params: { subscriptionId },
          body: { quantity: 4, paymentMethodPreviewToken },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(confirmed.body).toStrictEqual({
        status: "pending_payment",
        hostedInvoiceUrl,
      });
      expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
        1,
        subscriptionId,
        {
          default_payment_method: paymentMethodId,
        },
      );
      expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
        2,
        subscriptionId,
        {
          items: [{ id: subscriptionItemId, quantity: 4 }],
          payment_behavior: "pending_if_incomplete",
          proration_behavior: "always_invoice",
          proration_date: expect.any(Number),
          expand: ["latest_invoice"],
        },
      );
      expect(
        context.mocks.stripe.billingPortal.sessions.create,
      ).not.toHaveBeenCalled();
      const status = await readBillingStatus(fixture);
      expect(status.concurrencySubscriptions).toStrictEqual([
        expect.objectContaining({ id: subscriptionId, quantity: 2 }),
      ]);
    });
  });

  it("returns the pending invoice when confirming a matching pending update", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const subscriptionItemId = `si_${randomUUID()}`;
      const hostedInvoiceUrl =
        "https://invoice.stripe.test/pending-concurrency-confirm";
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 2,
          periodEnd: new Date("2099-05-20T00:00:00Z"),
        },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
        id: subscriptionId,
        customer: fixture.customerId,
        latest_invoice: {
          id: `in_${randomUUID()}`,
          status: "open",
          hosted_invoice_url: hostedInvoiceUrl,
        },
        pending_update: {
          expires_at: 4_102_444_800,
          subscription_items: [
            {
              id: subscriptionItemId,
              price: { id: TEST_PRICE_CONCURRENCY },
              quantity: 4,
            },
          ],
        },
        items: {
          data: [
            {
              id: subscriptionItemId,
              price: { id: TEST_PRICE_CONCURRENCY },
              quantity: 2,
            },
          ],
        },
      });

      const confirmed = await accept(
        setupApp({
          context,
          routes: billingConcurrencySubscriptionRoutes,
        })(billingConcurrencySubscriptionContract).confirmChange({
          params: { subscriptionId },
          body: { quantity: 4 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(confirmed.body).toStrictEqual({
        status: "pending_payment",
        hostedInvoiceUrl,
      });
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).not.toHaveBeenCalled();
      const status = await readBillingStatus(fixture);
      expect(status.concurrencySubscriptions).toStrictEqual([
        expect.objectContaining({ id: subscriptionId, quantity: 2 }),
      ]);
    });
  });

  it("previews a concurrency reduction at the next billing date", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const subscriptionItemId = `si_${randomUUID()}`;
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 5,
          periodEnd: new Date("2099-05-20T00:00:00Z"),
        },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const periodStartUnix = 4_075_660_800;
      const periodEndUnix = 4_078_252_800;
      const scheduleId = `sub_sched_${randomUUID()}`;
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subscriptionId,
        pending_update: null,
        schedule: null,
        items: {
          data: [
            {
              id: subscriptionItemId,
              price: {
                id: TEST_PRICE_CONCURRENCY,
                recurring: {
                  interval: "month",
                  interval_count: 1,
                  usage_type: "licensed",
                  trial_period_days: null,
                  meter: null,
                },
              },
              quantity: 5,
              current_period_start: periodStartUnix,
              current_period_end: periodEndUnix,
            },
          ],
        },
      });
      context.mocks.stripe.invoices.createPreview.mockResolvedValueOnce(
        recurringConcurrencyPreviewInvoice(3),
      );
      context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
        id: scheduleId,
      });
      context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
        id: scheduleId,
      });

      const preview = await accept(
        setupApp({
          context,
          routes: billingConcurrencySubscriptionRoutes,
        })(billingConcurrencySubscriptionContract).previewChange({
          params: { subscriptionId },
          body: { quantity: 3 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(preview.body).toStrictEqual({
        currentQuantity: 5,
        targetQuantity: 3,
        immediateAmountCents: 0,
        nextRecurringAmountCents: 30_000,
        currency: "usd",
        effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
      });
      expect(
        context.mocks.stripe.invoices.createPreview,
      ).toHaveBeenCalledOnce();
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        subscription: subscriptionId,
        preview_mode: "recurring",
        subscription_details: {
          items: [{ id: subscriptionItemId, quantity: 3 }],
          proration_behavior: "none",
        },
      });

      const confirmed = await accept(
        setupApp({
          context,
          routes: billingConcurrencySubscriptionRoutes,
        })(billingConcurrencySubscriptionContract).confirmChange({
          params: { subscriptionId },
          body: { quantity: 3 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(confirmed.body).toStrictEqual({
        status: "completed",
        hostedInvoiceUrl: null,
        effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
      });
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).toHaveBeenCalledWith(
        scheduleId,
        {
          end_behavior: "release",
          proration_behavior: "none",
          phases: [
            {
              start_date: periodStartUnix,
              end_date: periodEndUnix,
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
              proration_behavior: "none",
            },
            {
              start_date: periodEndUnix,
              duration: { interval: "month", interval_count: 1 },
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
              proration_behavior: "none",
            },
          ],
        },
        { idempotencyKey: expect.any(String) },
      );
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    });
  });

  it("reuses a concurrency schedule with no future billing changes", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const subscriptionItemId = `si_${randomUUID()}`;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const periodStartUnix = 4_075_660_800;
      const periodEndUnix = 4_078_252_800;
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 5,
          periodEnd: new Date(periodEndUnix * 1000),
        },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const subscription = {
        id: subscriptionId,
        customer: `cus_${randomUUID()}`,
        status: "active",
        cancel_at_period_end: false,
        latest_invoice: null,
        pending_update: null,
        schedule: scheduleId,
        items: {
          data: [
            {
              id: subscriptionItemId,
              price: {
                id: TEST_PRICE_CONCURRENCY,
                recurring: { interval: "month" as const, interval_count: 1 },
              },
              quantity: 5,
              current_period_start: periodStartUnix,
              current_period_end: periodEndUnix,
            },
          ],
        },
      };
      const schedule = {
        id: scheduleId,
        end_behavior: "release",
        current_phase: {
          start_date: periodStartUnix,
          end_date: periodEndUnix,
        },
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
          },
          {
            start_date: periodEndUnix,
            end_date: periodEndUnix + 30 * 86_400,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
          },
        ],
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
        schedule,
      );
      context.mocks.stripe.invoices.createPreview.mockImplementationOnce(
        (input) => {
          if (
            typeof input !== "object" ||
            input === null ||
            !("preview_mode" in input) ||
            input.preview_mode !== "next" ||
            !("schedule" in input) ||
            input.schedule !== scheduleId
          ) {
            throw new Error(
              "Recurring estimates do not support subscription schedules",
            );
          }
          return Promise.resolve(recurringConcurrencyPreviewInvoice(3));
        },
      );
      context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
      });

      const client = setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract);
      const preview = await accept(
        client.previewChange({
          params: { subscriptionId },
          body: { quantity: 3 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(preview.body).toStrictEqual({
        currentQuantity: 5,
        targetQuantity: 3,
        immediateAmountCents: 0,
        nextRecurringAmountCents: 30_000,
        currency: "usd",
        effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
      });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        schedule: scheduleId,
        preview_mode: "next",
        schedule_details: {
          end_behavior: "release",
          proration_behavior: "none",
          phases: [
            {
              start_date: periodStartUnix,
              end_date: periodEndUnix,
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
              proration_behavior: "none",
            },
            {
              start_date: periodEndUnix,
              duration: { interval: "month", interval_count: 1 },
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
              proration_behavior: "none",
            },
          ],
        },
      });
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.release,
      ).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).not.toHaveBeenCalled();

      const confirmed = await accept(
        client.confirmChange({
          params: { subscriptionId },
          body: { quantity: 3 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(confirmed.body).toStrictEqual({
        status: "completed",
        hostedInvoiceUrl: null,
        effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
      });
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).toHaveBeenCalledWith(
        scheduleId,
        expect.objectContaining({
          phases: expect.arrayContaining([
            expect.objectContaining({
              start_date: periodEndUnix,
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
            }),
          ]),
        }),
        { idempotencyKey: expect.any(String) },
      );
    });
  });

  it("previews an immediate concurrency increase without detaching a neutral schedule", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();
      const subscriptionId = `sub_${randomUUID()}`;
      const subscriptionItemId = `si_${randomUUID()}`;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const periodStartUnix = 4_075_660_800;
      const periodEndUnix = 4_078_252_800;
      const fixture = await createConcurrencySubscriptionOrg(
        { subscriptionId, slots: 5, periodEnd: new Date(periodEndUnix * 1000) },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subscriptionId,
        customer: fixture.customerId,
        status: "active",
        cancel_at_period_end: false,
        latest_invoice: null,
        pending_update: null,
        schedule: scheduleId,
        items: {
          data: [
            {
              id: subscriptionItemId,
              price: {
                id: TEST_PRICE_CONCURRENCY,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 5,
              current_period_start: periodStartUnix,
              current_period_end: periodEndUnix,
            },
          ],
        },
      });
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
        id: scheduleId,
        end_behavior: "release",
        current_phase: { start_date: periodStartUnix, end_date: periodEndUnix },
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
          },
          {
            start_date: periodEndUnix,
            end_date: periodEndUnix + 30 * 86_400,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
          },
        ],
      });
      context.mocks.stripe.invoices.createPreview.mockImplementation(
        (input) => {
          if (
            typeof input !== "object" ||
            input === null ||
            !("preview_mode" in input) ||
            input.preview_mode !== "next"
          ) {
            throw new Error(
              "Recurring estimates do not support subscription schedules",
            );
          }
          if ("schedule" in input && input.schedule === scheduleId) {
            return Promise.resolve(recurringConcurrencyPreviewInvoice(7));
          }
          if (
            !("subscription_details" in input) ||
            typeof input.subscription_details !== "object" ||
            input.subscription_details === null ||
            !("proration_date" in input.subscription_details)
          ) {
            throw new Error(
              "Expected an immediate concurrency proration preview",
            );
          }
          return Promise.resolve({
            id: `in_${randomUUID()}`,
            amount_due: 15_000,
            currency: "usd",
            lines: {
              has_more: false,
              data: [
                {
                  id: `il_${randomUUID()}`,
                  amount: 15_000,
                  pricing: { price_details: { price: TEST_PRICE_CONCURRENCY } },
                  parent: { subscription_item_details: { proration: true } },
                  period: { start: input.subscription_details.proration_date },
                },
              ],
            },
          });
        },
      );
      const preview = await accept(
        setupApp({ context, routes: billingConcurrencySubscriptionRoutes })(
          billingConcurrencySubscriptionContract,
        ).previewChange({
          params: { subscriptionId },
          body: { quantity: 7 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(preview.body).toStrictEqual({
        currentQuantity: 5,
        targetQuantity: 7,
        immediateAmountCents: 15_000,
        nextRecurringAmountCents: 70_000,
        currency: "usd",
      });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          schedule: scheduleId,
          preview_mode: "next",
          schedule_details: expect.objectContaining({
            proration_behavior: "none",
          }),
        }),
      );
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.release,
      ).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).not.toHaveBeenCalled();
    });
  });

  it("rejects a schedule that repeats invoice items in a future phase", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const subscriptionItemId = `si_${randomUUID()}`;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const periodStartUnix = 4_075_660_800;
      const periodEndUnix = 4_078_252_800;
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 5,
          periodEnd: new Date(periodEndUnix * 1000),
        },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const subscription = {
        id: subscriptionId,
        customer: `cus_${randomUUID()}`,
        status: "active",
        cancel_at_period_end: false,
        latest_invoice: null,
        pending_update: null,
        schedule: scheduleId,
        items: {
          data: [
            {
              id: subscriptionItemId,
              price: {
                id: TEST_PRICE_CONCURRENCY,
                recurring: { interval: "month" as const, interval_count: 1 },
              },
              quantity: 5,
              current_period_start: periodStartUnix,
              current_period_end: periodEndUnix,
            },
          ],
        },
      };
      const repeatedInvoiceItems = [
        { price: `price_${randomUUID()}`, quantity: 1 },
      ];
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
        id: scheduleId,
        end_behavior: "release",
        current_phase: {
          start_date: periodStartUnix,
          end_date: periodEndUnix,
        },
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            add_invoice_items: repeatedInvoiceItems,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
          },
          {
            start_date: periodEndUnix,
            end_date: periodEndUnix + 30 * 86_400,
            add_invoice_items: repeatedInvoiceItems,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
          },
        ],
      });

      const response = await accept(
        setupApp({
          context,
          routes: billingConcurrencySubscriptionRoutes,
        })(billingConcurrencySubscriptionContract).previewChange({
          params: { subscriptionId },
          body: { quantity: 3 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [409],
      );

      expect(response.body.error.message).toBe(
        "Complete the pending concurrency update before changing slots",
      );
      expect(
        context.mocks.stripe.invoices.createPreview,
      ).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.release,
      ).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).not.toHaveBeenCalled();
    });
  });

  it("allows concurrency increases but blocks reductions during a Team to Pro downgrade", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
    const periodStartUnix = periodEndUnix - 30 * 86_400;
    const futureEndUnix = periodEndUnix + 30 * 86_400;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const scheduleId = `sub_sched_plan_${randomUUID()}`;
    const subscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      default_payment_method: "pm_card",
      latest_invoice: null,
      pending_update: null,
      schedule: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month" as const, interval_count: 1 },
            },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month" as const, interval_count: 1 },
            },
            quantity: 5,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
      current_phase: {
        start_date: periodStartUnix,
        end_date: periodEndUnix,
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    await accept(
      setupApp({ context, routes: billingDowngradeRoutes })(
        billingDowngradeContract,
      ).create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const attachedSubscription = { ...subscription, schedule: scheduleId };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      attachedSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.invoices.createPreview.mockClear();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockClear();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: periodStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: periodEndUnix,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
        },
        {
          start_date: periodEndUnix,
          end_date: futureEndUnix,
          items: [
            { price: TEST_PRICE_PRO, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
        },
      ],
    });
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        "proration_date" in input.subscription_details &&
        typeof input.subscription_details.proration_date === "number"
      ) {
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 10_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 10_000,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: {
                  start: input.subscription_details.proration_date,
                },
              },
            ],
          },
        });
      }
      return Promise.resolve({
        id: `in_preview_${randomUUID()}`,
        amount_due: 20_000,
        currency: "usd",
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID()}`,
              amount: 20_000,
              pricing: {
                price_details: { price: TEST_PRICE_PRO },
              },
            },
          ],
        },
      });
    });
    context.mocks.stripe.subscriptionSchedules.release.mockClear();
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    const increasePreview = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 6 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const preview = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    const canceled = await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(increasePreview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 6,
      immediateAmountCents: 10_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });
    expect(preview.body).toStrictEqual({
      error: {
        message:
          "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    });
    expect(canceled.body).toStrictEqual({
      error: {
        message:
          "Restore your Plan before canceling concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 6 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "processing",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      2,
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledWith(scheduleId);
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "always_invoice",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 6 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            end_date: futureEndUnix,
            items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
  });

  it("replaces an existing scheduled concurrency reduction", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const subscriptionItemId = `si_${randomUUID()}`;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const periodStartUnix = 4_075_660_800;
      const schedulePhaseStartUnix = periodStartUnix + 3600;
      const periodEndUnix = 4_078_252_800;
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 5,
          periodEnd: new Date(periodEndUnix * 1000),
        },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const currentItem = {
        id: subscriptionItemId,
        price: {
          id: TEST_PRICE_CONCURRENCY,
          recurring: { interval: "month" as const, interval_count: 1 },
        },
        quantity: 5,
        current_period_start: periodStartUnix,
        current_period_end: periodEndUnix,
      };
      const subscriptionWithoutSchedule = {
        id: subscriptionId,
        pending_update: null,
        schedule: null,
        items: { data: [currentItem] },
      };
      const subscriptionWithSchedule = {
        ...subscriptionWithoutSchedule,
        schedule: scheduleId,
      };
      context.mocks.stripe.subscriptions.retrieve
        .mockResolvedValueOnce(subscriptionWithoutSchedule)
        .mockResolvedValueOnce(subscriptionWithoutSchedule)
        .mockResolvedValueOnce(subscriptionWithSchedule)
        .mockResolvedValue(subscriptionWithSchedule);
      context.mocks.stripe.invoices.createPreview
        .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(3))
        .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(2));
      context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
        id: scheduleId,
      });
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
        id: scheduleId,
        current_phase: {
          start_date: schedulePhaseStartUnix,
          end_date: periodEndUnix,
        },
        phases: [
          {
            start_date: schedulePhaseStartUnix,
            end_date: periodEndUnix,
          },
          {
            start_date: periodEndUnix,
            end_date: periodEndUnix + 2_592_000,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
          },
        ],
      });
      context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
      });
      const client = setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract);

      await accept(
        client.previewChange({
          params: { subscriptionId },
          body: { quantity: 3 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      await accept(
        client.confirmChange({
          params: { subscriptionId },
          body: { quantity: 3 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      const statusAfterFirstChange = await readBillingStatus(fixture);
      expect(statusAfterFirstChange.concurrencySubscriptions[0]).toMatchObject({
        quantity: 5,
        scheduledQuantity: 3,
        scheduledChangeAt: new Date(periodEndUnix * 1000).toISOString(),
      });

      const replacementPreview = await accept(
        client.previewChange({
          params: { subscriptionId },
          body: { quantity: 2 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(replacementPreview.body).toStrictEqual({
        currentQuantity: 5,
        targetQuantity: 2,
        immediateAmountCents: 0,
        nextRecurringAmountCents: 20_000,
        currency: "usd",
        effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
      });
      expect(
        context.mocks.stripe.invoices.createPreview,
      ).toHaveBeenLastCalledWith({
        schedule: scheduleId,
        preview_mode: "next",
        schedule_details: {
          end_behavior: "release",
          proration_behavior: "none",
          phases: [
            {
              start_date: schedulePhaseStartUnix,
              end_date: periodEndUnix,
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
              proration_behavior: "none",
            },
            {
              start_date: periodEndUnix,
              duration: { interval: "month", interval_count: 1 },
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
              proration_behavior: "none",
            },
          ],
        },
      });

      await accept(
        client.confirmChange({
          params: { subscriptionId },
          body: { quantity: 2 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      const replacementOptions =
        context.mocks.stripe.subscriptionSchedules.update.mock.calls.at(
          -1,
        )?.[2];
      if (
        typeof replacementOptions !== "object" ||
        replacementOptions === null ||
        !("idempotencyKey" in replacementOptions) ||
        typeof replacementOptions.idempotencyKey !== "string"
      ) {
        throw new Error("Expected replacement schedule update options");
      }

      await accept(
        client.confirmChange({
          params: { subscriptionId },
          body: { quantity: 2 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      const retryOptions =
        context.mocks.stripe.subscriptionSchedules.update.mock.calls.at(
          -1,
        )?.[2];
      if (
        typeof retryOptions !== "object" ||
        retryOptions === null ||
        !("idempotencyKey" in retryOptions) ||
        typeof retryOptions.idempotencyKey !== "string"
      ) {
        throw new Error("Expected retry schedule update options");
      }

      expect(
        context.mocks.stripe.subscriptionSchedules.create,
      ).toHaveBeenCalledOnce();
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).toHaveBeenCalledTimes(3);
      expect(retryOptions.idempotencyKey).not.toBe(
        replacementOptions.idempotencyKey,
      );
      const statusAfterReplacement = await readBillingStatus(fixture);
      expect(statusAfterReplacement.concurrencySubscriptions[0]).toMatchObject({
        quantity: 5,
        scheduledQuantity: 2,
        scheduledChangeAt: new Date(periodEndUnix * 1000).toISOString(),
      });
    });
  });

  it("releases a scheduled reduction before applying an increase", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const subscriptionItemId = `si_${randomUUID()}`;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const periodStartUnix = 4_075_660_800;
      const schedulePhaseStartUnix = periodStartUnix + 3600;
      const periodEndUnix = 4_078_252_800;
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 10,
          periodEnd: new Date(periodEndUnix * 1000),
        },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const currentItem = {
        id: subscriptionItemId,
        price: {
          id: TEST_PRICE_CONCURRENCY,
          recurring: { interval: "month" as const, interval_count: 1 },
        },
        quantity: 10,
        current_period_start: periodStartUnix,
        current_period_end: periodEndUnix,
      };
      const scheduledSubscription = {
        id: subscriptionId,
        schedule: scheduleId,
        pending_update: null,
        latest_invoice: null,
        items: { data: [currentItem] },
      };
      const subscriptionWithoutSchedule = {
        ...scheduledSubscription,
        schedule: null,
      };
      context.mocks.stripe.subscriptions.retrieve
        .mockResolvedValueOnce(subscriptionWithoutSchedule)
        .mockResolvedValueOnce(subscriptionWithoutSchedule)
        .mockResolvedValue(scheduledSubscription);
      context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
        id: subscriptionId,
        schedule: null,
        pending_update: null,
        latest_invoice: null,
        items: { data: [{ ...currentItem, quantity: 20 }] },
      });
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
        id: scheduleId,
        current_phase: {
          start_date: schedulePhaseStartUnix,
          end_date: periodEndUnix,
        },
        phases: [
          {
            start_date: schedulePhaseStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 10 }],
          },
          {
            start_date: periodEndUnix,
            end_date: periodEndUnix + 2_592_000,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
          },
        ],
      });
      context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
        id: scheduleId,
      });
      context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
        id: scheduleId,
      });
      context.mocks.stripe.invoices.createPreview
        .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(2))
        .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(10))
        .mockImplementationOnce((input) => {
          if (
            typeof input !== "object" ||
            input === null ||
            !("subscription_details" in input) ||
            typeof input.subscription_details !== "object" ||
            input.subscription_details === null ||
            !("proration_date" in input.subscription_details) ||
            typeof input.subscription_details.proration_date !== "number"
          ) {
            throw new Error("Expected a concurrency proration preview");
          }
          return Promise.resolve({
            id: `in_preview_${randomUUID()}`,
            amount_due: 100_000,
            currency: "usd",
            lines: {
              has_more: false,
              data: [
                {
                  id: `il_${randomUUID()}`,
                  amount: 100_000,
                  pricing: {
                    price_details: { price: TEST_PRICE_CONCURRENCY },
                  },
                  parent: {
                    subscription_item_details: { proration: true },
                  },
                  period: {
                    start: input.subscription_details.proration_date,
                  },
                },
              ],
            },
          });
        })
        .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(20));
      context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
        id: scheduleId,
      });

      const client = setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract);
      await accept(
        client.previewChange({
          params: { subscriptionId },
          body: { quantity: 2 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      await accept(
        client.confirmChange({
          params: { subscriptionId },
          body: { quantity: 2 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      const scheduledStatus = await readBillingStatus(fixture);
      expect(scheduledStatus.concurrencySubscriptions[0]).toMatchObject({
        quantity: 10,
        scheduledQuantity: 2,
      });
      context.mocks.stripe.subscriptionSchedules.create.mockClear();
      context.mocks.stripe.subscriptionSchedules.update.mockClear();

      const unchangedPreview = await accept(
        client.previewChange({
          params: { subscriptionId },
          body: { quantity: 10 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(unchangedPreview.body).toStrictEqual({
        currentQuantity: 10,
        targetQuantity: 10,
        immediateAmountCents: 0,
        nextRecurringAmountCents: 100_000,
        currency: "usd",
      });
      expect(
        context.mocks.stripe.invoices.createPreview,
      ).toHaveBeenLastCalledWith({
        schedule: scheduleId,
        preview_mode: "next",
        schedule_details: expect.objectContaining({
          phases: expect.arrayContaining([
            expect.objectContaining({
              start_date: periodEndUnix,
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 10 }],
            }),
          ]),
        }),
      });
      const preview = await accept(
        client.previewChange({
          params: { subscriptionId },
          body: { quantity: 20 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(preview.body).toStrictEqual({
        currentQuantity: 10,
        targetQuantity: 20,
        immediateAmountCents: 100_000,
        nextRecurringAmountCents: 200_000,
        currency: "usd",
      });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        schedule: scheduleId,
        preview_mode: "next",
        schedule_details: {
          end_behavior: "release",
          proration_behavior: "none",
          phases: [
            {
              start_date: schedulePhaseStartUnix,
              end_date: periodEndUnix,
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 10 }],
              proration_behavior: "none",
            },
            {
              start_date: periodEndUnix,
              duration: { interval: "month", interval_count: 1 },
              items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 20 }],
              proration_behavior: "none",
            },
          ],
        },
      });
      expect(
        context.mocks.stripe.subscriptionSchedules.retrieve,
      ).toHaveBeenCalledWith(scheduleId);

      const response = await accept(
        client.confirmChange({
          params: { subscriptionId },
          body: { quantity: 20 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        status: "processing",
        hostedInvoiceUrl: null,
      });
      expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
        subscriptionId,
        {
          items: [{ id: subscriptionItemId, quantity: 20 }],
          payment_behavior: "pending_if_incomplete",
          proration_behavior: "always_invoice",
          proration_date: expect.any(Number),
          expand: ["latest_invoice"],
        },
      );
      expect(
        context.mocks.stripe.subscriptionSchedules.release,
      ).toHaveBeenCalledWith(scheduleId, {
        preserve_cancel_date: true,
      });
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).not.toHaveBeenCalled();
      const releaseCall =
        context.mocks.stripe.subscriptionSchedules.release.mock
          .invocationCallOrder[0];
      const updateCall =
        context.mocks.stripe.subscriptions.update.mock.invocationCallOrder[0];
      if (releaseCall === undefined || updateCall === undefined) {
        throw new Error(
          "Expected schedule release and subscription update calls",
        );
      }
      expect(releaseCall).toBeLessThan(updateCall);
      const status = await readBillingStatus(fixture);
      expect(status.concurrencySubscriptions).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: subscriptionId,
            quantity: 10,
          }),
        ]),
      );
      expect(status.concurrencySubscriptions[0]).not.toHaveProperty(
        "scheduledQuantity",
      );
    });
  });

  it("rejects in-app concurrency changes from non-admin members", async () => {
    const fixture = await createPublicBillingOrg("team");
    await fixture.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

      const response = await accept(
        setupApp({
          context,
          routes: billingConcurrencySubscriptionRoutes,
        })(billingConcurrencySubscriptionContract).previewChange({
          params: { subscriptionId: `sub_${randomUUID()}` },
          body: { quantity: 2 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [403],
      );

      expect(response.body.error).toStrictEqual({
        message: "Only org admins can manage concurrency subscriptions",
        code: "FORBIDDEN",
      });
      expect(
        context.mocks.stripe.subscriptions.retrieve,
      ).not.toHaveBeenCalled();
    });
  });

  it("requires restoring a canceling concurrency subscription before adding slots", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 2,
          periodEnd: new Date("2099-05-20T00:00:00Z"),
        },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
        id: subscriptionId,
      });
      await accept(
        setupApp({
          context,
          routes: billingConcurrencySubscriptionRoutes,
        })(billingConcurrencySubscriptionContract).cancel({
          params: { subscriptionId },
          body: {},
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      context.mocks.stripe.subscriptions.update.mockClear();

      const response = await accept(
        setupApp({
          context,
          routes: billingConcurrencyCheckoutRoutes,
        })(billingConcurrencyCheckoutContract).create({
          body: {
            quantity: 1,
            successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
            cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message:
            "Restore the existing concurrency subscription before buying more slots",
          code: "BAD_REQUEST",
        },
      });
      expect(
        context.mocks.stripe.subscriptions.retrieve,
      ).not.toHaveBeenCalled();
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    });
  });

  it("uses the live Stripe quantity for proration invoices", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const periodEnd = new Date("2099-05-20T00:00:00Z");
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 2,
          periodEnd,
        },
        owned,
      );
      const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
      const event = {
        type: "invoice.paid",
        data: {
          object: {
            id: `in_${randomUUID().slice(0, 8)}`,
            customer: fixture.customerId,
            metadata: { purpose: "concurrency_subscription" },
            parent: {
              subscription_details: {
                subscription: subscriptionId,
                metadata: { purpose: "concurrency_subscription" },
              },
            },
            lines: {
              has_more: false,
              data: [
                {
                  id: `il_${randomUUID().slice(0, 8)}`,
                  amount: -20_000,
                  quantity: 2,
                  price: { id: TEST_PRICE_CONCURRENCY },
                  parent: { type: "subscription_item_details" },
                  period: {
                    start: periodEndUnix - 15 * 86_400,
                    end: periodEndUnix,
                  },
                },
                {
                  id: `il_${randomUUID().slice(0, 8)}`,
                  amount: 50_000,
                  quantity: 5,
                  price: { id: TEST_PRICE_CONCURRENCY },
                  parent: { type: "subscription_item_details" },
                  period: {
                    start: periodEndUnix - 15 * 86_400,
                    end: periodEndUnix,
                  },
                },
              ],
            },
          },
        },
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
        id: subscriptionId,
        status: "active",
        customer: fixture.customerId,
        cancel_at: null,
        cancel_at_period_end: false,
        schedule: null,
        trial_end: null,
        metadata: { purpose: "concurrency_subscription" },
        items: {
          data: [
            {
              price: { id: TEST_PRICE_CONCURRENCY },
              quantity: 4,
              current_period_end: periodEndUnix,
            },
          ],
        },
      });
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);

      await accept(
        setupApp({ context, routes: webhooksStripeRoutes })(
          webhookStripeContract,
        ).post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
        }),
        [200],
      );

      const status = await readBillingStatus(fixture);
      expect(status.concurrencySubscriptions).toStrictEqual([
        expect.objectContaining({ id: subscriptionId, quantity: 4 }),
      ]);
    });
  });

  it("persists concurrency when shared subscription metadata has a stale usage pack ID", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    const periodEndUnix = Math.floor(now() / 1000) + 30 * 86_400;
    const staleUsagePackSubscriptionId = randomUUID();
    const metadata = {
      purpose: "usage_pack_subscription",
      usagePackSubscriptionId: staleUsagePackSubscriptionId,
    };
    const event = {
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID().slice(0, 8)}`,
          customer: fixture.customerId,
          metadata,
          status: "paid",
          parent: {
            subscription_details: {
              subscription: fixture.subscriptionId,
              metadata,
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID().slice(0, 8)}`,
                amount: 30_000,
                quantity: 3,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: {
                  type: "subscription_item_details",
                  subscription_item_details: { proration: true },
                },
                period: {
                  start: periodEndUnix - 15 * 86_400,
                  end: periodEndUnix,
                },
              },
            ],
          },
        },
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      metadata,
      items: {
        data: [
          { price: { id: TEST_PRICE_TEAM }, quantity: 1 },
          {
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 3,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);

    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
      }),
      [200],
    );

    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
      }),
    ]);
  });

  it("adds concurrency to the Plan subscription for an agent token with billing write capability", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "custom" });
    await seedMemberRole({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
    });

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CUSTOM}`,
            price: {
              id: TEST_PRICE_CUSTOM,
            },
            quantity: 1,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CUSTOM}`,
            price: {
              id: TEST_PRICE_CUSTOM,
            },
            quantity: 1,
            current_period_end: 4_102_444_800,
          },
          {
            id: `si_${TEST_PRICE_CONCURRENCY}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 2,
            current_period_end: 4_102_444_800,
          },
        ],
      },
    });
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["billing:write"],
    });

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          quantity: 2,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: `${APP_ORIGIN}/billing?concurrency=success`,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
  });

  it("rejects concurrency checkout for Pro workspaces", async () => {
    const fixture = await createPublicBillingOrg("pro");
    await fixture.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const client = setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract);
      const response = await accept(
        client.create({
          body: {
            quantity: 1,
            successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
            cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message:
            "Additional concurrency is only available for Team or Custom workspaces",
          code: "BAD_REQUEST",
        },
      });
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).not.toHaveBeenCalled();
    });
  });

  it("returns 400 when concurrency price is not configured", async () => {
    const fixture = await createPublicBillingOrg("team");
    await fixture.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      mockEnv("OKOU_PRICE_CONCURRENCY", undefined);

      const client = setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract);

      const response = await accept(
        client.create({
          body: {
            quantity: 1,
            successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
            cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: "Concurrency price not configured",
          code: "BAD_REQUEST",
        },
      });
    });
  });

  it("keeps a scheduled concurrency reduction when its subscription webhook lands before the local write", async () => {
    const owned = createOwnedBillingOrg({ tier: "team" });
    await owned.run(async () => {
      await owned.initialize();

      const subscriptionId = `sub_${randomUUID()}`;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const periodStartUnix = 4_075_660_800;
      const periodEndUnix = 4_078_252_800;
      const fixture = await createConcurrencySubscriptionOrg(
        {
          subscriptionId,
          slots: 5,
          periodEnd: new Date(periodEndUnix * 1000),
        },
        owned,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const subscription = {
        id: subscriptionId,
        customer: fixture.customerId,
        status: "active",
        cancel_at_period_end: false,
        latest_invoice: null,
        pending_update: null,
        schedule: scheduleId,
        metadata: {},
        items: {
          data: [
            {
              id: `si_${randomUUID()}`,
              price: {
                id: TEST_PRICE_CONCURRENCY,
                recurring: { interval: "month" as const, interval_count: 1 },
              },
              quantity: 5,
              current_period_start: periodStartUnix,
              current_period_end: periodEndUnix,
            },
          ],
        },
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
        id: scheduleId,
        end_behavior: "release",
        current_phase: { start_date: periodStartUnix, end_date: periodEndUnix },
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
          },
        ],
      });
      const webhookClient = setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      );
      context.mocks.stripe.subscriptionSchedules.update.mockImplementation(
        async () => {
          const event = {
            type: "customer.subscription.updated",
            data: {
              object: subscription,
              previous_attributes: { schedule: null },
            },
          };
          context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(
            event,
          );
          await accept(
            webhookClient.post({
              body: JSON.stringify(event),
              extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
            }),
            [200],
          );
          return { id: scheduleId };
        },
      );

      const client = setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract);
      const confirmed = await accept(
        client.confirmChange({
          params: { subscriptionId },
          body: { quantity: 3 },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(confirmed.body).toStrictEqual({
        status: "completed",
        hostedInvoiceUrl: null,
        effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
      });
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).toHaveBeenCalledWith(
        scheduleId,
        expect.objectContaining({ phases: expect.any(Array) }),
        { idempotencyKey: expect.any(String) },
      );
      const status = await readBillingStatus(fixture);
      expect(status.concurrencySubscriptions[0]).toMatchObject({
        id: subscriptionId,
        quantity: 5,
        scheduledQuantity: 3,
        scheduledChangeAt: new Date(periodEndUnix * 1000).toISOString(),
      });
    });
  });

  it("keeps a concurrency cancellation when its subscription webhook lands before the local write", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const periodEndUnix = 4_078_252_800;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const canceling = {
      id: subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: true,
      schedule: null,
      metadata: {},
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CONCURRENCY}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 2,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(canceling);
    const webhookClient = setupApp({ context, routes: webhooksStripeRoutes })(
      webhookStripeContract,
    );
    context.mocks.stripe.subscriptions.update.mockImplementation(async () => {
      const event = {
        type: "customer.subscription.updated",
        data: {
          object: canceling,
          previous_attributes: { cancel_at_period_end: false },
        },
      };
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
      await accept(
        webhookClient.post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
        }),
        [200],
      );
      return canceling;
    });

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    const response = await accept(
      client.cancel({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      currentPeriodEnd: new Date(periodEndUnix * 1000).toISOString(),
    });
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions[0]).toMatchObject({
      id: subscriptionId,
      quantity: 2,
      cancelAtPeriodEnd: true,
    });
  });

  it("converges concurrent cancellation of an active concurrency subscription", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    const responses = await Promise.all(
      [0, 1].map(() => {
        return accept(
          client.cancel({
            params: { subscriptionId },
            body: {},
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
      }),
    );

    for (const response of responses) {
      expect(response.body).toStrictEqual({
        success: true,
        currentPeriodEnd: periodEnd.toISOString(),
      });
    }
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      { cancel_at_period_end: true },
    );
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: subscriptionId,
          quantity: 2,
          cancelAtPeriodEnd: true,
        }),
      ]),
    );
  });

  it("restores an active concurrency subscription renewal", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.cancel({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.update.mockClear();

    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });

    const response = await accept(
      client.restore({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      { cancel_at_period_end: false },
    );
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: subscriptionId,
          cancelAtPeriodEnd: false,
        }),
      ]),
    );
  });

  it("restores a scheduled shared concurrency reduction", async () => {
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const subscription = {
      id: fixture.subscriptionId,
      schedule: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 5,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockReset();
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    let status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions[0]?.scheduledQuantity).toBe(3);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      ...subscription,
      schedule: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
    });
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });
    const response = await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, { preserve_cancel_date: true });
    status = await readBillingStatus(fixture);
    expect(
      status.concurrencySubscriptions[0]?.scheduledQuantity,
    ).toBeUndefined();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();
  });

  it("restores a concurrency reduction without removing the Plan cancellation", async () => {
    const periodStartUnix = 4_075_660_800;
    const concurrencyPeriodEndUnix = 4_078_252_800;
    const planEndUnix = concurrencyPeriodEndUnix + 2_592_000;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(concurrencyPeriodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const planItem = {
      id: `si_${TEST_PRICE_TEAM}`,
      price: { id: TEST_PRICE_TEAM },
      quantity: 1,
      current_period_start: periodStartUnix,
      current_period_end: planEndUnix,
    };
    const concurrencyItem = {
      id: fixture.concurrencyItemId,
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 5,
      current_period_start: periodStartUnix,
      current_period_end: concurrencyPeriodEndUnix,
    };
    const subscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      pending_update: null,
      latest_invoice: null,
      items: { data: [planItem, concurrencyItem] },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockReset();
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const attachedSubscription = { ...subscription, schedule: scheduleId };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(attachedSubscription)
      .mockResolvedValueOnce(attachedSubscription);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "cancel",
      current_phase: {
        start_date: periodStartUnix,
        end_date: concurrencyPeriodEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: concurrencyPeriodEndUnix,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
        },
        {
          start_date: concurrencyPeriodEndUnix,
          end_date: planEndUnix,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
          ],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const restored = await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(restored.body).toStrictEqual({ success: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: concurrencyPeriodEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: concurrencyPeriodEndUnix,
            end_date: planEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
            ],
            proration_behavior: "none",
          },
        ],
      },
      {
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:[^:]+:[^:]+:schedule-update$/u,
        ),
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(
      status.concurrencySubscriptions[0]?.scheduledQuantity,
    ).toBeUndefined();
  });

  it("restores stale shared concurrency state after its schedule is removed", async () => {
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const subscription = {
      id: fixture.subscriptionId,
      schedule: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockReset();
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      ...subscription,
      cancel_at: periodEndUnix,
      cancel_at_period_end: true,
      schedule: null,
    });
    const response = await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();
  });

  it("does not mark shared concurrency as restorable when the Plan cancels", async () => {
    const periodEndUnix = 4_078_252_800;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "active",
          cancel_at: periodEndUnix,
          cancel_at_period_end: true,
          schedule: null,
          metadata: {},
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_TEAM}`,
                price: { id: TEST_PRICE_TEAM },
                quantity: 1,
                current_period_end: periodEndUnix,
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 2,
                current_period_end: periodEndUnix,
              },
            ],
          },
        },
        previous_attributes: { cancel_at_period_end: false },
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      event.data.object,
    );
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);

    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
      }),
      [200],
    );

    const status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeTruthy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.canReduce).toBeTruthy();
  });

  it("does not release a Plan schedule when shared concurrency is not canceling", async () => {
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const scheduleId = `sub_sched_plan_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      schedule: scheduleId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockClear();
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
  });

  it("cancels and restores a shared concurrency item without blocking later changes", async () => {
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      schedule: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith(
      { from_subscription: fixture.subscriptionId },
      { idempotencyKey: expect.any(String) },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 2 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    let status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeTruthy();

    const scheduledItemEvent = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "active",
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: scheduleId,
          metadata: {},
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_TEAM}`,
                price: { id: TEST_PRICE_TEAM },
                quantity: 1,
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 2,
                current_period_end: periodEndUnix,
              },
            ],
          },
        },
        previous_attributes: {},
      },
    };
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
      phases: [
        { start_date: periodStartUnix, end_date: periodEndUnix },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
      ],
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      scheduledItemEvent.data.object,
    );
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(
      scheduledItemEvent,
    );
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(scheduledItemEvent),
        extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
      }),
      [200],
    );

    status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeTruthy();

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: periodStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: periodEndUnix,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 2 },
          ],
        },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
      ],
    });
    await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, {
      preserve_cancel_date: true,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledOnce();
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledTimes(2);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      pending_update: null,
      schedule: null,
      items: {
        data: [
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValueOnce(
      recurringConcurrencyPreviewInvoice(1),
    );

    const nextChange = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 1 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(nextChange.body).toStrictEqual({
      currentQuantity: 2,
      targetQuantity: 1,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 10_000,
      currency: "usd",
      effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
    });
  });

  it("restores Custom concurrency without removing the main plan end", async () => {
    const owned = createOwnedBillingOrg({ foreverCustom: true });
    await owned.run(async () => {
      await owned.initialize();

      const periodStartUnix = 4_075_660_800;
      const periodEndUnix = 4_078_252_800;
      const customPlanEndUnix = periodEndUnix + 180 * 86_400;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const fixture =
        await createMergedUsageAllowanceConcurrencySubscriptionOrg(
          {
            slots: 2,
            periodEnd: new Date(periodEndUnix * 1000),
          },
          owned,
        );
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
        id: fixture.subscriptionId,
        cancel_at: customPlanEndUnix,
        cancel_at_period_end: false,
        schedule: null,
        items: {
          data: [
            {
              id: fixture.allowanceItemId,
              price: { id: TEST_PRICE_USAGE_ALLOWANCE },
              quantity: 1,
              current_period_start: periodStartUnix,
              current_period_end: periodEndUnix,
            },
            {
              id: fixture.concurrencyItemId,
              price: {
                id: TEST_PRICE_CONCURRENCY,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 2,
              current_period_start: periodStartUnix,
              current_period_end: periodEndUnix,
            },
          ],
        },
      });
      context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
        id: scheduleId,
      });
      context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
        id: scheduleId,
      });
      const client = setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract);

      await accept(
        client.cancel({
          params: { subscriptionId: fixture.subscriptionId },
          body: {},
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).toHaveBeenCalledWith(
        scheduleId,
        {
          end_behavior: "release",
          proration_behavior: "none",
          phases: [
            {
              start_date: periodStartUnix,
              end_date: periodEndUnix,
              items: [
                { price: TEST_PRICE_USAGE_ALLOWANCE, quantity: 1 },
                { price: TEST_PRICE_CONCURRENCY, quantity: 2 },
              ],
              proration_behavior: "none",
            },
            {
              start_date: periodEndUnix,
              duration: { interval: "month", interval_count: 1 },
              items: [{ price: TEST_PRICE_USAGE_ALLOWANCE, quantity: 1 }],
              proration_behavior: "none",
            },
          ],
        },
        { idempotencyKey: expect.any(String) },
      );
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      const status = await readBillingStatus(fixture);
      expect(status.tier).toBe("custom");
      expect(status.usageAllowance).not.toBeNull();
      expect(
        status.concurrencySubscriptions[0]?.cancelAtPeriodEnd,
      ).toBeTruthy();

      context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
        id: fixture.subscriptionId,
        cancel_at: customPlanEndUnix,
        cancel_at_period_end: false,
        schedule: scheduleId,
        items: {
          data: [
            {
              id: fixture.allowanceItemId,
              price: { id: TEST_PRICE_USAGE_ALLOWANCE },
              quantity: 1,
              current_period_start: periodStartUnix,
              current_period_end: periodEndUnix,
            },
            {
              id: fixture.concurrencyItemId,
              price: {
                id: TEST_PRICE_CONCURRENCY,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 2,
              current_period_start: periodStartUnix,
              current_period_end: periodEndUnix,
            },
          ],
        },
      });
      context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
        id: scheduleId,
      });
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce(
        {
          id: scheduleId,
        },
      );

      await accept(
        client.restore({
          params: { subscriptionId: fixture.subscriptionId },
          body: {},
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(
        context.mocks.stripe.subscriptionSchedules.release,
      ).toHaveBeenCalledWith(scheduleId, { preserve_cancel_date: true });
      const restored = await readBillingStatus(fixture);
      expect(restored.tier).toBe("custom");
      expect(restored.usageAllowance).not.toBeNull();
      expect(
        restored.concurrencySubscriptions[0]?.cancelAtPeriodEnd,
      ).toBeFalsy();
    });
  });

  it("returns 404 when restoring a concurrency subscription outside the org", async () => {
    const fixture = await createPublicBillingOrg("team");
    await fixture.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const client = setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract);

      const response = await accept(
        client.restore({
          params: { subscriptionId: `sub_${randomUUID()}` },
          body: {},
          headers: { authorization: "Bearer clerk-session" },
        }),
        [404],
      );

      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    });
  });

  it("returns 404 when cancelling a concurrency subscription outside the org", async () => {
    const fixture = await createPublicBillingOrg("team");
    await fixture.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const client = setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract);

      const response = await accept(
        client.cancel({
          params: { subscriptionId: `sub_${randomUUID()}` },
          body: {},
          headers: { authorization: "Bearer clerk-session" },
        }),
        [404],
      );

      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    });
  });
});
