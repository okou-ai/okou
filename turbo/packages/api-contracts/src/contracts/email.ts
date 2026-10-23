import * as z from "zod";

import { initContract } from "./base";

const c = initContract();

export const emailInboundContract = c.router({
  post: {
    method: "POST",
    path: "/api/email/inbound",
    headers: z.object({
      "svix-id": z.string().optional(),
      "svix-timestamp": z.string().optional(),
      "svix-signature": z.string().optional(),
    }),
    body: z.unknown(),
    responses: {
      200: z.object({ received: z.literal(true) }),
      401: z.object({ error: z.string() }),
    },
    summary: "Handle signed Resend email delivery events",
  },
});
