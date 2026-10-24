import { randomUUID } from "node:crypto";
import {
  orgInviteContract,
  orgMembersContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import { orgInviteRoutes } from "../org-invite";
import { orgReadRoutes } from "../org-read";
import type StripeSDK from "stripe";
import { mockOptionalEnv } from "../../../lib/env";

import {
  billingUsagePackCheckoutContract,
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

test.each([20, 50] as const)(
  "publishes a paid %s USD invitation and preserves it on replay",
  async (usagePackUsd) => {
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
        context.mocks.stripe.webhooks.constructEventAsync.mockImplementation(
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
        const invitationClient = setupApp({ context, routes: orgInviteRoutes })(
          orgInviteContract,
        );
        const headers = { authorization: "Bearer clerk-session" };
        const email = `${randomUUID()}@example.test`;
        const invitationId = `inv_${randomUUID()}`;
        const priceId =
          usagePackUsd === 20
            ? fixtureApi.TEST_PRICE_USAGE_PACK_20
            : fixtureApi.TEST_PRICE_USAGE_PACK_50;
        const amount = usagePackUsd * 50;
        context.mocks.stripe.invoices.createPreview.mockResolvedValue({
          currency: "usd",
          automatic_tax: { enabled: false },
          lines: {
            has_more: false,
            data: [line(priceId, amount, Math.floor(now() / 1000), true)],
          },
        });
        lifecycle.captureExternalState();
        const preview = await run(() => {
          return accept(
            invitationClient.previewPurchase({
              headers,
              body: { email, role: "member", usagePackUsd },
            }),
            [200],
          );
        });
        expect(preview.body).toMatchObject({
          usagePackUsd,
          immediateAmountCents: amount,
          currency: "usd",
        });
        const creditClient = setupApp({
          context,
          routes: billingUsagePackCreditsRoutes,
        })(billingUsagePackCreditsContract);
        const before = await run(() => {
          return accept(creditClient.get({ headers }), [200]);
        });
        const invoiceId = `in_invitation_${randomUUID()}`;
        let invitationMetadata: Readonly<Record<string, string>> | undefined;
        function purchasedInvoice(status: "draft" | "open" | "paid") {
          if (!invitationMetadata) {
            throw new Error("Invoice metadata was not published");
          }
          return {
            id: invoiceId,
            customer: customerId,
            metadata: invitationMetadata,
            status,
            paid: status === "paid",
            currency: "usd",
            amount_due: amount,
            amount_paid: status === "paid" ? amount : 0,
            status_transitions: { paid_at: Math.floor(now() / 1000) },
            payments: {
              data: [
                {
                  status: "paid",
                  amount_paid: amount,
                  payment: {
                    type: "payment_intent",
                    payment_intent: `pi_${invoiceId}`,
                  },
                },
              ],
            },
          };
        }
        context.mocks.stripe.invoices.create.mockImplementation((input) => {
          invitationMetadata = stripeInputMetadata(input);
          context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue(
            purchasedInvoice("open"),
          );
          context.mocks.stripe.invoices.pay.mockResolvedValue(
            purchasedInvoice("paid"),
          );
          context.mocks.stripe.invoices.retrieve.mockResolvedValue(
            purchasedInvoice("paid"),
          );
          lifecycle.captureExternalState();
          return Promise.resolve(purchasedInvoice("draft"));
        });
        context.mocks.stripe.invoiceItems.create.mockResolvedValue({
          id: `ii_${randomUUID()}`,
        });
        context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
          { id: invitationId },
        );
        lifecycle.captureExternalState();
        const confirm = () => {
          return run(() => {
            return accept(
              invitationClient.confirmPurchase({
                params: { purchaseId: preview.body.purchaseId },
                headers,
                body: {},
              }),
              [200],
            );
          });
        };
        expect((await confirm()).body).toStrictEqual({
          message: "Invitation purchased and sent",
        });
        context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
          {
            data: [
              {
                id: invitationId,
                emailAddress: email,
                role: "org:member",
                createdAt: now(),
                privateMetadata: invitationMetadata,
              },
            ],
          },
        );
        lifecycle.captureExternalState();
        const membersClient = setupApp({ context, routes: orgReadRoutes })(
          orgMembersContract,
        );
        const members = () => {
          return run(() => {
            return accept(membersClient.members({ headers }), [200]);
          });
        };
        expect((await members()).body.pendingInvitations).toStrictEqual([
          {
            id: invitationId,
            email,
            role: "member",
            createdAt: new Date(now()).toISOString(),
            usagePackUsd,
          },
        ]);
        context.mocks.stripe.invoices.create.mockRejectedValue(
          new Error("Published invitation must not be charged again"),
        );
        context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValue(
          new Error("Published invitation must not be sent again"),
        );
        lifecycle.captureExternalState();
        expect((await confirm()).body).toStrictEqual({
          message: "Invitation purchased and sent",
        });
        expect((await members()).body.pendingInvitations).toStrictEqual([
          {
            id: invitationId,
            email,
            role: "member",
            createdAt: new Date(now()).toISOString(),
            usagePackUsd,
          },
        ]);
        expect(
          (
            await run(() => {
              return accept(creditClient.get({ headers }), [200]);
            })
          ).body,
        ).toStrictEqual(before.body);
      });
    });
  },
);
