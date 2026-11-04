import { literal, object, string, url } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const pushSubscriptionsContract = c.router({
  register: {
    method: "POST",
    path: "/api/push-subscriptions",
    headers: authHeadersSchema,
    body: object({
      endpoint: url(),
      keys: object({
        p256dh: string().min(1),
        auth: string().min(1),
      }),
    }),
    responses: {
      201: object({ success: literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Register a Web Push subscription for the current user",
  },
});

export type PushSubscriptionsContract = typeof pushSubscriptionsContract;
