import { array, object } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  suggestionLearningInputSchema,
  suggestionMemorySchema,
} from "./suggestion-memory";

const c = initContract();
export const suggestionLearningContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/suggestions/learning",
    headers: authHeadersSchema,
    body: object({}),
    responses: {
      200: object({
        memory: suggestionMemorySchema,
        pending: array(suggestionLearningInputSchema).max(100),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Read published suggestion memory, acknowledge its feedback, and prepare the next learning batch",
  },
});
