import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { billingStatusRoutes } from "../../billing-status";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { createRouteMocks } from "./route-test";

/** Activate the real Pro subscription without an invoice or cash grant. */
export function createPublicUnfundedProFixture(
  context: TestContext,
  actor: ApiTestUser,
) {
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an owned unfunded Pro organization");
  }
  const suffix = randomUUID();
  const customerId = `cus_unfunded_pro_${suffix}`;
  const subscriptionId = `sub_unfunded_pro_${suffix}`;
  const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");
  const subscription = {
    id: subscriptionId,
    customer: customerId,
    status: "active",
    metadata: {},
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    items: { data: [{ price: { id: "price_bdd_pro" } }] },
  };

  async function readBillingStatus() {
    createRouteMocks(context).clerk.session(actor.userId, orgId, actor.orgRole);
    return await accept(
      setupApp({ context, routes: billingStatusRoutes })(
        billingStatusContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
  }

  const owner = createFixtureOperationOwner(async () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
    context.mocks.s3.send.mockResolvedValue({
      Contents: [],
      IsTruncated: false,
    });
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await flushWaitUntilForTest();

    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeBillingEnv();
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      status: "active",
      metadata: {},
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });
    context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
      id: subscriptionId,
      status: "canceled",
    });
    // Subscription activation sent no invoice, so there is nothing to refund.
    context.mocks.stripe.invoices.list.mockResolvedValue({
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

    // Production retains immutable plan and usage history under unique IDs.
    expect((await readBillingStatus()).body.credits).toBe(0);
    expect(
      (
        await createRunReadsApi(context).requestListLogs(
          actor,
          { limit: 50 },
          [200],
        )
      ).body.data,
    ).toStrictEqual([]);
  });

  return {
    run: owner.run,
    async initialize(): Promise<void> {
      await owner.run(async () => {
        const completed = await createBddApi(context).completeOnboarding(actor);
        expect(completed.status).toBe(200);
        expect((await readBillingStatus()).body.credits).toBe(0);

        const webhooks = createWebhookCallbackApi(context);
        webhooks.configureStripeBillingEnv();
        context.mocks.stripe.customers.retrieve.mockResolvedValue({
          id: customerId,
          metadata: { orgId },
        });
        await webhooks.postStripeEvent(
          {
            id: `evt_unfunded_pro_created_${suffix}`,
            type: "customer.subscription.created",
            created: Math.floor(now() / 1000),
            data: { object: subscription },
          },
          [200],
        );
        await webhooks.postStripeEvent(
          {
            id: `evt_unfunded_pro_updated_${suffix}`,
            type: "customer.subscription.updated",
            created: Math.floor(now() / 1000),
            data: { object: subscription },
          },
          [200],
        );
        await flushWaitUntilForTest();
        expect((await readBillingStatus()).body).toMatchObject({
          tier: "pro",
          status: "active",
          credits: 0,
        });
      });
    },
    async suspend(): Promise<void> {
      await owner.run(async () => {
        const webhooks = createWebhookCallbackApi(context);
        webhooks.configureStripeBillingEnv();
        context.mocks.stripe.customers.retrieve.mockResolvedValue({
          id: customerId,
          metadata: { orgId },
        });
        await webhooks.postStripeEvent(
          {
            id: `evt_unfunded_pro_suspended_${suffix}`,
            type: "customer.subscription.updated",
            created: Math.floor(now() / 1000),
            data: { object: { ...subscription, status: "canceled" } },
          },
          [200],
        );
        await flushWaitUntilForTest();
        expect((await readBillingStatus()).body).toMatchObject({
          tier: "pro",
          status: "suspended",
          credits: 0,
        });
      });
    },
  };
}
