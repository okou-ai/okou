import { z } from "zod";

import { initContract } from "./base";

const c = initContract();
const quantitySchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const observationSchema = z
  .object({
    coverage: z.enum(["complete", "partial", "unavailable"]),
    tokens: z
      .object({
        input: quantitySchema.nullable(),
        cacheRead: quantitySchema.nullable(),
        cacheCreation: quantitySchema.nullable(),
        output: quantitySchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const testApiUsageStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("initialize"),
        runId: z.uuid(),
        phase: z.enum(["no-inference", "pending"]),
      })
      .strict(),
    z
      .object({
        action: z.literal("register"),
        runId: z.uuid(),
        attemptId: z.uuid(),
      })
      .strict(),
    z
      .object({
        action: z.literal("observe"),
        runId: z.uuid(),
        attemptId: z.uuid(),
        observation: observationSchema.nullable(),
      })
      .strict(),
  ],
);

export const testApiUsageStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/api-usage-state/action",
    body: testApiUsageStateActionBodySchema,
    responses: {
      200: z.object({ ok: z.literal(true) }).strict(),
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Mutate API usage projection state for API tests",
  },
});

export type TestApiUsageStateActionBody = z.infer<
  typeof testApiUsageStateActionBodySchema
>;
