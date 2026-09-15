import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

/** Marketing owns this cookie-authenticated endpoint; it receives no App bearer token. */
export const impactOnboardingContract = c.router({
  record: {
    method: "POST",
    path: "/api/marketing/impact/onboarding",
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: z.object({ error: z.string() }),
      403: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Associate existing Marketing attribution during onboarding",
  },
});
