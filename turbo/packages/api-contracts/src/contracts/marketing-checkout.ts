import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";

const c = initContract();

export const marketingCheckoutRequestSchema = z.strictObject({
  eventId: z.uuidv4(),
  occurredAt: z.iso.datetime({ precision: 3 }),
  checkoutSource: z.enum(["onboarding_video", "paywall"]),
});

export type MarketingCheckoutRequest = z.infer<
  typeof marketingCheckoutRequestSchema
>;

/** Marketing derives identity from the token and attribution from its cookies. */
export const marketingCheckoutContract = c.router({
  record: {
    method: "POST",
    path: "/api/marketing/checkout-start",
    headers: authHeadersSchema,
    body: marketingCheckoutRequestSchema,
    responses: {
      204: c.noBody(),
      400: z.object({ error: z.string() }),
      401: z.object({ error: z.string() }),
      403: z.object({ error: z.string() }),
      413: z.object({ error: z.string() }),
      415: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Record an actual Stripe checkout redirect in Marketing",
  },
});
