import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import StripeSDK from "stripe";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import {
  mockStripeClient,
  type StripeSubscription,
} from "../../../external/stripe-client";
import { settleIncludingAbort } from "../../../utils";
import { billingStatusRoutes } from "../../billing-status";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { createRouteMocks } from "./route-test";

/** Public onboarding and optional Plan activation, with no cash invoice. */
export function createPublicBillingZeroFixture(
  context: TestContext,
  actor: ApiTestUser,
  options: {
    readonly plan?: {
      readonly tier: "pro" | "team" | "custom";
      readonly priceId: string;
      readonly webhookSecret: string;
    };
    readonly foreverCustom?: {
      readonly priceId: string;
      readonly webhookSecret: string;
    };
    readonly beforeOrganizationCleanup?: () => Promise<void>;
    readonly afterOrganizationCleanup?: () => Promise<void>;
  } = {},
) {
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an owned billing organization");
  }
  const suffix = randomUUID();
  const customerId = `cus_zero_${suffix}`;
  const subscriptionId = `sub_zero_${suffix}`;
  const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");

  async function readStatus() {
    createRouteMocks(context).clerk.session(actor.userId, orgId, "org:admin");
    return await accept(
      setupApp({ context, routes: billingStatusRoutes })(
        billingStatusContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
  }

  const owner = createFixtureOperationOwner(async () => {
    const outcome = await settleIncludingAbort(
      (async () => {
        mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
        mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
        context.mocks.s3.send.mockResolvedValue({
          Contents: [],
          IsTruncated: false,
        });
        context.mocks.ably.publish.mockResolvedValue(undefined);
        await flushWaitUntilForTest();
        const additionalCleanup = await settleIncludingAbort(
          options.beforeOrganizationCleanup?.() ?? Promise.resolve(),
        );

        const webhooks = createWebhookCallbackApi(context);
        webhooks.configureStripeBillingEnv();
        context.mocks.stripe.subscriptions.list.mockReset().mockResolvedValue({
          data: [],
          has_more: false,
        });
        context.mocks.stripe.subscriptions.retrieve
          .mockReset()
          .mockImplementation((id: string) => {
            const subscription: StripeSubscription = {
              id,
              customer: customerId,
              status: "active",
              metadata: { orgId },
              cancel_at_period_end: false,
              latest_invoice: null,
              items: { data: [] },
            };
            return Promise.resolve(subscription);
          });
        context.mocks.stripe.subscriptions.update
          .mockReset()
          .mockImplementation((id) => {
            return Promise.resolve({ id });
          });
        context.mocks.stripe.subscriptions.cancel
          .mockReset()
          .mockImplementation((id) => {
            return Promise.resolve({ id, status: "canceled" });
          });
        context.mocks.stripe.invoices.list.mockReset().mockResolvedValue({
          data: [],
          has_more: false,
        });
        webhooks.configureClerkWebhookSecret();
        webhooks.verifyNextClerkWebhook({
          type: "organization.deleted",
          data: { id: orgId },
        });
        await webhooks.requestClerkWebhook("{}", {}, [200]);
        await flushWaitUntilForTest();
        // Immutable financial and invitation receipts remain under this UUID owner.
        expect((await readStatus()).body.credits).toBe(0);
        if (!additionalCleanup.ok) {
          throw additionalCleanup.error;
        }
      })(),
    );
    const released = await settleIncludingAbort(
      options.afterOrganizationCleanup?.() ?? Promise.resolve(),
    );
    if (!outcome.ok) {
      throw outcome.error;
    }
    if (!released.ok) {
      throw released.error;
    }
  });

  return {
    customerId,
    subscriptionId,
    run: owner.run,
    async initialize(): Promise<void> {
      await owner.run(async () => {
        const completed = await createBddApi(context).completeOnboarding(actor);
        expect(completed.status).toBe(200);
        expect((await readStatus()).body).toMatchObject({
          tier: "limited-free-1",
          status: "active",
          credits: 0,
        });
        if (options.foreverCustom) {
          mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
          mockEnv("ATOM_GRANT_PRICE", options.foreverCustom.priceId);
          mockOptionalEnv(
            "STRIPE_WEBHOOK_SECRET",
            options.foreverCustom.webhookSecret,
          );
          context.mocks.stripe.subscriptions.list.mockResolvedValue({
            data: [],
            has_more: false,
          });
          context.mocks.stripe.customers.retrieve.mockResolvedValue({
            id: customerId,
            metadata: { orgId },
          });
          const seconds = Math.floor(now() / 1000);
          await createWebhookCallbackApi(context).postStripeEvent(
            {
              id: `evt_forever_${suffix}`,
              type: "invoice.paid",
              created: seconds,
              data: {
                object: {
                  id: `in_forever_${suffix}`,
                  customer: customerId,
                  metadata: {
                    type: "atom_grant",
                    purpose: "atom_grant",
                    source: "atom_entitlement",
                    orgId,
                    tier: "custom",
                    duration: "forever",
                  },
                  parent: null,
                  lines: {
                    has_more: false,
                    data: [
                      {
                        id: `il_forever_${suffix}`,
                        quantity: 1,
                        price: { id: options.foreverCustom.priceId },
                        period: { start: seconds, end: seconds + 30 * 86_400 },
                        parent: { type: "invoice_item_details" },
                      },
                    ],
                  },
                },
              },
            },
            [200],
          );
          await flushWaitUntilForTest();
          expect((await readStatus()).body).toMatchObject({
            tier: "custom",
            status: "active",
            credits: 0,
            hasSubscription: false,
            currentPeriodEnd: null,
            concurrencyLimit: 10,
            creditBreakdown: [],
          });
        }
        if (!options.plan) {
          return;
        }
        mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
        mockOptionalEnv("STRIPE_WEBHOOK_SECRET", options.plan.webhookSecret);
        context.mocks.stripe.customers.retrieve.mockResolvedValue({
          id: customerId,
          metadata: { orgId },
        });
        const subscription = {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: null,
          trial_end: null,
          items: { data: [{ price: { id: options.plan.priceId } }] },
        };
        const webhooks = createWebhookCallbackApi(context);
        for (const type of [
          "customer.subscription.created",
          "customer.subscription.updated",
        ] as const) {
          await webhooks.postStripeEvent(
            {
              id: `evt_zero_${type}_${suffix}`,
              type,
              created: Math.floor(now() / 1000),
              data: { object: subscription },
            },
            [200],
          );
        }
        await flushWaitUntilForTest();
        expect((await readStatus()).body).toMatchObject({
          tier: options.plan.tier,
          status: "active",
          credits: 0,
        });
      });
    },
  };
}
