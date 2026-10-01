import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testUsageSettlementRequestSchema = z.object({
  org_id: z.string().min(1),
});

export const testUsageSettlementResponseSchema = z.object({
  ok: z.literal(true),
});

const testUsagePackGrantSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string(),
  grant_type: z.enum(["purchased", "bonus"]),
  idempotency_key: z.string(),
  original_amount: z.number(),
  remaining_amount: z.number(),
  expires_at: z.string(),
});

export const testUsageSettlementContract = c.router({
  process: {
    method: "POST",
    path: "/api/test/usage-settlement/process",
    body: testUsageSettlementRequestSchema,
    responses: {
      200: testUsageSettlementResponseSchema,
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Process one organization's usage in API tests",
  },
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
  state: {
    method: "POST",
    path: "/api/test/usage-settlement/state",
    body: z.object({ org_id: z.string().min(1) }),
    responses: {
      200: z.object({
        org_credits: z.number(),
        grants: z.array(testUsagePackGrantSchema),
      }),
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Read usage settlement state in API tests",
  },
  admission: {
    method: "POST",
    path: "/api/test/usage-settlement/admission",
    body: z.object({
      org_id: z.string().min(1),
      user_id: z.string().min(1),
      kind: z.enum(["run", "managed-media"]),
    }),
    responses: {
      200: z.object({ allowed: z.boolean() }),
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Check member credit admission in API tests",
  },
});

export type TestUsageSettlementRequest = z.infer<
  typeof testUsageSettlementRequestSchema
>;
export type TestUsageSettlementResponse = z.infer<
  typeof testUsageSettlementResponseSchema
>;
export type TestUsageSettlementContract = typeof testUsageSettlementContract;
