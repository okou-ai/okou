import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";
import { VNC_HOST_MAX_LENGTH, vncSecuritySchema } from "./vnc-connections";
import { vncAuthenticationSchema } from "./vnc-credentials";

const c = initContract();

export const runnerVncAuthoritySchema = z
  .object({
    instanceId: z.uuid(),
    generation: z.int().positive().max(2_147_483_647),
    grantId: z.uuid(),
  })
  .strict();

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
const expiredSchema = z.object({ outcome: z.literal("expired") }).strict();
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
      authority: runnerVncAuthoritySchema,
      authentication: vncAuthenticationSchema,
      security: vncSecuritySchema,
    })
    .strict(),
]);

const acquireRequestSchema = commonRequestSchema.extend({
  authority: runnerVncAuthoritySchema,
  holderId: z.uuid(),
});
const leaseRequestSchema = commonRequestSchema.extend({
  authority: runnerVncAuthoritySchema,
  leaseToken: z.uuid(),
});
const leaseFields = {
  leaseToken: z.uuid(),
  serverTime: z.string().datetime(),
  expiresAt: z.string().datetime(),
  validForMs: z.int().min(0).max(30_000),
  renewAfterMs: z.literal(10_000),
};
const acquireResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("acquired"), ...leaseFields }).strict(),
  z.object({ outcome: z.literal("busy") }).strict(),
  unavailableSchema,
  configurationChangedSchema,
  expiredSchema,
]);
const leaseResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("valid"), ...leaseFields }).strict(),
  unavailableSchema,
  configurationChangedSchema,
  expiredSchema,
]);
const releaseResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("released") }).strict(),
  unavailableSchema,
  expiredSchema,
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
  acquire: {
    method: "POST",
    path: "/api/runners/runs/:runId/vnc/acquire",
    pathParams,
    headers: authHeadersSchema,
    body: acquireRequestSchema,
    responses: { 200: acquireResponseSchema, ...errors },
    summary: "Acquire bounded exclusive control of one saved VNC connection",
  },
  check: {
    method: "POST",
    path: "/api/runners/runs/:runId/vnc/check",
    pathParams,
    headers: authHeadersSchema,
    body: leaseRequestSchema,
    responses: { 200: leaseResponseSchema, ...errors },
    summary: "Check current VNC authority without extending its lease",
  },
  renew: {
    method: "POST",
    path: "/api/runners/runs/:runId/vnc/renew",
    pathParams,
    headers: authHeadersSchema,
    body: leaseRequestSchema,
    responses: { 200: leaseResponseSchema, ...errors },
    summary: "Renew an unexpired VNC lease under current authority",
  },
  release: {
    method: "POST",
    path: "/api/runners/runs/:runId/vnc/release",
    pathParams,
    headers: authHeadersSchema,
    body: leaseRequestSchema,
    responses: { 200: releaseResponseSchema, ...errors },
    summary: "Release only the exact current VNC lease holder",
  },
});

export type RunnerVncAuthority = z.infer<typeof runnerVncAuthoritySchema>;
export type RunnerVncResolveRequest = z.infer<typeof resolveRequestSchema>;
export type RunnerVncResolveResponse = z.infer<typeof resolveResponseSchema>;
export type RunnerVncAcquireRequest = z.infer<typeof acquireRequestSchema>;
export type RunnerVncAcquireResponse = z.infer<typeof acquireResponseSchema>;
export type RunnerVncCheckRequest = z.infer<typeof leaseRequestSchema>;
export type RunnerVncCheckResponse = z.infer<typeof leaseResponseSchema>;
export type RunnerVncRenewRequest = z.infer<typeof leaseRequestSchema>;
export type RunnerVncRenewResponse = z.infer<typeof leaseResponseSchema>;
export type RunnerVncReleaseRequest = z.infer<typeof leaseRequestSchema>;
export type RunnerVncReleaseResponse = z.infer<typeof releaseResponseSchema>;
