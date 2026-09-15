import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
export const observedAcquisitionEventSchema = z
  .object({
    id: z.uuid(),
    name: z.enum([
      "StepViewed",
      "CheckoutCreated",
      "RoleConfirmed",
      "RedirectToStripe",
      "AppHandoff",
    ]),
    at: z.number().int().positive(),
    properties: z
      .object({
        step_key: z.string().max(120).optional(),
        step_index: z.number().int().optional(),
        step_count: z.number().int().optional(),
        checkout_source: z.string().max(120).optional(),
        role: z.string().max(120).optional(),
        destination: z.literal("app").optional(),
        prompt_present: z.boolean().optional(),
        prompt_length: z.number().int().nonnegative().optional(),
        route_path: z
          .string()
          .max(120)
          .regex(/^\/[^?#]*$/)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type ObservedAcquisitionEvent = z.infer<
  typeof observedAcquisitionEventSchema
>;
export const impactMarketingContract = c.router({
  handoff: {
    method: "POST",
    path: "/api/attribution/impact/handoff",
    headers: authHeadersSchema,
    body: z
      .object({
        acquisition: z
          .object({
            version: z.literal(2),
            checkSignup: z.boolean(),
            events: z.array(observedAcquisitionEventSchema).max(2),
          })
          .strict()
          .optional(),
      })
      .strict(),
    responses: {
      200: z.object({
        handoff: z
          .object({ token: z.string(), nonce: z.string(), iframeUrl: z.url() })
          .nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Issue a short-lived identity and observed-event proof for the Marketing iframe",
  },
});
