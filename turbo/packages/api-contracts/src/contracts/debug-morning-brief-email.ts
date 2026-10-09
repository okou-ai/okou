import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const requestIdSchema = z.uuid().transform((value) => {
  return value.toLowerCase();
});
export const debugMorningBriefEmailResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      requestId: z.uuid(),
      status: z.literal("queued"),
      reason: z.null(),
    }),
    z.object({
      requestId: z.uuid(),
      status: z.literal("sent"),
      reason: z.null(),
    }),
    z.object({
      requestId: z.uuid(),
      status: z.literal("skipped"),
      reason: z.enum(["unsubscribed", "suppressed", "no-email"]),
    }),
    z.object({
      requestId: z.uuid(),
      status: z.literal("failed"),
      reason: z.enum(["expired", "delivery-failed"]),
    }),
  ],
);
const response = debugMorningBriefEmailResponseSchema;
export type DebugMorningBriefEmailResponse = z.output<typeof response>;

export const debugMorningBriefEmailContract = c.router({
  send: {
    method: "POST",
    path: "/api/debug/morning-brief-email",
    headers: authHeadersSchema,
    body: z.object({ requestId: requestIdSchema }).strict(),
    responses: {
      200: response,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Send a fixed Morning Brief sample to the signed-in user's email",
  },
  get: {
    method: "GET",
    path: "/api/debug/morning-brief-email/:id",
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
    summary: "Read an owned Morning Brief test email's delivery status",
  },
});
