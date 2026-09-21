import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

/** How many task cards the home page ever shows at once. */
export const HOME_TASK_RECOMMENDATION_LIMIT = 3;

/**
 * How long one generated set stays authoritative.
 *
 * The client polls on this cadence and the server refuses to regenerate before
 * it elapses, so the refresh rate is one number both sides read rather than two
 * timers that can disagree.
 */
export const HOME_TASK_RECOMMENDATION_REFRESH_MS = 15 * 60 * 1000;

/**
 * The lowest actionability the ranking model may report for a candidate that is
 * still allowed to become a card. Below it the evidence describes something the
 * user has not shown they want done, and an empty home page is the honest
 * answer.
 */
export const HOME_TASK_RECOMMENDATION_MIN_ACTIONABILITY = 55;

export const homeTaskRecommendationSchema = z.object({
  /** Stable within one generated set; the click target, never a task id. */
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  /** Sent verbatim as the first message of the thread the click creates. */
  prompt: z.string().min(1).max(1000),
  rationale: z.string().max(200),
  /** The ranking model's 0-100 judgement of how ready this task is to run. */
  actionability: z.number().int().min(0).max(100),
  /** Connector slugs the task expects to use; display only. */
  connectors: z.array(z.string().min(1).max(64)).max(4),
});
export type HomeTaskRecommendation = z.infer<
  typeof homeTaskRecommendationSchema
>;

export const homeTaskRecommendationsResponseSchema = z.object({
  /**
   * `unavailable` means no set could be produced for this request — the switch
   * is off for the caller, the provider is not configured, or the evidence did
   * not support a single card. It is never an error the user has to act on.
   */
  status: z.enum(["available", "unavailable"]),
  generatedAt: z.string().datetime().nullable(),
  /** Milliseconds until the next generation may be attempted. */
  refreshAfterMs: z.number().int().nonnegative(),
  recommendations: z
    .array(homeTaskRecommendationSchema)
    .max(HOME_TASK_RECOMMENDATION_LIMIT),
});
export type HomeTaskRecommendationsResponse = z.infer<
  typeof homeTaskRecommendationsResponseSchema
>;

const c = initContract();
export const homeTaskRecommendationsContract = c.router({
  list: {
    method: "GET",
    path: "/api/home-task-recommendations",
    headers: authHeadersSchema,
    responses: {
      200: homeTaskRecommendationsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read personalized home page task recommendations",
  },
});
