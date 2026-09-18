import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";
import { VNC_HOST_MAX_LENGTH, vncSecuritySchema } from "./vnc-connections";
import { vncAuthenticationSchema } from "./vnc-credentials";

const c = initContract();

const generationSchema = z.int().positive().max(2_147_483_647);

const commonRequestSchema = z
  .object({
    connectionId: z.uuid(),
    runnerIdentity: z
      .object({
        runnerId: z.uuid(),
        heartbeatGeneration: runnerHeartbeatGenerationSchema,
      })
      .strict(),
  })
  .strict();

const resolveRequestSchema = commonRequestSchema.extend({
  supportedProfiles: z
    .array(
      z
        .object({
          authMethod: z.literal("vnc_password"),
          securityType: z.literal("x509_vnc"),
        })
        .strict(),
    )
    .max(16),
});
const unavailableSchema = z
  .object({ outcome: z.literal("unavailable") })
  .strict();
const configurationChangedSchema = z
  .object({ outcome: z.literal("configuration_changed") })
  .strict();

const resolveResponseSchema = z.discriminatedUnion("outcome", [
  unavailableSchema,
  z.object({ outcome: z.literal("unsupported_profile") }).strict(),
  z
    .object({
      outcome: z.literal("resolved"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      authentication: vncAuthenticationSchema,
      security: vncSecuritySchema,
    })
    .strict(),
]);

const checkRequestSchema = commonRequestSchema.extend({
  expectedGeneration: generationSchema,
});
const checkResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("valid") }).strict(),
  unavailableSchema,
  configurationChangedSchema,
]);

const pathParams = z.object({ runId: z.uuid() }).strict();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  500: apiErrorSchema,
};

export const runnerVncContract = c.router({
  resolve: {
    method: "POST",
    path: "/api/runners/runs/:runId/vnc/resolve",
    pathParams,
    headers: authHeadersSchema,
    body: resolveRequestSchema,
    responses: { 200: resolveResponseSchema, ...errors },
    summary:
      "Resolve supported VNC credentials for the winning official Runner",
  },
  check: {
    method: "POST",
    path: "/api/runners/runs/:runId/vnc/check",
    pathParams,
    headers: authHeadersSchema,
    body: checkRequestSchema,
    responses: { 200: checkResponseSchema, ...errors },
    summary: "Check current VNC authorization and configuration",
  },
});

export type RunnerVncResolveRequest = z.infer<typeof resolveRequestSchema>;
export type RunnerVncResolveResponse = z.infer<typeof resolveResponseSchema>;
export type RunnerVncCheckRequest = z.infer<typeof checkRequestSchema>;
export type RunnerVncCheckResponse = z.infer<typeof checkResponseSchema>;
