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

export const morningBriefPreferenceResponseSchema = z.object({
  status: z.enum(["preparing", "enabled", "paused", "error"]),
  enabled: z.boolean(),
  nextRunAt: z.string().datetime().nullable(),
  timezone: z.string().nullable(),
  unavailableReason: morningBriefUnavailableReasonSchema.nullable(),
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
  // The enrollment now owns one installation, so the current API resolves
  // per-Agent installs instead of rejecting them. Clients keep handling this
  // code while an older API version can still serve them.
  "MORNING_BRIEF_MULTIPLE_INSTALLATIONS",
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
