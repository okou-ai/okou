import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";

const c = initContract();

/** Marketing verifies the App bearer token and reads its own attribution cookies. */
export const marketingOnboardingContract = c.router({
  record: {
    method: "POST",
    path: "/api/marketing/onboarding-start",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: z.object({ error: z.string() }),
      403: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Bind Marketing attribution and record entry into onboarding",
  },
});
