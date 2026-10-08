import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const projectionScopeSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  memory_storage_id: z.string().uuid(),
  storage_version_id: z.string().min(1),
});

const projectionStateSchema = z.object({
  status: z.enum([
    "pending",
    "running",
    "ready",
    "missing",
    "invalid",
    "over_limit",
  ]),
  attempt_count: z.number().int().nonnegative(),
  available_at: z.string(),
  lease_id: z.string().uuid().nullable(),
  lease_expires_at: z.string().nullable(),
  last_error_class: z.string().nullable(),
  has_content: z.boolean(),
  source_hash: z.string().nullable(),
  source_size: z.number().int().nonnegative().nullable(),
  token_count: z.number().int().nonnegative().nullable(),
});

const readyProjectionSchema = z.object({
  content: z.string(),
  source_hash: z.string(),
  source_size: z.number().int().nonnegative(),
  token_count: z.number().int().nonnegative(),
});

const workerResultSchema = z.object({
  backfilled: z.number().int().nonnegative(),
  claimed: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  no_content: z.number().int().nonnegative(),
  retried: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
});

export const testMemorySummaryProjectionStateActionBodySchema =
  z.discriminatedUnion("action", [
    projectionScopeSchema.extend({ action: z.literal("inspect") }),
    projectionScopeSchema.extend({ action: z.literal("delete") }),
    projectionScopeSchema.extend({ action: z.literal("make-due") }),
    projectionScopeSchema.extend({
      action: z.literal("seed-ready"),
      content: z.string(),
    }),
    projectionScopeSchema.extend({
      action: z.literal("run"),
      current_time: z.iso.datetime().optional(),
    }),
    projectionScopeSchema.extend({ action: z.literal("read") }),
  ]);

export const testMemorySummaryProjectionStateActionResponseSchema = z.object({
  ok: z.literal(true),
  state: projectionStateSchema.nullable().optional(),
  projection: readyProjectionSchema.nullable().optional(),
  worker: workerResultSchema.optional(),
});

export const testMemorySummaryProjectionStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/memory-summary-projection-state/action",
    body: testMemorySummaryProjectionStateActionBodySchema,
    responses: {
      200: testMemorySummaryProjectionStateActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary:
      "Mutate and read owner-scoped memory summary projection test state",
  },
});

export type TestMemorySummaryProjectionStateContract =
  typeof testMemorySummaryProjectionStateContract;
export type TestMemorySummaryProjectionStateActionBody = z.infer<
  typeof testMemorySummaryProjectionStateActionBodySchema
>;
export type TestMemorySummaryProjectionStateActionResponse = z.infer<
  typeof testMemorySummaryProjectionStateActionResponseSchema
>;
