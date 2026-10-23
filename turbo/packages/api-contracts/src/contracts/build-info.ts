import * as z from "zod";
import { initContract } from "./base";

const c = initContract();

export const buildCommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/u)
  .nullable();

export const buildVersionSchema = z.string().min(1).nullable().optional();

export const buildInfoResponseSchema = z.object({
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
export type BuildInfoResponse = z.infer<typeof buildInfoResponseSchema>;
export type BuildInfoRouteResponse = {
  readonly status: 200;
  readonly body: BuildInfoResponse;
};
