import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
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
export const marketingAcquisitionContract = c.router({
  events: {
    method: "POST",
    path: "/api/marketing/acquisition/events",
    headers: authHeadersSchema,
    body: z
      .object({
        checkSignup: z.boolean(),
        sessionId: z.uuid().optional(),
        events: z.array(observedAcquisitionEventSchema).max(20),
      })
      .strict(),
    responses: {
      200: z.object({
        recorded: z.boolean(),
        consented: z.boolean(),
      }),
      400: z.object({ error: z.string() }),
      401: z.object({ error: z.string() }),
      403: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
  },
});
