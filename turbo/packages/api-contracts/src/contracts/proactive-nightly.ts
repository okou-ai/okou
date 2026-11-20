import { boolean, object } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { proactivePreferenceSchema } from "./proactive";

export {
  PROACTIVE_LEARNING_DEFINITION_NAME,
  PROACTIVE_LEARNING_BLUEPRINT_KEY,
} from "./proactive";

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
    summary:
      "Read the Suggestions preference for daily profile updates (legacy Learning alias)",
  },
  update: {
    method: "PUT",
    path: "/api/preferences/proactive-learning",
    headers: authHeadersSchema,
    body,
    responses,
    summary:
      "Set the Suggestions preference for both proactive jobs (legacy Learning alias)",
  },
});
