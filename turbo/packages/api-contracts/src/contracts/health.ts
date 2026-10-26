import { literal, object, type infer as zInfer } from "zod";

import { initContract } from "./trpc-contract";

const c = initContract();

export const healthResponseSchema = object({
  status: literal("ok"),
});

export const healthContract = c.router({
  check: {
    method: "GET",
    path: "/health",
    responses: {
      200: healthResponseSchema,
    },
    summary: "Check API health",
  },
});

export type HealthResponse = zInfer<typeof healthResponseSchema>;
export type HealthRouteResponse = {
  readonly status: 200;
  readonly body: HealthResponse;
};
