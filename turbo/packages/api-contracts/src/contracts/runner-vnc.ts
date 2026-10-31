import {
  array,
  base64,
  discriminatedUnion,
  int,
  iso,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

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

const generationSchema = int().positive().max(2_147_483_647);

/** VNC-only eviction; an explicit null selects every VNC connection in the Run. */
export const runnerVncInvalidateSchema = object({
  runId: uuid(),
  connectionId: uuid().nullable(),
}).strict();

export type RunnerVncInvalidate = zInfer<typeof runnerVncInvalidateSchema>;

const sshTransportSnapshotSchema = object({
  type: literal("ssh"),
  connectionId: uuid(),
  generation: generationSchema,
}).strict();
const directTransportSnapshotSchema = object({
  type: literal("direct"),
}).strict();
const accessTransportSnapshotSchema = object({
  type: literal("cloudflare_access"),
  configId: uuid(),
  generation: generationSchema,
}).strict();
const tailscaleTransportSnapshotSchema = object({
  type: literal("tailscale"),
  configId: uuid(),
  generation: generationSchema,
}).strict();
const transportSnapshotSchema = discriminatedUnion("type", [
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
const resolvedKdcTransportSchema = discriminatedUnion("type", [
  directTransportSnapshotSchema,
  sshTransportSnapshotSchema,
  resolvedAccessKdcTransportSchema,
  resolvedTailscaleTransportSchema,
]);
const resolvedTransportSchema = discriminatedUnion("type", [
  directTransportSnapshotSchema,
  sshTransportSnapshotSchema,
  resolvedAccessKdcTransportSchema.extend({
    originTls: vncOriginTlsSchema.nullable(),
  }),
  resolvedTailscaleTransportSchema,
]);
const kdcSnapshotSchema = object({
  host: string().min(1).max(253),
  port: int().min(1).max(65_535),
  transport: resolvedKdcTransportSchema,
  ticketLifetimeSeconds: int().min(1).max(7200),
  renewableLifetimeSeconds: int().min(0).max(7200),
}).strict();

const runnerVncKerberosSecuritySchema = object({
  type: literal("qemu_x509_gssapi"),
  trust: vncTrustSchema,
  service: kerberosServicePrincipalSchema,
  kdc: kdcSnapshotSchema.nullable(),
}).strict();
export const runnerVncSecuritySchema = discriminatedUnion("type", [
  ...vncRsaAesSecuritySchema.options,
  object({ type: literal("x509_vnc"), trust: vncTrustSchema }).strict(),
  object({ type: literal("x509_plain"), trust: vncTrustSchema }).strict(),
  object({ type: literal("x509_none"), trust: vncTrustSchema }).strict(),
  object({ type: literal("qemu_x509_sasl"), trust: vncTrustSchema }).strict(),
  object({ type: literal("apple_vnc_password") }).strict(),
  object({ type: literal("apple_dh") }).strict(),
  object({ type: literal("apple_srp") }).strict(),
  object({ type: literal("apple_rsa_srp") }).strict(),
  runnerVncKerberosSecuritySchema,
]);

const clientIdentityWire = {
  certificateChainDer: array(base64()).min(1).max(8),
  privateKeyPkcs8Der: base64(),
} as const;

const runnerX509AuthenticationSchema = discriminatedUnion("method", [
  ...vncKerberosAuthenticationSchema.options,
  ...vncLegacyAuthenticationSchema.options,
  // The sensitive generator shares username/password wire fields. Owner/API
  // plaintext validation and the native engine enforce the exact 255-byte RSA bounds.
  object({
    method: literal("rsa_aes_password"),
    password: vncUsernamePasswordAuthenticationSchema.shape.password,
  }).strict(),
  object({
    method: literal("rsa_aes_username_password"),
    username: vncUsernamePasswordAuthenticationSchema.shape.username,
    password: vncUsernamePasswordAuthenticationSchema.shape.password,
  }).strict(),
  // Generated private DTOs share a username/password field shape. The owner
  // contract and API post-KMS validation enforce stricter SCRAM ASCII bounds;
  // the Runner validates again before opening a socket.
  object({
    method: literal("qemu_scram_sha256"),
    username: vncUsernamePasswordAuthenticationSchema.shape.username,
    password: vncUsernamePasswordAuthenticationSchema.shape.password,
  }).strict(),
  object({ method: literal("none") }).strict(),
  object({
    method: literal("client_certificate"),
    ...clientIdentityWire,
  }).strict(),
  object({
    method: literal("client_certificate_vnc_password"),
    ...clientIdentityWire,
    password: string().min(1).max(8),
  }).strict(),
]);

const commonRequestSchema = object({
  connectionId: uuid(),
  runnerIdentity: object({
    runnerId: uuid(),
    heartbeatGeneration: runnerHeartbeatGenerationSchema,
  }).strict(),
}).strict();

const supportedProfileFieldsSchema = object({
  authMethod: zEnum([
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
  securityType: zEnum([
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
  transportType: zEnum(["direct", "ssh", "cloudflare_access", "tailscale"]),
  kdcTransportType: zEnum([
    "none",
    "direct",
    "ssh",
    "cloudflare_access",
    "tailscale",
  ]).optional(),
}).strict();

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
  zInfer<typeof supportedProfileFieldsSchema>["authMethod"],
  zInfer<typeof supportedProfileFieldsSchema>["securityType"]
>;

function matchesSupportedVncProfile(
  profile: zInfer<typeof supportedProfileFieldsSchema>,
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
  supportedProfiles: array(supportedProfileSchema).max(128),
});
const unavailableSchema = object({ outcome: literal("unavailable") }).strict();
const configurationChangedSchema = object({
  outcome: literal("configuration_changed"),
}).strict();

const resolveResponseSchema = discriminatedUnion("outcome", [
  unavailableSchema,
  object({ outcome: literal("unsupported_profile") }).strict(),
  object({
    outcome: literal("resolved_transport"),
    host: string().min(1).max(VNC_HOST_MAX_LENGTH),
    port: int().min(1).max(65_535),
    generation: generationSchema,
    serverName: string().min(1).max(VNC_HOST_MAX_LENGTH),
    transport: resolvedTransportSchema,
    authentication: runnerX509AuthenticationSchema,
    security: runnerVncSecuritySchema,
  }).strict(),
  object({
    outcome: literal("resolved_apple_vnc_password"),
    host: string().min(1).max(VNC_HOST_MAX_LENGTH),
    port: int().min(1).max(65_535),
    generation: generationSchema,
    transport: resolvedTransportSchema,
    authentication: runnerX509AuthenticationSchema,
    security: runnerVncSecuritySchema,
  }).strict(),
  object({
    outcome: literal("resolved_apple_dh"),
    host: string().min(1).max(VNC_HOST_MAX_LENGTH),
    port: int().min(1).max(65_535),
    generation: generationSchema,
    transport: resolvedTransportSchema,
    authentication: runnerX509AuthenticationSchema,
    security: runnerVncSecuritySchema,
  }).strict(),
  object({
    outcome: literal("resolved_apple_srp"),
    host: string().min(1).max(VNC_HOST_MAX_LENGTH),
    port: int().min(1).max(65_535),
    generation: generationSchema,
    transport: resolvedTransportSchema,
    authentication: runnerX509AuthenticationSchema,
    security: runnerVncSecuritySchema,
  }).strict(),
  object({
    outcome: literal("resolved_apple_rsa_srp"),
    host: string().min(1).max(VNC_HOST_MAX_LENGTH),
    port: int().min(1).max(65_535),
    generation: generationSchema,
    transport: resolvedTransportSchema,
    authentication: runnerX509AuthenticationSchema,
    security: runnerVncSecuritySchema,
  }).strict(),
  object({
    outcome: literal("resolved_rsa_aes"),
    host: string().min(1).max(VNC_HOST_MAX_LENGTH),
    port: int().min(1).max(65_535),
    generation: generationSchema,
    transport: resolvedTransportSchema,
    authentication: runnerX509AuthenticationSchema,
    security: runnerVncSecuritySchema,
  }).strict(),
  object({
    outcome: literal("resolved_kerberos"),
    host: string().min(1).max(VNC_HOST_MAX_LENGTH),
    port: int().min(1).max(65_535),
    generation: generationSchema,
    credentialRevision: generationSchema,
    serverName: string().min(1).max(VNC_HOST_MAX_LENGTH),
    transport: resolvedTransportSchema,
    authentication: runnerX509AuthenticationSchema,
    security: runnerVncSecuritySchema,
  }).strict(),
]);

const checkRequestSchema = commonRequestSchema.extend({
  expectedGeneration: generationSchema,
  expectedTransport: transportSnapshotSchema,
  expectedKdcTransport: transportSnapshotSchema.optional(),
  expectedCredentialRevision: generationSchema.optional(),
});
const checkResponseSchema = discriminatedUnion("outcome", [
  object({ outcome: literal("valid") }).strict(),
  unavailableSchema,
  configurationChangedSchema,
]);

const observationRequestSchema = checkRequestSchema.extend({
  expectedCreatedAt: iso.datetime(),
  observedAt: iso.datetime(),
  failureReason: vncConnectionFailureReasonSchema.nullable(),
});

const pathParams = object({ runId: uuid() }).strict();
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
      200: object({
        outcome: zEnum(["recorded", "ignored", "unavailable"]),
      }).strict(),
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

export type RunnerVncResolveRequest = zInfer<typeof resolveRequestSchema>;
export type RunnerVncResolveResponse = zInfer<typeof resolveResponseSchema>;
export type RunnerVncCheckRequest = zInfer<typeof checkRequestSchema>;
export type RunnerVncCheckResponse = zInfer<typeof checkResponseSchema>;
export type RunnerVncObservationRequest = zInfer<
  typeof observationRequestSchema
>;
