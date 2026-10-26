import { object, string, type infer as zInfer } from "zod";

import { initContract } from "./trpc-contract";

const c = initContract();

export const buildCommitShaSchema = string()
  .regex(/^[0-9a-f]{40}$/u)
  .nullable();

export const buildVersionSchema = string().min(1).nullable().optional();

export const buildInfoResponseSchema = object({
  commitSha: buildCommitShaSchema,
  version: buildVersionSchema,
});

export const buildInfoContract = c.router({
  get: {
    method: "GET",
    path: "/api/build-info",
    responses: {
      200: buildInfoResponseSchema,
    },
    summary: "Get API build information",
  },
});

export type BuildInfoContract = typeof buildInfoContract;
export type BuildInfoResponse = zInfer<typeof buildInfoResponseSchema>;
export type BuildInfoRouteResponse = {
  readonly status: 200;
  readonly body: BuildInfoResponse;
};
