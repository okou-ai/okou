import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

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

export const impactMarketingContract = c.router({
  handoff: {
    method: "POST",
    path: "/api/attribution/impact/handoff",
    headers: authHeadersSchema,
    body: z.object({}).strict(),
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
      "Issue a short-lived identity proof for the Marketing Impact iframe",
  },
});
