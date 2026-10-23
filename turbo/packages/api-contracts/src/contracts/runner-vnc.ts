import * as z from "zod";
import { vncConnectionFailureReasonSchema } from "./vnc-connection-observations";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";
import { VNC_HOST_MAX_LENGTH, vncTrustSchema } from "./vnc-connections";
import { vncOriginTlsSchema } from "./vnc-transport";
import { cloudflareAccessCredentialsSchema } from "./cloudflare-access";
import { tailscaleCredentialsSchema, tailscaleTagsSchema } from "./tailscale";
import {
  kerberosServicePrincipalSchema,
  vncKerberosAuthenticationSchema,
  isVncKerberosMethod,
} from "./vnc-kerberos";
import {
  vncLegacyAuthenticationSchema,
  vncUsernamePasswordAuthenticationSchema,
} from "./vnc-credentials";

import {
  vncRsaAesSecuritySchema,
  isVncRsaAesSecurityType,
  isVncRsaAesAuthenticationOnly,
} from "./vnc-rsa-aes";

const c = initContract();

const generationSchema = z.int().positive().max(2_147_483_647);

/** VNC-only eviction; an explicit null selects every VNC connection in the Run. */
export const runnerVncInvalidateSchema = z
  .object({
    runId: z.uuid(),
    connectionId: z.uuid().nullable(),
  })
  .strict();

export type RunnerVncInvalidate = z.infer<typeof runnerVncInvalidateSchema>;

const sshTransportSnapshotSchema = z
  .object({
    type: z.literal("ssh"),
    connectionId: z.uuid(),
    generation: generationSchema,
  })
  .strict();
const directTransportSnapshotSchema = z
  .object({ type: z.literal("direct") })
  .strict();
const accessTransportSnapshotSchema = z
  .object({
    type: z.literal("cloudflare_access"),
    configId: z.uuid(),
    generation: generationSchema,
  })
  .strict();
const tailscaleTransportSnapshotSchema = z
  .object({
    type: z.literal("tailscale"),
    configId: z.uuid(),
    generation: generationSchema,
  })
  .strict();
const transportSnapshotSchema = z.discriminatedUnion("type", [
  directTransportSnapshotSchema,
  sshTransportSnapshotSchema,
  accessTransportSnapshotSchema,
  tailscaleTransportSnapshotSchema,
]);
// Provider secrets belong only in the winning Runner resolution, never in
// public metadata or the generation-bound check/observation snapshots.
const resolvedAccessKdcTransportSchema = accessTransportSnapshotSchema.extend({
  credentials: cloudflareAccessCredentialsSchema,
});
const resolvedTailscaleTransportSchema =
  tailscaleTransportSnapshotSchema.extend({
    credentials: tailscaleCredentialsSchema,
    tags: tailscaleTagsSchema,
  });
const resolvedKdcTransportSchema = z.discriminatedUnion("type", [
  directTransportSnapshotSchema,
  sshTransportSnapshotSchema,
  resolvedAccessKdcTransportSchema,
  resolvedTailscaleTransportSchema,
]);
const resolvedTransportSchema = z.discriminatedUnion("type", [
  directTransportSnapshotSchema,
  sshTransportSnapshotSchema,
  resolvedAccessKdcTransportSchema.extend({
    originTls: vncOriginTlsSchema.nullable(),
  }),
  resolvedTailscaleTransportSchema,
]);
const kdcSnapshotSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.int().min(1).max(65_535),
    transport: resolvedKdcTransportSchema,
    ticketLifetimeSeconds: z.int().min(1).max(7200),
    renewableLifetimeSeconds: z.int().min(0).max(7200),
  })
  .strict();

const runnerVncKerberosSecuritySchema = z
  .object({
    type: z.literal("qemu_x509_gssapi"),
    trust: vncTrustSchema,
    service: kerberosServicePrincipalSchema,
    kdc: kdcSnapshotSchema.nullable(),
  })
  .strict();
export const runnerVncSecuritySchema = z.discriminatedUnion("type", [
  ...vncRsaAesSecuritySchema.options,
  z.object({ type: z.literal("x509_vnc"), trust: vncTrustSchema }).strict(),
  z.object({ type: z.literal("x509_plain"), trust: vncTrustSchema }).strict(),
  z.object({ type: z.literal("x509_none"), trust: vncTrustSchema }).strict(),
  z
    .object({ type: z.literal("qemu_x509_sasl"), trust: vncTrustSchema })
    .strict(),
  z.object({ type: z.literal("apple_vnc_password") }).strict(),
  z.object({ type: z.literal("apple_dh") }).strict(),
  z.object({ type: z.literal("apple_srp") }).strict(),
  z.object({ type: z.literal("apple_rsa_srp") }).strict(),
  runnerVncKerberosSecuritySchema,
]);

const clientIdentityWire = {
  certificateChainDer: z.array(z.base64()).min(1).max(8),
  privateKeyPkcs8Der: z.base64(),
} as const;

const runnerX509AuthenticationSchema = z.discriminatedUnion("method", [
  ...vncKerberosAuthenticationSchema.options,
  ...vncLegacyAuthenticationSchema.options,
  // The sensitive generator shares username/password wire fields. Owner/API
  // plaintext validation and the native engine enforce the exact 255-byte RSA bounds.
  z
    .object({
      method: z.literal("rsa_aes_password"),
      password: vncUsernamePasswordAuthenticationSchema.shape.password,
    })
    .strict(),
  z
    .object({
      method: z.literal("rsa_aes_username_password"),
      username: vncUsernamePasswordAuthenticationSchema.shape.username,
      password: vncUsernamePasswordAuthenticationSchema.shape.password,
    })
    .strict(),
  // Generated private DTOs share a username/password field shape. The owner
  // contract and API post-KMS validation enforce stricter SCRAM ASCII bounds;
  // the Runner validates again before opening a socket.
  z
    .object({
      method: z.literal("qemu_scram_sha256"),
      username: vncUsernamePasswordAuthenticationSchema.shape.username,
      password: vncUsernamePasswordAuthenticationSchema.shape.password,
    })
    .strict(),
  z.object({ method: z.literal("none") }).strict(),
  z
    .object({ method: z.literal("client_certificate"), ...clientIdentityWire })
    .strict(),
  z
    .object({
      method: z.literal("client_certificate_vnc_password"),
      ...clientIdentityWire,
      password: z.string().min(1).max(8),
    })
    .strict(),
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

const supportedProfileFieldsSchema = z
  .object({
    authMethod: z.enum([
      "none",
      "vnc_password",
      "username_password",
      "qemu_scram_sha256",
      "qemu_kerberos_ticket",
      "qemu_kerberos_keytab",
      "qemu_kerberos_password",
      "rsa_aes_password",
      "rsa_aes_username_password",
      "apple_dh_username_password",
      "apple_srp_username_password",
      "apple_rsa_srp_username_password",
      "client_certificate",
      "client_certificate_vnc_password",
    ]),
    securityType: z.enum([
      "x509_none",
      "x509_vnc",
      "x509_plain",
      "qemu_x509_sasl",
      "qemu_x509_gssapi",
      "rsa_aes_ra2",
      "rsa_aes_ra2_256",
      "rsa_aes_ra2ne",
      "rsa_aes_ra2ne_256",
      "apple_vnc_password",
      "apple_dh",
      "apple_srp",
      "apple_rsa_srp",
    ]),
    transportType: z.enum(["direct", "ssh", "cloudflare_access", "tailscale"]),
    kdcTransportType: z
      .enum(["none", "direct", "ssh", "cloudflare_access", "tailscale"])
      .optional(),
  })
  .strict();

const exactSecurityByAuth = {
  none: "x509_none",
  client_certificate: "x509_none",
  vnc_password: "x509_vnc",
  client_certificate_vnc_password: "x509_vnc",
  username_password: "x509_plain",
  qemu_scram_sha256: "qemu_x509_sasl",
  qemu_kerberos_ticket: "qemu_x509_gssapi",
  qemu_kerberos_keytab: "qemu_x509_gssapi",
  qemu_kerberos_password: "qemu_x509_gssapi",
  rsa_aes_password: "rsa_aes_ra2",
  rsa_aes_username_password: "rsa_aes_ra2",
  apple_dh_username_password: "apple_dh",
  apple_srp_username_password: "apple_srp",
  apple_rsa_srp_username_password: "apple_rsa_srp",
} as const satisfies Record<
  z.infer<typeof supportedProfileFieldsSchema>["authMethod"],
  z.infer<typeof supportedProfileFieldsSchema>["securityType"]
>;

function matchesSupportedVncProfile(
  profile: z.infer<typeof supportedProfileFieldsSchema>,
): boolean {
  if (isVncKerberosMethod(profile.authMethod)) {
    return (
      profile.securityType === "qemu_x509_gssapi" &&
      (profile.authMethod === "qemu_kerberos_ticket"
        ? profile.kdcTransportType === "none"
        : profile.kdcTransportType === "direct" ||
          profile.kdcTransportType === "ssh" ||
          profile.kdcTransportType === "cloudflare_access" ||
          profile.kdcTransportType === "tailscale")
    );
  }
  if (profile.kdcTransportType !== undefined) {
    return false;
  }
  if (isVncRsaAesSecurityType(profile.securityType)) {
    return (
      (profile.authMethod === "rsa_aes_password" ||
        profile.authMethod === "rsa_aes_username_password") &&
      (!isVncRsaAesAuthenticationOnly(profile.securityType) ||
        profile.transportType !== "direct")
    );
  }
  if (profile.securityType === "apple_vnc_password") {
    return (
      profile.authMethod === "vnc_password" &&
      profile.transportType !== "direct"
    );
  }
  return (
    profile.securityType === exactSecurityByAuth[profile.authMethod] &&
    (!profile.authMethod.startsWith("apple_") ||
      profile.transportType !== "direct")
  );
}

const supportedProfileSchema = supportedProfileFieldsSchema.refine(
  matchesSupportedVncProfile,
  "VNC Runner profiles require an exact authentication/security pair",
);

const resolveRequestSchema = commonRequestSchema.extend({
  supportedProfiles: z.array(supportedProfileSchema).max(128),
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
      outcome: z.literal("resolved_transport"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      serverName: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      transport: resolvedTransportSchema,
      authentication: runnerX509AuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_apple_vnc_password"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      transport: resolvedTransportSchema,
      authentication: runnerX509AuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_apple_dh"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      transport: resolvedTransportSchema,
      authentication: runnerX509AuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_apple_srp"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      transport: resolvedTransportSchema,
      authentication: runnerX509AuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_apple_rsa_srp"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      transport: resolvedTransportSchema,
      authentication: runnerX509AuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_rsa_aes"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      transport: resolvedTransportSchema,
      authentication: runnerX509AuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("resolved_kerberos"),
      host: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      generation: generationSchema,
      credentialRevision: generationSchema,
      serverName: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
      transport: resolvedTransportSchema,
      authentication: runnerX509AuthenticationSchema,
      security: runnerVncSecuritySchema,
    })
    .strict(),
]);

const checkRequestSchema = commonRequestSchema.extend({
  expectedGeneration: generationSchema,
  expectedTransport: transportSnapshotSchema,
  expectedKdcTransport: transportSnapshotSchema.optional(),
  expectedCredentialRevision: generationSchema.optional(),
});
const checkResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("valid") }).strict(),
  unavailableSchema,
  configurationChangedSchema,
]);

const observationRequestSchema = checkRequestSchema.extend({
  expectedCreatedAt: z.string().datetime(),
  observedAt: z.string().datetime(),
  failureReason: vncConnectionFailureReasonSchema.nullable(),
});

const pathParams = z.object({ runId: z.uuid() }).strict();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  500: apiErrorSchema,
};

export const runnerVncContract = c.router({
  observe: {
    method: "POST",
    path: "/api/runners/runs/:runId/vnc/observations",
    pathParams,
    headers: authHeadersSchema,
    body: observationRequestSchema,
    responses: {
      200: z
        .object({ outcome: z.enum(["recorded", "ignored", "unavailable"]) })
        .strict(),
      ...errors,
    },
    summary: "Record connection evidence from the winning official VNC Runner",
  },
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
export type RunnerVncObservationRequest = z.infer<
  typeof observationRequestSchema
>;
