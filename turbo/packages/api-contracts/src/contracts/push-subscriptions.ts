import * as z from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const pushSubscriptionsContract = c.router({
  register: {
    method: "POST",
    path: "/api/push-subscriptions",
    headers: authHeadersSchema,
    body: z.object({
      endpoint: z.string().url(),
      keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1),
      }),
    }),
    responses: {
      201: z.object({ success: z.literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Register a Web Push subscription for the current user",
  },
});

export type PushSubscriptionsContract = typeof pushSubscriptionsContract;
