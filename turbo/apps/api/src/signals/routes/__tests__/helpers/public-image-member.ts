import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { expect, onTestFinished } from "vitest";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { settleIncludingAbort } from "../../../utils";
import { billingStatusRoutes } from "../../billing-status";
import { webhooksBuiltInGenerationRoutes } from "../../webhooks-built-in-generations";
import { createBddApi } from "./api-bdd";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { captureConnectorExternalState } from "./public-connector-actor";
import { createPublicBillingZeroFixture } from "./public-billing-zero-fixture";
import { purchaseToolCredits } from "./public-tool-actor";
import { createRouteMocks } from "./route-test";
import { deleteFeatureSwitchesForUser } from "./feature-switches";

/** A paid member built from ordinary checkout metadata, with case-owned provider work. */
export async function createPublicImageMember(
  context: TestContext,
  options: { readonly credits: number; readonly ownsFeatures?: boolean },
) {
  const actor = createBddApi(context).user({ orgRole: "org:admin" });
  if (!actor.orgId) {
    throw new Error("Image generation requires an owned organization");
  }
  const orgId = actor.orgId;
  const callbacks = new Set<string>();
  function rememberRequest({ request }: { readonly request: Request }) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.hostname === "queue.fal.run") {
      const callback = url.searchParams.get("fal_webhook");
      if (callback) {
        callbacks.add(callback);
      }
    }
  }
  let restorePurchase: (() => void) | undefined;
  function retainExternalState() {
    const restore = captureConnectorExternalState(context, [
      "OKOU_PRICE_CUSTOM_CREDIT_UNIT",
      "FAL_KEY",
      "OPENAI_API_KEY",
      "R2_PRIVATE_ARTIFACTS_BUCKET_NAME",
      "R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID",
      "R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY",
    ]);
    const checkout =
      context.mocks.stripe.checkout.sessions.create.getMockImplementation();
    const token = context.mocks.ably.createTokenRequest.getMockImplementation();
    const restoreCurrentPurchase = restorePurchase;
    return () => {
      restore();
      context.mocks.stripe.checkout.sessions.create.mockReset();
      if (checkout) {
        context.mocks.stripe.checkout.sessions.create.mockImplementation(
          checkout,
        );
      }
      context.mocks.ably.createTokenRequest.mockReset();
      if (token) {
        context.mocks.ably.createTokenRequest.mockImplementation(token);
      }
      restoreCurrentPurchase?.();
    };
  }
  onTestFinished(() => {
    server.events.removeListener("request:start", rememberRequest);
  });
  server.events.on("request:start", rememberRequest);
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  const owner = createPublicBillingZeroFixture(context, actor, {
    plan: {
      tier: "pro",
      priceId: "price_bdd_pro",
      webhookSecret: "whsec_bdd_stripe",
    },
    continueAcceptedOperations: true,
    retainExternalState,
    beforeOrganizationCleanup: async () => {
      const errors: unknown[] = [];
      async function settle(operation: () => Promise<unknown>) {
        const result = await settleIncludingAbort(operation);
        if (!result.ok) {
          errors.push(result.error);
        }
      }
      await settle(flushWaitUntilForTest);
      for (const callback of callbacks) {
        await settle(async () => {
          const url = new URL(callback);
          const app = createAppWithRoutes({
            signal: context.signal,
            routes: webhooksBuiltInGenerationRoutes,
          });
          const response = await app.request(`${url.pathname}${url.search}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: "ERROR",
              error: "Image provider request cancelled during cleanup",
            }),
          });
          expect(response.status).toBe(200);
        });
      }
      await settle(flushWaitUntilForTest);
      if (options.ownsFeatures) {
        await settle(() => {
          return deleteFeatureSwitchesForUser(context, { ...actor, orgId });
        });
      }
      if (errors.length) {
        throw new AggregateError(errors, "Image provider cleanup failed");
      }
    },
  });
  await owner.initialize();
  if (options.credits > 0) {
    await owner.run(() => {
      return purchaseToolCredits(context, actor, {
        credits: options.credits,
        customerId: owner.customerId,
        invoiceId: `in_image_${randomUUID()}`,
        onExternalStateReady(restore) {
          restorePurchase = restore;
          owner.captureExternalState();
        },
      });
    });
  }
  restorePurchase = undefined;
  await owner.run(async () => {
    await webhooks.postStripeEvent(
      {
        id: `evt_image_plan_deleted_${randomUUID()}`,
        type: "customer.subscription.deleted",
        created: Math.floor(now() / 1000),
        data: {
          object: {
            id: owner.subscriptionId,
            customer: owner.customerId,
            status: "canceled",
            metadata: {},
            items: { data: [{ price: { id: "price_bdd_pro" } }] },
          },
        },
      },
      [200],
    );
    await flushWaitUntilForTest();
    createRouteMocks(context).clerk.session(actor.userId, orgId, actor.orgRole);
    const status = await accept(
      setupApp({ context, routes: billingStatusRoutes })(
        billingStatusContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(status.body).toMatchObject({
      tier: "limited-free-1",
      status: "active",
      credits: options.credits,
    });
  });
  owner.captureExternalState();
  return {
    ...actor,
    orgId,
    run: owner.run,
    captureExternalState: owner.captureExternalState,
  };
}
