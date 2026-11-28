import { randomUUID } from "node:crypto";
import {
  webhookStripeConnectContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it, vi } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { webhooksStripeConnectRoutes } from "../webhooks-stripe-connect";

const context = testContext();

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string`);
  }
  return value;
}

/**
 * Configures both Stripe endpoint secrets and verifies signatures with the
 * real Stripe SDK through its asynchronous Web Crypto provider, as the Worker
 * runtime does. Returns the real SDK so the caller can sign as Stripe would.
 */
async function configureWorkerStripeWebhooks() {
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", `whsec_billing_${randomUUID()}`);
  mockOptionalEnv(
    "STRIPE_AUTOMATION_WEBHOOK_SECRET",
    `whsec_connect_${randomUUID()}`,
  );
  const { default: Stripe } =
    await vi.importActual<typeof import("stripe")>("stripe");
  const cryptoProvider = Stripe.createSubtleCryptoProvider();
  context.mocks.stripe.webhooks.constructEventAsync.mockImplementation(
    (payload: unknown, header: unknown, secret: unknown) => {
      return Stripe.webhooks.constructEventAsync(
        requiredString(payload, "payload"),
        requiredString(header, "stripe-signature header"),
        requiredString(secret, "webhook secret"),
        undefined,
        cryptoProvider,
      );
    },
  );
  return Stripe;
}

function configuredSecret(name: string): string {
  const secret = optionalEnv(name);
  if (!secret) {
    throw new Error(`Expected ${name} to be configured`);
  }
  return secret;
}

function customerEvent(type: "customer.created" | "customer.deleted") {
  return JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: "event",
    type,
    created: Math.floor(now() / 1000),
    livemode: false,
    data: { object: { id: `cus_${randomUUID()}`, object: "customer" } },
  });
}

describe("Stripe webhook signatures in the Worker runtime", () => {
  it("webhooks-stripe-worker-001 accepts a Stripe-signed billing event and rejects the same signature on a changed body", async () => {
    const Stripe = await configureWorkerStripeWebhooks();
    const client = setupApp({ context, routes: webhooksStripeRoutes })(
      webhookStripeContract,
    );
    const payload = customerEvent("customer.created");
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: configuredSecret("STRIPE_WEBHOOK_SECRET"),
    });

    const signed = await accept(
      client.post({
        body: payload,
        extraHeaders: { "stripe-signature": signature },
      }),
      [200],
    );
    expect(signed.body).toBe("OK");

    const tampered = await accept(
      client.post({
        body: payload.replace('"customer.created"', '"customer.deleted"'),
        extraHeaders: { "stripe-signature": signature },
      }),
      [401],
    );
    expect(tampered.body).toStrictEqual({
      error: "Invalid webhook signature",
    });
  });

  it("webhooks-stripe-worker-002 accepts a Stripe-signed Connect event and rejects the same signature on a changed body", async () => {
    const Stripe = await configureWorkerStripeWebhooks();
    const client = setupApp({ context, routes: webhooksStripeConnectRoutes })(
      webhookStripeConnectContract,
    );
    const payload = customerEvent("customer.created");
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: configuredSecret("STRIPE_AUTOMATION_WEBHOOK_SECRET"),
    });

    const signed = await accept(
      client.post({
        body: payload,
        extraHeaders: { "stripe-signature": signature },
      }),
      [200],
    );
    expect(signed.body).toBe("OK");

    const tampered = await accept(
      client.post({
        body: payload.replace('"customer.created"', '"customer.deleted"'),
        extraHeaders: { "stripe-signature": signature },
      }),
      [401],
    );
    expect(tampered.body).toStrictEqual({
      error: "Invalid webhook signature",
    });
  });
});
