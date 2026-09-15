import { z } from "zod";

import { initContract } from "./base";
import { cronCompactUsageEventsContract } from "./cron";

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
    action: z.literal("seed-chat-thread"),
    user_id: z.string(),
    compose_id: z.string(),
    title: z.string().optional(),
  }),
  z.object({
    action: z.literal("insert-model-usage-event-for-run"),
    org_id: z.string(),
    user_id: z.string(),
    run_id: z.string(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    credits_charged: z.number().optional(),
    status: z.string().optional(),
    processed_at: nullableDateStringSchema.optional(),
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
    action: z.literal("attach-usage-allowance"),
    org_id: z.string(),
    run_id: z.string().nullable(),
    usage_event_id: z.string(),
    units_applied: z.number().int().positive(),
    consumed_units: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("read-allowance-window-state"),
    short_window_id: z.string(),
    weekly_window_id: z.string(),
  }),
  z.object({
    action: z.literal("read-usage-event-state"),
    idempotency_key: z.string(),
  }),
  z.object({
    action: z.literal("delete-run"),
    run_id: z.string(),
  }),
  z.object({
    action: z.literal("seed-usage-overflow-grain"),
    org_id: z.string(),
    user_id: z.string(),
    processed_at: z.string(),
  }),
  z.object({
    action: z.literal("set-usage-event-created-at"),
    id: z.string(),
    created_at: z.string(),
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
  chat_thread_id: z.string().optional(),
  usage_event_id: z.string().optional(),
  usage_event_status: z.string().optional(),
  usage_event_credits_charged: z.number().nullable().optional(),
  usage_event_billing_error: z.string().nullable().optional(),
  raw_count: z.number().optional(),
  processed_raw_count: z.number().optional(),
  hourly_count: z.number().optional(),
  short_window_id: z.string().optional(),
  weekly_window_id: z.string().optional(),
  short_window_consumed_units: z.string().optional(),
  weekly_window_consumed_units: z.string().optional(),
  raw_allowance_units: z.string().optional(),
  hourly_allowance_units: z.string().optional(),
  allocation_count: z.number().optional(),
});

export const testUsageStateContract = c.router({
  compact: {
    method: "POST",
    path: "/api/test/usage-state/compact",
    body: z.object({ orgId: z.string().min(1) }),
    responses: {
      ...cronCompactUsageEventsContract.compact.responses,
      404: z.string(),
    },
    summary: "Compact usage for one explicitly owned test organization",
  },
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
