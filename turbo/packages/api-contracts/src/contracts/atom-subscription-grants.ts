import {
  discriminatedUnion,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
} from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const credential = string().min(1).max(65_536);
export const atomSubscriptionGrantSchema = object({
  grantId: uuid(),
  orgId: string().min(1).max(255),
  userId: string().min(1).max(255),
  tokens: discriminatedUnion("provider", [
    object({ provider: literal("claude-code"), accessToken: credential }),
    object({
      provider: literal("codex"),
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
    pathParams: object({ grantId: uuid() }),
    body: object({
      orgId: string().min(1).max(255),
      userId: string().min(1).max(255),
      provider: zEnum(["claude-code", "codex"]),
    }),
    responses: {
      200: object({ grantId: uuid(), status: literal("cancelled") }),
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
      200: object({ grantId: uuid(), status: literal("delivered") }),
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
