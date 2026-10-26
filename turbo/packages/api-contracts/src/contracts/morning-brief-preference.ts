import {
  boolean,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MORNING_BRIEF_OFFICIAL_DEFINITION_NAME = "morning-brief";
/** Temporary AgentSuggestion rollout (#39591). Retire the test definition at GA. */
export const INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME =
  "internal-test-morning-brief";
export const MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES = [
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME,
] as const;

export function isMorningBriefDefinitionName(name: string | null): boolean {
  return MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.some((candidate) => {
    return candidate === name;
  });
}

export const MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY = "daily-delivery";
export const MORNING_BRIEF_PREFERENCES_ROUTE = "/agents";
export const MORNING_BRIEF_PREFERENCES_SECTION = "preference";
export const MORNING_BRIEF_PREFERENCES_FOCUS = "morning-brief";
export const MORNING_BRIEF_PREFERENCES_PATH = `${MORNING_BRIEF_PREFERENCES_ROUTE}?settings=${MORNING_BRIEF_PREFERENCES_SECTION}&focus=${MORNING_BRIEF_PREFERENCES_FOCUS}`;

const morningBriefUnavailableReasonSchema = zEnum([
  "missing-timezone",
  "missing-default-agent",
]);

const morningBriefPreferenceResponseSchema = object({
  status: zEnum(["preparing", "enabled", "paused", "error"]),
  enabled: boolean(),
  unavailableReason: morningBriefUnavailableReasonSchema.nullable(),
});

export type MorningBriefPreferenceResponse = zInfer<
  typeof morningBriefPreferenceResponseSchema
>;

const morningBriefPreferenceUpdateSchema = object({
  enabled: boolean(),
});

const morningBriefPreferenceErrorCodeSchema = zEnum([
  "MORNING_BRIEF_MISSING_TIMEZONE",
  "MORNING_BRIEF_MISSING_DEFAULT_AGENT",
  "MORNING_BRIEF_STATE_CONFLICT",
]);

export type MorningBriefPreferenceErrorCode = zInfer<
  typeof morningBriefPreferenceErrorCodeSchema
>;

const morningBriefPreferenceErrorSchema = object({
  error: object({
    code: morningBriefPreferenceErrorCodeSchema,
    message: string(),
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
  retry: {
    method: "POST",
    path: "/api/preferences/morning-brief/retry",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: morningBriefPreferenceResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: morningBriefPreferenceErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Reconcile an existing Morning Brief without changing its preference",
  },
});
