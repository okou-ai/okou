import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
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
  sync: {
    method: "POST",
    path: "/api/attribution/impact/sync",
    headers: authHeadersSchema,
    body: z.object({}).strict(),
    responses: {
      200: z.object({ synced: z.boolean() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Refresh future billing snapshots from consented Marketing attribution",
  },
});
