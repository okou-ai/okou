import {
  literal,
  object,
  string,
  undefined as zUndefined,
  type infer as zInfer,
} from "zod";

import { initContract } from "./base";

const c = initContract();

export const emailUnsubscribeQuerySchema = object({
  token: string().optional(),
});

export const emailUnsubscribeResponseSchema = object({
  unsubscribed: literal(true),
});

export const emailUnsubscribeErrorSchema = object({
  error: string(),
});

export const emailUnsubscribeContract = c.router({
  get: {
    method: "GET",
    path: "/api/email/unsubscribe",
    query: emailUnsubscribeQuerySchema,
    responses: {
      302: c.noBody(),
      400: emailUnsubscribeErrorSchema,
    },
    summary: "Redirect to the app unsubscribe page",
  },
  unsubscribe: {
    method: "POST",
    path: "/api/email/unsubscribe",
    query: emailUnsubscribeQuerySchema,
    body: zUndefined(),
    responses: {
      200: emailUnsubscribeResponseSchema,
      400: emailUnsubscribeErrorSchema,
    },
    summary: "Unsubscribe a user from system-initiated emails",
  },
});

export type EmailUnsubscribeContract = typeof emailUnsubscribeContract;
export type EmailUnsubscribeQuery = zInfer<typeof emailUnsubscribeQuerySchema>;
export type EmailUnsubscribeResponse = zInfer<
  typeof emailUnsubscribeResponseSchema
>;
export type EmailUnsubscribeError = zInfer<typeof emailUnsubscribeErrorSchema>;
