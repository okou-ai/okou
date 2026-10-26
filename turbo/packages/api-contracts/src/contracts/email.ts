import { literal, object, string, unknown as zUnknown } from "zod";

import { initContract } from "./base";

const c = initContract();

export const emailInboundContract = c.router({
  post: {
    method: "POST",
    path: "/api/email/inbound",
    headers: object({
      "svix-id": string().optional(),
      "svix-timestamp": string().optional(),
      "svix-signature": string().optional(),
    }),
    body: zUnknown(),
    responses: {
      200: object({ received: literal(true) }),
      401: object({ error: string() }),
    },
    summary: "Handle signed Resend email delivery events",
  },
});
