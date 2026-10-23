import * as z from "zod";
import { initContract } from "./base";

const c = initContract();

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
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

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type HealthRouteResponse = {
  readonly status: 200;
  readonly body: HealthResponse;
};
