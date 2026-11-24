import { boolean, literal, number, object, string } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

/** A PostHog destination forwards completed responses without their answers. */
export const posthogSurveysContract = initContract().router({
  reward: {
    method: "POST",
    path: "/api/webhooks/posthog/surveys",
    headers: authHeadersSchema,
    body: object({
      event: literal("survey sent"),
      distinct_id: string().min(1),
      properties: object({
        $survey_id: string().min(1),
        $survey_completed: boolean(),
        org_id: string().min(1),
        billing_feedback_reward_token: string().optional(),
      }),
    }),
    responses: {
      200: object({ rewardCredits: number().int().nonnegative() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Settle a verified PostHog credits-exhaustion survey reward",
  },
});
