import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Auth contract for /api/auth/me
 */
export const authContract = c.router({
  /**
   * GET /api/auth/me
   * Get current user information
   */
  me: {
    method: "GET",
    path: "/api/auth/me",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        userId: z.string(),
        email: z.string().nullable(),
        // Phone-only accounts have no email. Older APIs omit this field.
        phoneNumber: z.string().min(1).optional(),
        orgId: z.string().nullable(),
        // Older API deployments omit this. Only Clerk session auth supplies it.
        sessionId: z.string().optional(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get current user information",
  },
});

export type AuthContract = typeof authContract;
