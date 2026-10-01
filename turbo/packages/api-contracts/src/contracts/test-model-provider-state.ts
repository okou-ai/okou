import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testModelProviderStateErrorSchema = z.object({
  error: z.string(),
});

export const testModelProviderStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("overwrite-secret"),
      provider_id: z.string(),
      secret_name: z.string(),
      secret: z.string(),
    }),
  ],
);

export const testModelProviderStateActionResponseSchema = z.object({
  ok: z.literal(true),
});

export const testModelProviderStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/model-provider-state/action",
    body: testModelProviderStateActionBodySchema,
    responses: {
      200: testModelProviderStateActionResponseSchema,
      400: testModelProviderStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate model provider API test support state",
  },
});

export type TestModelProviderStateContract =
  typeof testModelProviderStateContract;
export type TestModelProviderStateActionBody = z.infer<
  typeof testModelProviderStateActionBodySchema
>;
export type TestModelProviderStateActionResponse = z.infer<
  typeof testModelProviderStateActionResponseSchema
>;
