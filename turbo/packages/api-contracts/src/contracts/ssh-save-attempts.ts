import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
export const sshSaveAttemptsContract = c.router({
  resolve: {
    method: "POST",
    path: "/api/ssh/save-attempts/:attemptId/resolve",
    headers: authHeadersSchema,
    pathParams: z.object({ attemptId: z.uuid() }).strict(),
    body: z.object({}).strict(),
    responses: {
      200: z.object({ saved: z.boolean() }).strict(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Confirm a saved SSH attempt or prevent its delayed execution",
  },
});
