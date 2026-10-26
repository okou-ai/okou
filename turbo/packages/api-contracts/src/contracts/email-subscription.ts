import {
  boolean,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const emailSubscriptionUpdateSchema = object({ subscribed: boolean() });

export const emailSubscriptionResponseSchema = object({
  subscribed: boolean(),
  email: string().nullable(),
  deliveryStatus: zEnum(["available", "suppressed", "no-email"]),
});

export type EmailSubscriptionResponse = zInfer<
  typeof emailSubscriptionResponseSchema
>;

export const emailSubscriptionContract = c.router({
  get: {
    method: "GET",
    path: "/api/preferences/email-subscription",
    headers: authHeadersSchema,
    responses: {
      200: emailSubscriptionResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get the signed-in user's email subscription across workspaces",
  },
  update: {
    method: "PUT",
    path: "/api/preferences/email-subscription",
    headers: authHeadersSchema,
    body: emailSubscriptionUpdateSchema,
    responses: {
      200: emailSubscriptionUpdateSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update the signed-in user's email subscription across workspaces",
  },
});
