import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";
import { VNC_HOST_MAX_LENGTH, vncTrustSchema } from "./vnc-connections";
import { vncAuthenticationSchema } from "./vnc-credentials";

const c = initContract();

const generationSchema = z.int().positive().max(2_147_483_647);

const sshTransportSnapshotSchema = z
  .object({
    type: z.literal("ssh"),
    connectionId: z.uuid(),
    generation: generationSchema,
  })
  .strict();
const transportSnapshotSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("direct") }).strict(),
  sshTransportSnapshotSchema,
]);

export const runnerVncSecuritySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("x509_vnc"), trust: vncTrustSchema }).strict(),
  z.object({ type: z.literal("x509_plain"), trust: vncTrustSchema }).strict(),
  z.object({ type: z.literal("apple_vnc_password") }).strict(),
  z.object({ type: z.literal("apple_dh") }).strict(),
  z.object({ type: z.literal("apple_srp") }).strict(),
  z.object({ type: z.literal("apple_rsa_srp") }).strict(),
]);

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

const supportedProfileSchema = z
  .object({
    authMethod: z.enum([
      "vnc_password",
      "username_password",
      "apple_dh_username_password",
      "apple_srp_username_password",
      "apple_rsa_srp_username_password",
    ]),
    securityType: z.enum([
      "x509_vnc",
      "x509_plain",
      "apple_vnc_password",
      "apple_dh",
      "apple_srp",
      "apple_rsa_srp",
    ]),
    transportType: z.enum(["direct", "ssh"]).optional(),
  })
  .strict()
  .refine((profile) => {
    return (
      (profile.authMethod === "vnc_password" &&
        profile.securityType === "x509_vnc") ||
      (profile.authMethod === "vnc_password" &&
        profile.securityType === "apple_vnc_password" &&
        profile.transportType === "ssh") ||
      (profile.authMethod === "username_password" &&
        profile.securityType === "x509_plain") ||
      (profile.authMethod === "apple_dh_username_password" &&
        profile.securityType === "apple_dh" &&
        profile.transportType === "ssh") ||
      (profile.authMethod === "apple_srp_username_password" &&
        profile.securityType === "apple_srp" &&
        profile.transportType === "ssh") ||
      (profile.authMethod === "apple_rsa_srp_username_password" &&
        profile.securityType === "apple_rsa_srp" &&
        profile.transportType === "ssh")
    );
  }, "VNC Runner profiles require an exact authentication/security pair");

const resolveRequestSchema = commonRequestSchema.extend({
  supportedProfiles: z.array(supportedProfileSchema).max(16),
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
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_transport"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      serverName: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      transport: transportSnapshotSchema,
      authentication: vncAuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_apple_vnc_password"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      transport: transportSnapshotSchema,
      authentication: vncAuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_apple_dh"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      transport: transportSnapshotSchema,
      authentication: vncAuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_apple_srp"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      transport: transportSnapshotSchema,
      authentication: vncAuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_apple_rsa_srp"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      transport: transportSnapshotSchema,
      authentication: vncAuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
]);

const checkRequestSchema = commonRequestSchema.extend({
  expectedGeneration: generationSchema,
  expectedTransport: transportSnapshotSchema.optional(),
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
