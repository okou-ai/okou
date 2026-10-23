import { webhookStripeAutomationEventsContract } from "@okouai/api-contracts/contracts/webhooks";
import { command } from "ccstate";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { request$ } from "../context/hono";
import { constructStripeWebhookEvent } from "../external/stripe-client";
import type { RouteEntry } from "../route-entry";
import { dispatchStripeAutomationEvent$ } from "../services/stripe-automation-event.service";
import { settle } from "../utils";

const log = logger("api:webhooks-stripe-automation-events");

function jsonError(message: string, status: 400 | 401 | 500 | 503): Response {
  return Response.json({ error: message }, { status });
}

const postStripeAutomationEvent$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const webhookSecret = optionalEnv("STRIPE_AUTOMATION_WEBHOOK_SECRET");
    if (!webhookSecret) {
      return jsonError("Stripe automation events are not configured", 503);
    }

    const request = get(request$);
    const signature = request.raw.headers.get("stripe-signature");
    if (!signature) {
      return jsonError("Missing stripe-signature header", 401);
    }
    const rawBody = await request.text();
    signal.throwIfAborted();
    const constructed = await settle(
      constructStripeWebhookEvent(rawBody, signature, webhookSecret),
      signal,
    );
    signal.throwIfAborted();
    if (!constructed.ok) {
      return jsonError("Invalid webhook signature", 401);
    }

    const dispatched = await settle(
      set(dispatchStripeAutomationEvent$, constructed.value, signal),
      signal,
    );
    if (!dispatched.ok) {
      log.error("Stripe automation ingress transaction failed", {
        category: "ingress_transaction",
      });
      return jsonError("Stripe automation event processing failed", 500);
    }
    if (dispatched.value.kind === "bad_request") {
      return jsonError("Invalid supported Stripe automation event", 400);
    }
    return new Response("OK", { status: 200 });
  },
);

export const webhooksStripeAutomationEventsRoutes: readonly RouteEntry[] = [
  {
    route: webhookStripeAutomationEventsContract.post,
    handler: postStripeAutomationEvent$,
  },
];
