import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testUsageSettlementResponseSchema = z.object({
  ok: z.literal(true),
});

export const testUsageSettlementContract = c.router({
  setup: {
    method: "POST",
    path: "/api/test/usage-settlement/setup",
    body: z.object({
      org_id: z.string().min(1),
      credits: z.number().int(),
    }),
    responses: {
      200: testUsageSettlementResponseSchema,
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Set up usage settlement state in API tests",
  },
  cleanup: {
    method: "POST",
    path: "/api/test/usage-settlement/cleanup",
    body: z.object({ org_id: z.string().min(1) }),
    responses: {
      200: testUsageSettlementResponseSchema,
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Clean up usage settlement state in API tests",
  },
  createGrant: {
    method: "POST",
    path: "/api/test/usage-settlement/grants",
    body: z.object({
      org_id: z.string().min(1),
      user_id: z.string().min(1),
      grant_type: z.enum(["purchased", "bonus"]),
      idempotency_key: z.string().min(1),
      amount: z.number().int().positive(),
      expires_at: z.string().datetime(),
    }),
    responses: {
      200: z.object({
        grant_id: z.string().uuid(),
        created: z.boolean(),
      }),
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Create a member usage pack credit grant in API tests",
  },
});

export type TestUsageSettlementResponse = z.infer<
  typeof testUsageSettlementResponseSchema
>;
export type TestUsageSettlementContract = typeof testUsageSettlementContract;
