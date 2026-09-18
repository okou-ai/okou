import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";

const c = initContract();

export const marketingEventRequestSchema = z.strictObject({
  tag: z.enum(["onboarding-start", "checkout-start"]),
  eventId: z.uuidv4(),
});

export type MarketingEventRequest = z.infer<typeof marketingEventRequestSchema>;

const errorSchema = z.object({ code: z.string(), error: z.string() });

/** Marketing owns identity verification, first-touch attribution and event storage. */
export const marketingEventsContract = c.router({
  record: {
    method: "POST",
    path: "/api/events",
    headers: authHeadersSchema,
    body: marketingEventRequestSchema,
    responses: {
      200: z.object({ code: z.literal("EVENT_RECORDED") }),
      204: c.noBody(),
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      413: errorSchema,
      415: errorSchema,
      500: errorSchema,
      503: errorSchema,
    },
    summary: "Record a Marketing event with optional first-touch attribution",
  },
});
