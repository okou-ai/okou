import { boolean, object, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { proactivePreferenceSchema } from "./proactive";

export const PROACTIVE_SUGGESTIONS_DEFINITION_NAME = "agent-suggestions";
export const PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY = "hourly-check";

const preferenceSchema = proactivePreferenceSchema;
export type ProactiveSuggestionsPreference = zInfer<typeof preferenceSchema>;

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
};
export const proactiveSuggestionsContract = c.router({
  get: {
    method: "GET",
    path: "/api/preferences/proactive-suggestions",
    headers: authHeadersSchema,
    responses: { 200: preferenceSchema, ...errors },
    summary: "Get your Proactive Suggestions preference",
  },
  update: {
    method: "PUT",
    path: "/api/preferences/proactive-suggestions",
    headers: authHeadersSchema,
    body: object({ enabled: boolean() }),
    responses: { 200: preferenceSchema, ...errors },
    summary: "Update your Proactive Suggestions preference",
  },
});
