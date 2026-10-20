import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const credential = z.string().min(1).max(65_536);
export const atomSubscriptionGrantSchema = z.object({
  grantId: z.uuid(),
  orgId: z.string().min(1).max(255),
  userId: z.string().min(1).max(255),
  tokens: z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("claude-code"), accessToken: credential }),
    z.object({
      provider: z.literal("codex"),
      accessToken: credential,
      refreshToken: credential,
      idToken: credential,
    }),
  ]),
});

export const atomSubscriptionGrantsContract = initContract().router({
  cancel: {
    method: "POST",
    path: "/api/internal/atom/subscription-grants/:grantId/cancel",
    headers: authHeadersSchema,
    pathParams: z.object({ grantId: z.uuid() }),
    body: z.object({
      orgId: z.string().min(1).max(255),
      userId: z.string().min(1).max(255),
      provider: z.enum(["claude-code", "codex"]),
    }),
    responses: {
      200: z.object({ grantId: z.uuid(), status: z.literal("cancelled") }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Cancel an Atom grant and disconnect its personal subscription account",
  },
  deliver: {
    method: "POST",
    path: "/api/internal/atom/subscription-grants",
    headers: authHeadersSchema,
    body: atomSubscriptionGrantSchema,
    responses: {
      200: z.object({ grantId: z.uuid(), status: z.literal("delivered") }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Deliver an Atom-authorized personal subscription to an existing member",
  },
});
