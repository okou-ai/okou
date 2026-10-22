import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { proactivePreferenceSchema } from "./proactive";

export const PROACTIVE_ACTION_DEFINITION_NAME = "proactive-action";
export const PROACTIVE_ACTION_BLUEPRINT_KEY = "hourly-check";
export type ProactiveActionPreference = z.infer<
  typeof proactivePreferenceSchema
>;

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
};

export const proactiveActionContract = c.router({
  get: {
    method: "GET",
    path: "/api/preferences/proactive-action",
    headers: authHeadersSchema,
    responses: { 200: proactivePreferenceSchema, ...errors },
    summary: "Get your Proactive Action preference",
  },
  update: {
    method: "PUT",
    path: "/api/preferences/proactive-action",
    headers: authHeadersSchema,
    body: z.object({ enabled: z.boolean() }),
    responses: { 200: proactivePreferenceSchema, ...errors },
    summary: "Update your Proactive Action preference",
  },
});
