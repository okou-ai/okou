import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const requestIdSchema = z.uuid().transform((value) => {
  return value.toLowerCase();
});
const response = z.object({
  requestId: z.uuid(),
  chatThreadId: z.uuid(),
  runId: z.uuid().nullable(),
  status: z.enum(["queued", "running", "completed", "failed"]),
});
export type DebugMorningBriefResponse = z.output<typeof response>;

export const debugMorningBriefContract = c.router({
  run: {
    method: "POST",
    path: "/api/debug/morning-brief",
    headers: authHeadersSchema,
    body: z.object({ requestId: requestIdSchema }).strict(),
    responses: {
      200: response,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Run the member's Morning Brief once without changing its schedule",
  },
  get: {
    method: "GET",
    path: "/api/debug/morning-brief/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: requestIdSchema }),
    responses: {
      200: response,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read an owned one-off Morning Brief's execution status",
  },
});
