import { boolean, object } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { proactivePreferenceSchema } from "./proactive";

export const PROACTIVE_LEARNING_DEFINITION_NAME = "proactive-learning";
export const PROACTIVE_PLANNING_DEFINITION_NAME = "proactive-planning";
export const PROACTIVE_LEARNING_BLUEPRINT_KEY = "nightly-learning";
export const PROACTIVE_PLANNING_BLUEPRINT_KEY = "nightly-planning";

const c = initContract();
const responses = {
  200: proactivePreferenceSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
};
const body = object({ enabled: boolean() });

export const proactiveLearningContract = c.router({
  get: {
    method: "GET",
    path: "/api/preferences/proactive-learning",
    headers: authHeadersSchema,
    responses,
    summary: "Read your Proactive Learning preference",
  },
  update: {
    method: "PUT",
    path: "/api/preferences/proactive-learning",
    headers: authHeadersSchema,
    body,
    responses,
    summary: "Enable nightly review and consolidation of your personal memory",
  },
});
