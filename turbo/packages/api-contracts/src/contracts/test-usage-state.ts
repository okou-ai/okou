import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const nullableDateStringSchema = z.string().nullable();
const optionalDateStringSchema = z.string().optional();

const testUsageStateErrorSchema = z.object({
  error: z.string(),
});

export const testUsageStateFixtureSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
});

const usageStateFixtureInputSchema = testUsageStateFixtureSchema;

export const testUsageStateActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed-fixture"),
  }),
  z.object({
    action: z.literal("delete-fixture"),
    fixture: usageStateFixtureInputSchema,
  }),
  z.object({
    action: z.literal("seed-compose"),
    org_id: z.string(),
    user_id: z.string(),
    name: z.string().optional(),
    display_name: z.string().nullable().optional(),
    visibility: z.enum(["public", "private"]).optional(),
  }),
  z.object({
    action: z.literal("seed-run"),
    org_id: z.string(),
    user_id: z.string(),
    compose_id: z.string(),
    trigger_source: z.string().optional(),
    chat_thread_id: z.string().optional(),
    status: z.string().optional(),
    prompt: z.string().optional(),
    created_at: optionalDateStringSchema,
    started_at: nullableDateStringSchema.optional(),
    completed_at: nullableDateStringSchema.optional(),
    continued_from_session_id: z.string().nullable().optional(),
    sandbox_reuse_result: z.string().nullable().optional(),
    workspace_reuse_result: z.string().nullable().optional(),
    result: z.record(z.string(), z.unknown()).nullable().optional(),
    error: z.string().nullable().optional(),
    last_event_sequence: z.number().nullable().optional(),
    selected_model: z.string().nullable().optional(),
    lifecycle_only: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("insert-usage-event"),
    org_id: z.string(),
    user_id: z.string().optional(),
    run_id: z.string().nullable().optional(),
    kind: z.string().optional(),
    provider: z.string().optional(),
    category: z.string().optional(),
    quantity: z.number().optional(),
    status: z.string().optional(),
    credits_charged: z.number().optional(),
    idempotency_key: z.string().optional(),
    billing_error: z.string().nullable().optional(),
    created_at: optionalDateStringSchema,
    processed_at: nullableDateStringSchema.optional(),
    count: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal("materialize-hourly-usage"),
    org_id: z.string(),
    user_id: z.string(),
    run_id: z.string().nullable(),
  }),
  z.object({
    action: z.literal("read-usage-storage-counts"),
    scope: z.enum(["organization", "user"]),
    id: z.string(),
  }),
  z.object({
    action: z.literal("delete-usage-data"),
    scope: z.enum(["organization", "user"]),
    id: z.string(),
  }),
]);

export const testUsageStateActionResponseSchema = z.object({
  ok: z.literal(true),
  fixture: testUsageStateFixtureSchema.optional(),
  compose_id: z.string().optional(),
  agent_id: z.string().optional(),
  run_id: z.string().optional(),
  usage_event_id: z.string().optional(),
  raw_count: z.number().optional(),
  processed_raw_count: z.number().optional(),
  hourly_count: z.number().optional(),
});

export const testUsageStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/usage-state/action",
    body: testUsageStateActionBodySchema,
    responses: {
      200: testUsageStateActionResponseSchema,
      400: testUsageStateErrorSchema,
      404: z.string(),
    },
    summary: "Manage usage API test support state",
  },
});

export type TestUsageStateContract = typeof testUsageStateContract;
export type TestUsageStateFixture = z.infer<typeof testUsageStateFixtureSchema>;
export type TestUsageStateActionBody = z.infer<
  typeof testUsageStateActionBodySchema
>;
export type TestUsageStateActionResponse = z.infer<
  typeof testUsageStateActionResponseSchema
>;
