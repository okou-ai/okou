import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Why the caller's native Morning Brief obligation was not brought forward.
 *
 * Each value is produced by exactly one refusal branch and none of them
 * performs provider work, so a caller can tell an unmigrated owner from a
 * disabled one, from a run that is still in flight, from a rate limit.
 */
export const morningBriefDebugTriggerErrorCodeSchema = z.enum([
  /** The member has no durable native row yet. */
  "MORNING_BRIEF_SCHEDULE_ABSENT",
  /** Execution ownership has not reached `native` for this member. */
  "MORNING_BRIEF_NOT_NATIVE",
  /** The member's own Morning Brief choice is off. */
  "MORNING_BRIEF_DISABLED",
  /** The live membership generation no longer matches the admitted one. */
  "MORNING_BRIEF_MEMBERSHIP_CHANGED",
  /** An admitted occurrence still owes its settlement. */
  "MORNING_BRIEF_RUN_IN_FLIGHT",
  /** The minimum interval since the most recent claim has not elapsed. */
  "MORNING_BRIEF_TRIGGER_RATE_LIMITED",
]);

export type MorningBriefDebugTriggerErrorCode = z.infer<
  typeof morningBriefDebugTriggerErrorCodeSchema
>;

export const morningBriefDebugTriggerErrorSchema = z.object({
  error: z.object({
    code: morningBriefDebugTriggerErrorCodeSchema,
    message: z.string(),
  }),
});

/**
 * The obligation this call moved, reported as queued rather than delivered.
 *
 * The endpoint never executes the pipeline. It only moves the owner's
 * `next_run_at` to `scheduledFor`, and the ordinary per-minute cron then claims
 * that instant through the same path a scheduled brief takes.
 */
export const morningBriefDebugTriggerResponseSchema = z.object({
  status: z.literal("queued"),
  scheduledFor: z.iso.datetime(),
});

export type MorningBriefDebugTriggerResponse = z.infer<
  typeof morningBriefDebugTriggerResponseSchema
>;

export const morningBriefDebugTriggerContract = c.router({
  trigger: {
    method: "POST",
    path: "/api/debug/morning-brief-trigger",
    headers: authHeadersSchema,
    body: z.object({}).strict(),
    responses: {
      200: morningBriefDebugTriggerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: morningBriefDebugTriggerErrorSchema,
      429: morningBriefDebugTriggerErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Bring the caller's native Morning Brief obligation forward",
  },
});
