import { command } from "ccstate";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";

import { optionalEnv } from "../../lib/env";
import type { RouteEntry } from "../route-entry";
import { request$ } from "../context/hono";
import { constructStripeBillingWebhookEvent } from "../external/stripe-client";
import { settle } from "../utils";
import { handleStripeWebhookEvent$ } from "../services/webhooks-stripe.service";

function jsonError(message: string, status: 401 | 503): Response {
  return Response.json({ error: message }, { status });
}

const postStripeWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const webhookSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      return jsonError("Stripe billing is not configured", 503);
    }

    const request = get(request$);
    const signature = request.raw.headers.get("stripe-signature");
    if (!signature) {
      return jsonError("Missing stripe-signature header", 401);
    }

    const body = await request.text();
    signal.throwIfAborted();

    const eventResult = await settle(
      constructStripeBillingWebhookEvent(body, signature, webhookSecret),
      signal,
    );
    signal.throwIfAborted();
    if (!eventResult.ok) {
      return jsonError("Invalid webhook signature", 401);
    }

    const event = eventResult.value;
    await set(handleStripeWebhookEvent$, event, signal);
    signal.throwIfAborted();

    return new Response("OK", { status: 200 });
  },
);

export const webhooksStripeRoutes: readonly RouteEntry[] = [
  {
    route: webhookStripeContract.post,
    handler: postStripeWebhook$,
  },
];
