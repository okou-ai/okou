import {
  array,
  discriminatedUnion,
  int,
  literal,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { vncConnectionObservationSchema } from "./vnc-connection-observations";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  kerberosKdcSchema,
  kerberosKdcMetadataSchema,
  kerberosServicePrincipalSchema,
} from "./vnc-kerberos";
import {
  VNC_DISPLAY_NAME_MAX_LENGTH,
  vncCredentialSelectionSchema,
} from "./vnc-credentials";

import {
  vncRsaAesSecuritySchema,
  vncRsaAesAuthenticationMethodSchema,
  VNC_RSA_PUBLIC_KEY_MAX_BYTES,
} from "./vnc-rsa-aes";

import {
  VNC_HOST_MAX_LENGTH,
  vncTrustSchema,
  vncTransportMetadataSchema,
  vncTransportSchema,
} from "./vnc-transport";
export {
  VNC_HOST_MAX_LENGTH,
  VNC_CA_BUNDLE_MAX_LENGTH,
  VNC_CA_CERTIFICATES_MAX_COUNT,
  vncTrustSchema,
  vncTransportSchema,
} from "./vnc-transport";

const displayNameSchema = string()
  .trim()
  .min(1)
  .max(VNC_DISPLAY_NAME_MAX_LENGTH);
const hostSchema = string().min(1).max(VNC_HOST_MAX_LENGTH);
const portSchema = int().min(1).max(65_535);
const generationSchema = int().positive().max(2_147_483_647);

const vncX509NoneSecurityVariantSchema = object({
  type: literal("x509_none"),
  trust: vncTrustSchema,
  serverName: hostSchema.optional(),
}).strict();
const vncX509VncSecurityVariantSchema = object({
  type: literal("x509_vnc"),
  trust: vncTrustSchema,
  serverName: hostSchema.optional(),
}).strict();
const vncX509PlainSecurityVariantSchema = object({
  type: literal("x509_plain"),
  trust: vncTrustSchema,
  serverName: hostSchema.optional(),
}).strict();
const vncQemuX509SaslSecurityVariantSchema = object({
  type: literal("qemu_x509_sasl"),
  trust: vncTrustSchema,
  serverName: hostSchema.optional(),
}).strict();
export const vncQemuGssapiSecuritySchema = object({
  type: literal("qemu_x509_gssapi"),
  trust: vncTrustSchema,
  serverName: hostSchema.optional(),
  service: kerberosServicePrincipalSchema,
  kdc: kerberosKdcSchema.optional(),
}).strict();
const vncAppleVncPasswordSecurityVariantSchema = object({
  type: literal("apple_vnc_password"),
}).strict();
const vncAppleDhSecurityVariantSchema = object({
  type: literal("apple_dh"),
}).strict();
const vncAppleSrpSecurityVariantSchema = object({
  type: literal("apple_srp"),
}).strict();
const vncAppleRsaSrpSecurityVariantSchema = object({
  type: literal("apple_rsa_srp"),
}).strict();
// Keep current-only Runner schemas as one-variant discriminated unions so the
// Rust generator preserves the existing enum-shaped wire type.
export const vncX509VncSecuritySchema = discriminatedUnion("type", [
  vncX509VncSecurityVariantSchema,
]);
export const vncX509PlainSecuritySchema = discriminatedUnion("type", [
  vncX509PlainSecurityVariantSchema,
]);
const vncCredentialSecuritySchema = discriminatedUnion("type", [
  vncQemuGssapiSecuritySchema.extend({
    kdc: kerberosKdcMetadataSchema.optional(),
  }),
  ...vncRsaAesSecuritySchema.options,
  vncX509NoneSecurityVariantSchema,
  vncX509VncSecurityVariantSchema,
  vncX509PlainSecurityVariantSchema,
  vncQemuX509SaslSecurityVariantSchema,
  vncAppleVncPasswordSecurityVariantSchema,
  vncAppleDhSecurityVariantSchema,
  vncAppleSrpSecurityVariantSchema,
  vncAppleRsaSrpSecurityVariantSchema,
]);
export const vncSecuritySchema = discriminatedUnion("type", [
  vncQemuGssapiSecuritySchema,
  ...vncRsaAesSecuritySchema.options,
  vncX509NoneSecurityVariantSchema,
  vncX509VncSecurityVariantSchema,
  vncX509PlainSecurityVariantSchema,
  vncQemuX509SaslSecurityVariantSchema,
  vncAppleVncPasswordSecurityVariantSchema,
  vncAppleDhSecurityVariantSchema,
  vncAppleSrpSecurityVariantSchema,
  vncAppleRsaSrpSecurityVariantSchema,
]);

export const vncConnectionCredentialSchema = union([
  vncCredentialSelectionSchema,
  object({ type: literal("none") }).strict(),
]);

export const createVncConnectionRequestSchema = object({
  id: uuid(),
  displayName: displayNameSchema,
  host: hostSchema,
  port: portSchema.default(5900),
  credential: vncConnectionCredentialSchema,
  security: vncSecuritySchema,
  transport: vncTransportSchema.optional(),
}).strict();

export const updateVncConnectionRequestSchema = object({
  expectedGeneration: generationSchema,
  displayName: displayNameSchema.optional(),
  host: hostSchema.optional(),
  port: portSchema.optional(),
  credential: vncConnectionCredentialSchema.optional(),
  security: vncSecuritySchema.optional(),
  transport: vncTransportSchema.optional(),
})
  .strict()
  .refine(
    (body) => {
      return (
        body.displayName !== undefined ||
        body.host !== undefined ||
        body.port !== undefined ||
        body.credential !== undefined ||
        body.security !== undefined ||
        body.transport !== undefined
      );
    },
    { message: "At least one VNC connection field must be updated" },
  );

export const vncConnectionPathParamsSchema = object({
  connectionId: uuid(),
}).strict();

export const vncConnectionMetadataSchema = object({
  id: uuid(),
  displayName: string(),
  host: string(),
  port: portSchema,
  credentialId: uuid(),
  credentialName: string(),
  rsaAesAuthentication: vncRsaAesAuthenticationMethodSchema.optional(),
  clientCertificateAuthentication: zEnum([
    "client_certificate",
    "client_certificate_vnc_password",
  ]).optional(),
  kerberosAuthentication: zEnum([
    "qemu_kerberos_ticket",
    "qemu_kerberos_keytab",
    "qemu_kerberos_password",
  ]).optional(),
  security: vncCredentialSecuritySchema,
  generation: generationSchema,
  createdAt: string().datetime(),
  updatedAt: string().datetime(),
}).strict();

const vncCredentiallessMetadataSchema = vncConnectionMetadataSchema
  .omit({ credentialId: true, credentialName: true, security: true })
  .extend({
    credential: object({ type: literal("none") }).strict(),
    security: vncX509NoneSecurityVariantSchema,
  });
export const vncConnectionResponseSchema = union([
  vncConnectionMetadataSchema.extend({
    transport: vncTransportMetadataSchema.optional(),
  }),
  vncCredentiallessMetadataSchema.extend({
    transport: vncTransportMetadataSchema.optional(),
  }),
]);

export const vncConnectionsListResponseSchema = object({
  connections: array(vncConnectionResponseSchema),
}).strict();
export const vncConnectionsSummaryResponseSchema = object({
  configuredCount: int().nonnegative(),
}).strict();

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
};

export const vncConnectionsContract = c.router({
  observations: {
    method: "GET",
    path: "/api/vnc/connections/observations",
    headers: authHeadersSchema,
    responses: {
      200: object({
        observations: array(vncConnectionObservationSchema),
      }).strict(),
      ...errors,
    },
    summary: "Read the owner's latest VNC connection observations",
  },
  inspectRsaKey: {
    method: "POST",
    path: "/api/vnc/rsa-key-pin",
    headers: authHeadersSchema,
    body: object({
      publicKeyPem: string().min(1).max(VNC_RSA_PUBLIC_KEY_MAX_BYTES),
    }).strict(),
    responses: {
      200: object({
        serverKeySha256: string().regex(/^[a-f0-9]{64}$/u),
        modulusBits: union([literal(2048), literal(3072), literal(4096)]),
      }).strict(),
      ...errors,
    },
    summary:
      "Convert an independently obtained RSA public key to its full RFB wire pin",
  },
  list: {
    method: "GET",
    path: "/api/vnc/connections",
    headers: authHeadersSchema,
    responses: { 200: vncConnectionsListResponseSchema, ...errors },
    summary: "List owned VNC connections",
  },
  summary: {
    method: "GET",
    path: "/api/vnc/connections/summary",
    headers: authHeadersSchema,
    responses: { 200: vncConnectionsSummaryResponseSchema, ...errors },
    summary: "Summarize owned VNC connection configuration",
  },
  create: {
    method: "POST",
    path: "/api/vnc/connections",
    headers: authHeadersSchema,
    body: createVncConnectionRequestSchema,
    responses: { 201: vncConnectionResponseSchema, 204: c.noBody(), ...errors },
    summary: "Create a VNC connection",
  },
  update: {
    method: "PATCH",
    path: "/api/vnc/connections/:connectionId",
    headers: authHeadersSchema,
    pathParams: vncConnectionPathParamsSchema,
    body: updateVncConnectionRequestSchema,
    responses: { 200: vncConnectionResponseSchema, ...errors },
    summary: "Update an owned VNC connection",
  },
  delete: {
    method: "DELETE",
    path: "/api/vnc/connections/:connectionId",
    headers: authHeadersSchema,
    pathParams: vncConnectionPathParamsSchema,
    body: object({ expectedGeneration: generationSchema }).strict(),
    responses: { 204: c.noBody(), ...errors },
    summary: "Delete an owned VNC connection",
  },
});

export type CreateVncConnectionRequest = zInfer<
  typeof createVncConnectionRequestSchema
>;
export type UpdateVncConnectionRequest = zInfer<
  typeof updateVncConnectionRequestSchema
>;
export type VncConnectionResponse = zInfer<typeof vncConnectionResponseSchema>;
export type VncTrust = zInfer<typeof vncTrustSchema>;
export type VncSecurity = zInfer<typeof vncSecuritySchema>;
export type VncTransport = zInfer<typeof vncTransportSchema>;
