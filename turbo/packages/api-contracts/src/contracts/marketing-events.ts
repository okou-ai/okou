import {
  literal,
  object,
  strictObject,
  string,
  uuidv4,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";

const c = initContract();

export const marketingEventRequestSchema = strictObject({
  tag: zEnum(["onboarding-start", "checkout-start"]),
  eventId: uuidv4(),
});

export type MarketingEventRequest = zInfer<typeof marketingEventRequestSchema>;

const errorSchema = object({ code: string(), error: string() });

/** Marketing owns identity verification, first-touch attribution and event storage. */
export const marketingEventsContract = c.router({
  record: {
    method: "POST",
    path: "/api/events",
    headers: authHeadersSchema,
    body: marketingEventRequestSchema,
    responses: {
      200: object({ code: literal("EVENT_RECORDED") }),
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
