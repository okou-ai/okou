import * as z from "zod";

import { initContract } from "./base";

const c = initContract();

export const emailUnsubscribeQuerySchema = z.object({
  token: z.string().optional(),
});

export const emailUnsubscribeResponseSchema = z.object({
  unsubscribed: z.literal(true),
});

export const emailUnsubscribeErrorSchema = z.object({
  error: z.string(),
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
    body: z.undefined(),
    responses: {
      200: emailUnsubscribeResponseSchema,
      400: emailUnsubscribeErrorSchema,
    },
    summary: "Unsubscribe a user from system-initiated emails",
  },
});

export type EmailUnsubscribeContract = typeof emailUnsubscribeContract;
export type EmailUnsubscribeQuery = z.infer<typeof emailUnsubscribeQuerySchema>;
export type EmailUnsubscribeResponse = z.infer<
  typeof emailUnsubscribeResponseSchema
>;
export type EmailUnsubscribeError = z.infer<typeof emailUnsubscribeErrorSchema>;
