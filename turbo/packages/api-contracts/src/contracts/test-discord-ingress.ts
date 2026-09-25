import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testDiscordIngressContract = c.router({
  recover: {
    method: "POST",
    path: "/api/test/discord-ingress/recover",
    body: z.object({ connectionIds: z.array(z.uuid()).min(1).max(20) }),
    responses: {
      200: z.object({ processed: z.number().int().nonnegative() }),
      400: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Recover pending ingress for owned Discord test fixtures",
  },
});
