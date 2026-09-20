import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MORNING_BRIEF_OFFICIAL_DEFINITION_NAME = "morning-brief";
export const MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY = "daily-delivery";
export const MORNING_BRIEF_PREFERENCES_ROUTE = "/agents";
export const MORNING_BRIEF_PREFERENCES_SECTION = "preference";
export const MORNING_BRIEF_PREFERENCES_FOCUS = "morning-brief";
export const MORNING_BRIEF_PREFERENCES_PATH = `${MORNING_BRIEF_PREFERENCES_ROUTE}?settings=${MORNING_BRIEF_PREFERENCES_SECTION}&focus=${MORNING_BRIEF_PREFERENCES_FOCUS}`;

export const morningBriefUnavailableReasonSchema = z.enum([
  "missing-timezone",
  "missing-default-agent",
]);

/**
 * What one source contributed to the caller's most recent brief.
 *
 * Counts and labels only. No subject, sender, channel name, thread title,
 * container id or any other evidence appears here.
 */
export const morningBriefRunSourceSchema = z.object({
  source: z.string(),
  coverage: z.string(),
  items: z.number().int(),
  includedInRequest: z.number().int(),
  droppedBySource: z.number().int(),
  droppedByNormalizedCap: z.number().int(),
  droppedByRequest: z.number().int(),
});

export type MorningBriefRunSource = z.infer<typeof morningBriefRunSourceSchema>;

/**
 * The caller's most recent Morning Brief occurrence, as an account.
 *
 * A brief that delivered nothing and a brief that decided there was nothing to
 * say settle through different branches and used to look identical from
 * outside, which is why a real production incident needed a distributed trace
 * to diagnose. `outcome` says how the slot ended, `reason` says which branch
 * produced it, and `sources` says what it actually had to work with.
 */
export const morningBriefLastRunSchema = z.object({
  scheduledFor: z.string().datetime(),
  settledAt: z.string().datetime().nullable(),
  state: z.enum(["claimed", "deferred", "settled"]),
  outcome: z.string().nullable(),
  /** The composition branch and its exact refusal, when there was one. */
  reason: z.string().nullable(),
  /** Null for a slot that settled before this account was recorded. */
  sources: z.array(morningBriefRunSourceSchema).nullable(),
});

export type MorningBriefLastRun = z.infer<typeof morningBriefLastRunSchema>;

export const morningBriefPreferenceResponseSchema = z.object({
  status: z.enum(["preparing", "enabled", "paused", "error"]),
  enabled: z.boolean(),
  nextRunAt: z.string().datetime().nullable(),
  timezone: z.string().nullable(),
  unavailableReason: morningBriefUnavailableReasonSchema.nullable(),
  /**
   * The caller's most recent native occurrence, or null before the first one.
   *
   * Optional so an older API binary's response still validates during a
   * rollout; a client that does not know the field ignores it.
   */
  lastRun: morningBriefLastRunSchema.nullable().optional(),
});

export type MorningBriefPreferenceResponse = z.infer<
  typeof morningBriefPreferenceResponseSchema
>;

export const morningBriefPreferenceUpdateSchema = z.object({
  enabled: z.boolean(),
});

export type MorningBriefPreferenceUpdate = z.infer<
  typeof morningBriefPreferenceUpdateSchema
>;

export const morningBriefPreferenceErrorCodeSchema = z.enum([
  "MORNING_BRIEF_MISSING_TIMEZONE",
  "MORNING_BRIEF_MISSING_DEFAULT_AGENT",
  "MORNING_BRIEF_STATE_CONFLICT",
]);

export type MorningBriefPreferenceErrorCode = z.infer<
  typeof morningBriefPreferenceErrorCodeSchema
>;

export const morningBriefPreferenceErrorSchema = z.object({
  error: z.object({
    code: morningBriefPreferenceErrorCodeSchema,
    message: z.string(),
  }),
});

export const morningBriefPreferenceContract = c.router({
  get: {
    method: "GET",
    path: "/api/preferences/morning-brief",
    headers: authHeadersSchema,
    responses: {
      200: morningBriefPreferenceResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: morningBriefPreferenceErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get the Morning Brief preference",
  },
  update: {
    method: "PUT",
    path: "/api/preferences/morning-brief",
    headers: authHeadersSchema,
    body: morningBriefPreferenceUpdateSchema,
    responses: {
      200: morningBriefPreferenceResponseSchema,
      400: morningBriefPreferenceErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: morningBriefPreferenceErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update the Morning Brief preference",
  },
});

export type MorningBriefPreferenceContract =
  typeof morningBriefPreferenceContract;
