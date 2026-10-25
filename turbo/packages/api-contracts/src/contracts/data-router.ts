import { initContract } from "./base";
import * as z from "zod";
import { apiErrorSchema } from "./errors";

const c = initContract();

/** MITM registers trusted Run attribution before forwarding a Router tool call. */
export const dataRouterRequestContract = c.router({
  register: {
    method: "POST",
    path: "/api/webhooks/agent/data-request",
    headers: z.object({ authorization: z.string().optional() }),
    body: z.object({ runId: z.uuid(), requestId: z.uuid() }).strict(),
    responses: {
      200: z.object({ success: z.literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Register a Data Router request for the current Run",
  },
});

/** User-scoped history IDs; Router itself never receives an Okou user identity. */
export const dataRouterHistoryContract = c.router({
  list: {
    method: "GET",
    path: "/api/data/router/requests",
    headers: z.object({ authorization: z.string().optional() }),
    responses: {
      200: z.object({ requestIds: z.array(z.uuid()) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List recent Data Router request IDs owned by the current user",
  },
});
