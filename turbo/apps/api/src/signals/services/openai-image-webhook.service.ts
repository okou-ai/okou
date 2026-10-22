import { command } from "ccstate";
import { Webhook } from "svix";
import { z } from "zod";
import { openaiImageWebhookReceipts } from "@okouai/db/schema/openai-image-webhook-receipt";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { safeJsonParse, safeSync } from "../utils";

const terminalEventTypes = Object.freeze([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.cancelled",
]);

const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
});
const terminalEventSchema = eventSchema.extend({
  data: z.object({ id: z.string().min(1) }),
});

type ReceiptResult = "ok" | "unauthorized" | "bad_request" | "not_configured";

export const ingestOpenaiImageWebhook$ = command(
  async (
    { set },
    input: { readonly rawBody: string; readonly headers: Headers },
  ): Promise<ReceiptResult> => {
    const secret = env("OPENAI_IMAGE_WEBHOOK_SECRET");
    if (!secret) {
      return "not_configured";
    }

    // Standard Webhooks verifies the exact body and signed message ID, accepts
    // rotated v1 signatures, decodes whsec_ secrets, and enforces its 5m tolerance.
    const verification = safeSync(() => {
      return new Webhook(secret).verify(input.rawBody, {
        "webhook-id": input.headers.get("webhook-id") ?? "",
        "webhook-timestamp": input.headers.get("webhook-timestamp") ?? "",
        "webhook-signature": input.headers.get("webhook-signature") ?? "",
      });
    });
    if ("error" in verification) {
      return "unauthorized";
    }

    const payload = safeJsonParse(input.rawBody);
    const event = eventSchema.safeParse(payload);
    if (!event.success) {
      return "bad_request";
    }
    if (!terminalEventTypes.includes(event.data.type)) {
      return "ok";
    }
    const terminalEvent = terminalEventSchema.safeParse(payload);
    if (!terminalEvent.success) {
      return "bad_request";
    }

    // Acknowledge only after durable insertion. Duplicates are successful;
    // database failures propagate so the provider can redeliver the same event.
    const db = set(writeDb$);
    await db
      .insert(openaiImageWebhookReceipts)
      .values({
        eventId: terminalEvent.data.id,
        responseId: terminalEvent.data.data.id,
        eventType: terminalEvent.data.type,
      })
      .onConflictDoNothing({ target: openaiImageWebhookReceipts.eventId });
    return "ok";
  },
);
