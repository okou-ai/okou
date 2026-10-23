import { createHmac, randomUUID } from "node:crypto";
import type StripeSDK from "stripe";
import {
  webhookStripeAutomationEventsContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { webhooksStripeAutomationEventsRoutes } from "../webhooks-stripe-automation-events";

const context = testContext();
const { default: ActualStripeSDK } = await vi.importActual<{
  default: typeof StripeSDK;
}>("stripe");

test.each(["billing", "automation"] as const)(
  "authenticates signed %s webhooks with the Worker's Web Crypto provider",
  async (ingress) => {
    const secret = "whsec_worker_signature_test";
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", secret);
    mockOptionalEnv("STRIPE_AUTOMATION_WEBHOOK_SECRET", secret);
    const stripe = new ActualStripeSDK("sk_test_worker_signature_test");
    // Stripe's worker export selects this asynchronous provider by default.
    const cryptoProvider = ActualStripeSDK.createSubtleCryptoProvider();
    context.mocks.stripe.webhooks.constructEventAsync.mockImplementation(
      (body, signature, webhookSecret) => {
        return stripe.webhooks.constructEventAsync(
          String(body),
          String(signature),
          String(webhookSecret),
          undefined,
          cryptoProvider,
        );
      },
    );

    const app = setupApp({
      context,
      routes: [
        ...webhooksStripeRoutes,
        ...webhooksStripeAutomationEventsRoutes,
      ],
    });
    const post =
      ingress === "billing"
        ? app(webhookStripeContract).post
        : app(webhookStripeAutomationEventsContract).post;
    const timestamp = Math.floor(now() / 1000);
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: "event",
      type: "customer.created",
      created: timestamp,
      livemode: false,
      data: { object: { id: `cus_${randomUUID()}` } },
    });
    const digest = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const extraHeaders = {
      "stripe-signature": `t=${timestamp},v1=${digest}`,
    };

    const accepted = await accept(post({ body, extraHeaders }), [200]);
    expect(accepted.body).toBe("OK");

    const tampered = await accept(
      post({
        body: body.replace("customer.created", "customer.deleted"),
        extraHeaders,
      }),
      [401],
    );
    expect(tampered.body).toStrictEqual({ error: "Invalid webhook signature" });
  },
);
