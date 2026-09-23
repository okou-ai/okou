import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/** A session can mint a narrow status credential before Clerk invalidates it. */
export const accountErasureStatusContract = c.router({
  capability: {
    method: "POST",
    path: "/api/account-erasure/status-capability",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ token: z.string(), expiresAt: z.string() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create an owner-bound account deletion status capability",
  },
  status: {
    method: "GET",
    path: "/api/account-erasure/status",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ status: z.enum(["active", "pending", "complete"]) }),
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read deletion status using an owner-bound capability",
  },
});
