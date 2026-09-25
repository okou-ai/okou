import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

export const testDiscordDeliveriesContract = c.router({
  drain: {
    method: "POST",
    path: "/api/test/discord-deliveries/drain",
    body: z.object({
      connectionIds: z.array(z.string().uuid()).min(1).max(20),
    }),
    responses: { 200: z.object({ success: z.literal(true) }), 404: z.string() },
    summary: "Recover pending replies for owned Discord test fixtures",
  },
});
