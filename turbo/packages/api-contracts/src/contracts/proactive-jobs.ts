import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { proactivePreferenceSchema } from "./proactive";

export const PROACTIVE_JOBS_DEFINITION_NAME = "proactive-jobs";
export const PROACTIVE_JOBS_BLUEPRINT_KEY = "jobs-loop";
export const PROACTIVE_JOBS_INTERVAL_SECONDS = 300;
const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
};
export const proactiveJobsContract = c.router({
  get: {
    method: "GET",
    path: "/api/preferences/proactive-jobs",
    headers: authHeadersSchema,
    responses: { 200: proactivePreferenceSchema, ...errors },
    summary: "Read your Planning and action preference",
  },
  update: {
    method: "PUT",
    path: "/api/preferences/proactive-jobs",
    headers: authHeadersSchema,
    body: z.object({ enabled: z.boolean() }),
    responses: { 200: proactivePreferenceSchema, ...errors },
    summary:
      "Enable planning and execution within your explicitly delegated scope",
  },
});
