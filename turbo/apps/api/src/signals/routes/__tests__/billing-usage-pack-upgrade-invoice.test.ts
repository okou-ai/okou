import { randomUUID } from "node:crypto";
import type StripeSDK from "stripe";
import { mockOptionalEnv } from "../../../lib/env";

import {
  billingUsagePackCheckoutContract,
  billingUsagePackManagementContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now, withNowScopeForTest } from "../../../lib/time";
import { billingCheckoutRoutes } from "../billing-checkout";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBillingCheckoutFixture } from "./helpers/billing-checkout-fixture";
import { createPublicBillingScenario } from "./helpers/public-billing-scenario";

const { default: ActualStripeSDK } = await vi.importActual<{
  default: typeof StripeSDK;
}>("stripe");
const fixtureApi = createBillingCheckoutFixture();
const {
  context,
  authenticateOrg,
  mockClerkOrganization,
  mockUsagePackCatalog,
  usagePackCheckoutBody,
  stripeInputMetadata,
  TEST_PRICE_USAGE_PACK_PLAN_PRO,
  TEST_PRICE_USAGE_PACK_20,
  TEST_PRICE_USAGE_PACK_50,
  STRIPE_WEBHOOK_SECRET,
} = fixtureApi;

beforeEach(() => {
  fixtureApi.setTierPrices();
  fixtureApi.setUsagePackPrices();
  mockUsagePackCatalog();
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  context.mocks.stripe.invoices.list.mockResolvedValue({ data: [] });
  context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
});

// Each case uses a unique public tenant in this run's owned native PostgreSQL
// database. The existing fixture operation owner drains every accepted delivery.
test.each([
  { remainingSeconds: 1, pending: false, purchased: 0, bonus: 0 },
  { remainingSeconds: 1, pending: true, purchased: 0, bonus: 0 },
  { remainingSeconds: 87, pending: true, purchased: 1, bonus: 0 },
  {
    remainingSeconds: 15 * 86_400,
    pending: true,
    purchased: 15_000,
    bonus: 1100,
  },
])(
  "completes and replays a 20 USD to 50 USD upgrade with $remainingSeconds seconds remaining (pending=$pending)",
  async ({ remainingSeconds, pending, purchased, bonus }) => {
    const actor = fixtureApi.createOwnedBillingOrg({
      retainCheckoutState: true,
    });
    const lifecycle = createPublicBillingScenario(context);
    const run = <T>(operation: () => Promise<T>) => {
      return actor.run(() => {
        return lifecycle.run(operation);
      });
    };
    return await withNowScopeForTest(() => {
      return run(async () => {
        mockNow(new Date("2035-01-16T00:00:00.000Z"));
        await run(() => {
          return actor.initialize();
        });
        authenticateOrg(actor);
        mockClerkOrganization(actor);
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
          {
            data: [
              {
                role: "org:admin",
                publicUserData: {
                  userId: actor.userId,
                  identifier: `${actor.userId}@example.test`,
                },
                createdAt: now(),
              },
            ],
          },
        );
        context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
          { data: [] },
        );
        const customerId = `cus_${randomUUID()}`,
          subscriptionId = `sub_${randomUUID()}`,
          sessionId = `cs_${randomUUID()}`;
        context.mocks.stripe.customers.create.mockResolvedValue({
          id: customerId,
        });
        let metadata: Record<string, string> | undefined;
        context.mocks.stripe.checkout.sessions.create.mockImplementation(
          (input) => {
            metadata = stripeInputMetadata(input);
            return Promise.resolve({
              id: sessionId,
              url: `https://checkout.stripe.test/${sessionId}`,
            });
          },
        );
        lifecycle.captureExternalState();
        await run(() => {
          return accept(
            setupApp({ context, routes: billingCheckoutRoutes })(
              billingUsagePackCheckoutContract,
            ).create({
              headers: { authorization: "Bearer clerk-session" },
              body: usagePackCheckoutBody(actor.userId),
            }),
            [200],
          );
        });
        if (!metadata) {
          throw new Error(
            "Public Checkout did not publish usage-pack metadata",
          );
        }
        const billingMetadata = metadata;
        const start = Math.floor(now() / 1000) - 15 * 86_400,
          end = Math.floor(now() / 1000) + 15 * 86_400;
        function subscription(
          priceId: string,
          latestInvoice: object | null = null,
          pendingUpdate: object | null = null,
        ) {
          return {
            id: subscriptionId,
            customer: customerId,
            status: "active",
            cancel_at: null,
            cancel_at_period_end: false,
            schedule: null,
            pending_update: pendingUpdate,
            latest_invoice: latestInvoice,
            metadata: billingMetadata,
            items: {
              data: [
                {
                  id: "si_plan",
                  price: {
                    id: TEST_PRICE_USAGE_PACK_PLAN_PRO,
                    recurring: { interval: "month", interval_count: 1 },
                  },
                  quantity: 1,
                  current_period_start: start,
                  current_period_end: end,
                },
                {
                  id: `si_${priceId}`,
                  price: {
                    id: priceId,
                    recurring: { interval: "month", interval_count: 1 },
                  },
                  quantity: 1,
                  current_period_start: start,
                  current_period_end: end,
                },
              ],
            },
          };
        }
        function line(
          priceId: string,
          amount: number,
          periodStart: number,
          proration: boolean,
        ) {
          return {
            id: `il_${randomUUID()}`,
            amount,
            subtotal: amount,
            quantity: 1,
            price: { id: priceId },
            period: { start: periodStart, end },
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration },
            },
          };
        }
        function invoice(id: string, lines: readonly object[]) {
          return {
            id,
            customer: customerId,
            metadata: billingMetadata,
            status: "paid",
            paid: true,
            total: 1500,
            amount_paid: 1500,
            hosted_invoice_url: `https://invoice.stripe.test/${id}`,
            parent: {
              subscription_details: {
                subscription: subscriptionId,
                metadata: billingMetadata,
              },
            },
            lines: { has_more: false, data: lines },
          };
        }
        const sdk = new ActualStripeSDK("sk_test_fixture_signature_only");
        context.mocks.stripe.webhooks.constructEvent.mockImplementation(
          (body, signature, secret) => {
            return sdk.webhooks.constructEvent(
              String(body),
              String(signature),
              String(secret),
            );
          },
        );
        async function deliver(object: object) {
          const event = {
            id: `evt_${randomUUID()}`,
            type: "invoice.paid",
            created: Math.floor(now() / 1000),
            data: { object },
          };
          const body = JSON.stringify(event);
          const signature = sdk.webhooks.generateTestHeaderString({
            payload: body,
            secret: STRIPE_WEBHOOK_SECRET,
          });
          return await run(() => {
            return accept(
              setupApp({ context, routes: webhooksStripeRoutes })(
                webhookStripeContract,
              ).post({ body, extraHeaders: { "stripe-signature": signature } }),
              [200],
            );
          });
        }
        const oldSubscription = subscription(TEST_PRICE_USAGE_PACK_20);
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          oldSubscription,
        );
        lifecycle.captureExternalState();
        await deliver(
          invoice(`in_purchase_${randomUUID()}`, [
            line(TEST_PRICE_USAGE_PACK_20, 2000, start, false),
          ]),
        );
        const management = setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        );
        const creditClient = setupApp({
          context,
          routes: billingUsagePackCreditsRoutes,
        })(billingUsagePackCreditsContract);
        async function readCredits() {
          const response = await run(() => {
            return accept(
              creditClient.get({
                headers: { authorization: "Bearer clerk-session" },
              }),
              [200],
            );
          });
          return {
            ...response.body,
            creditGrants: [...response.body.creditGrants].sort((a, b) => {
              return a.id.localeCompare(b.id);
            }),
            memberCredits: response.body.memberCredits?.map((member) => {
              return {
                ...member,
                creditGrants: [...member.creditGrants].sort((a, b) => {
                  return a.id.localeCompare(b.id);
                }),
              };
            }),
          };
        }
        const before = await readCredits();
        expect(before).toMatchObject({
          purchasedCredits: 20_000,
          bonusCredits: 400,
          totalCredits: 20_400,
        });
        expect(before.creditGrants).toHaveLength(2);
        mockNow(new Date((end - remainingSeconds) * 1000));
        const prorationTimestamp = end - remainingSeconds;
        context.mocks.stripe.invoices.createPreview.mockImplementation(
          (input) => {
            if (typeof input !== "object" || input === null) {
              throw new Error("Expected public preview provider input");
            }
            const immediate =
              "preview_mode" in input && input.preview_mode === "next";
            return Promise.resolve({
              id: `in_preview_${randomUUID()}`,
              amount_due: immediate ? 1500 : 5000,
              currency: "usd",
              lines: {
                has_more: false,
                data: immediate
                  ? [
                      line(
                        TEST_PRICE_USAGE_PACK_50,
                        1500,
                        prorationTimestamp,
                        true,
                      ),
                    ]
                  : [],
              },
            });
          },
        );
        lifecycle.captureExternalState();
        const preview = await run(() => {
          return accept(
            management.previewChange({
              headers: { authorization: "Bearer clerk-session" },
              body: { memberId: actor.userId, targetUsagePackUsd: 50 },
            }),
            [200],
          );
        });
        expect(preview.body.prorationDate).toBe(
          new Date(prorationTimestamp * 1000).toISOString(),
        );
        const paidInvoice = invoice(`in_upgrade_${randomUUID()}`, [
          line(TEST_PRICE_USAGE_PACK_20, -1000, prorationTimestamp, true),
          line(TEST_PRICE_USAGE_PACK_50, 2500, prorationTimestamp, true),
        ]);
        const upgraded = subscription(TEST_PRICE_USAGE_PACK_50, paidInvoice);
        let applied = false;
        context.mocks.stripe.subscriptions.retrieve.mockImplementation(() => {
          const current = applied ? upgraded : oldSubscription;
          return Promise.resolve(current);
        });
        context.mocks.stripe.subscriptions.update.mockImplementation(() => {
          if (!pending) {
            applied = true;
            return Promise.resolve(upgraded);
          }
          return Promise.resolve(
            subscription(
              TEST_PRICE_USAGE_PACK_20,
              {
                id: paidInvoice.id,
                status: "open",
                hosted_invoice_url: paidInvoice.hosted_invoice_url,
              },
              { expires_at: end + 300 },
            ),
          );
        });
        lifecycle.captureExternalState();
        const confirmed = await run(() => {
          return accept(
            management.confirmChange({
              params: { changeId: preview.body.changeId },
              headers: { authorization: "Bearer clerk-session" },
              body: {},
            }),
            [200],
          );
        });
        expect(confirmed.body.status).toBe(
          pending ? "pending_payment" : "completed",
        );
        if (pending) {
          await expect(readCredits()).resolves.toStrictEqual(before);
        }
        applied = true;
        lifecycle.captureExternalState();
        const deliveries = await Promise.allSettled(
          Array.from({ length: 8 }, () => {
            return deliver(paidInvoice);
          }),
        );
        const deliveredManagement = await run(() => {
          return accept(
            management.get({
              headers: { authorization: "Bearer clerk-session" },
            }),
            [200],
          );
        });
        expect(deliveredManagement.body.allocations).toStrictEqual([
          expect.objectContaining({
            memberId: actor.userId,
            usagePackUsd: 50,
            pendingChange: null,
          }),
        ]);
        expect(deliveries).toStrictEqual(
          Array.from({ length: 8 }, () => {
            return {
              status: "fulfilled",
              value: expect.objectContaining({ status: 200 }),
            };
          }),
        );
        const managed = await run(() => {
          return accept(
            management.get({
              headers: { authorization: "Bearer clerk-session" },
            }),
            [200],
          );
        });
        const credits = await readCredits();
        expect(credits).toMatchObject({
          purchasedCredits: 20_000 + purchased,
          bonusCredits: 400 + bonus,
          totalCredits: 20_400 + purchased + bonus,
        });
        expect(credits.creditGrants).toHaveLength(
          2 + (purchased > 0 ? 1 : 0) + (bonus > 0 ? 1 : 0),
        );
        expect(credits.creditGrants).toStrictEqual(
          expect.arrayContaining(before.creditGrants),
        );
        if (purchased > 0) {
          expect(credits.creditGrants).toContainEqual(
            expect.objectContaining({
              grantType: "purchased",
              amount: purchased,
              remaining: purchased,
              expiresAt: new Date(end * 1000).toISOString(),
            }),
          );
        }
        if (bonus > 0) {
          expect(credits.creditGrants).toContainEqual(
            expect.objectContaining({
              grantType: "bonus",
              amount: bonus,
              remaining: bonus,
              expiresAt: new Date(end * 1000).toISOString(),
            }),
          );
        }
        await deliver(paidInvoice);
        await expect(readCredits()).resolves.toStrictEqual(credits);
        await expect(
          run(() => {
            return accept(
              management.get({
                headers: { authorization: "Bearer clerk-session" },
              }),
              [200],
            );
          }),
        ).resolves.toStrictEqual(managed);
        expect(
          context.mocks.stripe.subscriptions.update,
        ).toHaveBeenCalledOnce();
        expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
          subscriptionId,
          expect.objectContaining({
            payment_behavior: "pending_if_incomplete",
            proration_behavior: "always_invoice",
            proration_date: prorationTimestamp,
          }),
          {
            idempotencyKey: `usage-pack-change:${preview.body.changeId}:apply`,
          },
        );
        expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
        expect(context.mocks.stripe.refunds.create).not.toHaveBeenCalled();
      });
    });
  },
);
