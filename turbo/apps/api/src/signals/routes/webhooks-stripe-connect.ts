import { webhookStripeConnectContract } from "@okouai/api-contracts/contracts/webhooks";
import { command } from "ccstate";

import { optionalEnv } from "../../lib/env";
import { request$ } from "../context/hono";
import { constructStripeConnectWebhookEvent } from "../external/stripe-client";
import type { RouteEntry } from "../route-entry";
import { dispatchStripeConnectorEvent$ } from "../services/stripe-connector-event.service";
import { safeSync, settle } from "../utils";

function jsonError(message: string, status: 400 | 401 | 500 | 503): Response {
  return Response.json({ error: message }, { status });
}

const postStripeConnectEvent$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    // Existing Connect endpoints use this independently configured signing secret.
    const webhookSecret = optionalEnv("STRIPE_AUTOMATION_WEBHOOK_SECRET");
    if (!webhookSecret) {
      return jsonError("Stripe Connect events are not configured", 503);
    }
    const request = get(request$);
    const signature = request.raw.headers.get("stripe-signature");
    if (!signature) {
      return jsonError("Missing stripe-signature header", 401);
    }
    const rawBody = await request.text();
    signal.throwIfAborted();
    const constructed = safeSync(() => {
      return constructStripeConnectWebhookEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    });
    signal.throwIfAborted();
    if ("error" in constructed) {
      return jsonError("Invalid webhook signature", 401);
    }
    const dispatched = await settle(
      set(dispatchStripeConnectorEvent$, constructed.ok, signal),
      signal,
    );
    if (!dispatched.ok) {
      return jsonError("Stripe Connect event processing failed", 500);
    }
    if (dispatched.value === "bad_request") {
      return jsonError("Invalid supported Stripe Connect event", 400);
    }
    return new Response("OK", { status: 200 });
  },
);

export const webhooksStripeConnectRoutes: readonly RouteEntry[] = [
  {
    route: webhookStripeConnectContract.post,
    handler: postStripeConnectEvent$,
  },
];
