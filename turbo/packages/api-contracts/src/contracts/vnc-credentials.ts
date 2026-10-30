import {
  array,
  discriminatedUnion,
  int,
  literal,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";

import {
  APPLE_DH_FIELD_MAX_BYTES,
  APPLE_RSA_SRP_USERNAME_MAX_BYTES,
  VNC_USERNAME_MAX_BYTES,
  boundedUtf8String,
  createVncCredentialRequestSchema,
  qemuScramUsernameSchema,
  revisionSchema,
  rsaAesFieldSchema,
  updateVncCredentialRequestSchema,
  vncPasswordAuthenticationVariantSchema,
  type vncAuthenticationSchema,
  type vncCredentialSelectionSchema,
} from "../validators/vnc-credentials";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  kerberosPrincipalSchema,
  kerberosServicePrincipalSchema,
} from "./vnc-kerberos";

export {
  APPLE_DH_FIELD_MAX_BYTES,
  APPLE_RSA_SRP_USERNAME_MAX_BYTES,
  VNC_CLIENT_CHAIN_PEM_MAX_LENGTH,
  VNC_CLIENT_KEY_PEM_MAX_LENGTH,
  VNC_DISPLAY_NAME_MAX_LENGTH,
  VNC_PASSWORD_MAX_LENGTH,
  VNC_USERNAME_MAX_BYTES,
  VNC_USERNAME_PASSWORD_MAX_BYTES,
  createVncCredentialRequestSchema,
  updateVncCredentialRequestSchema,
  vncAppleDhAuthenticationSchema,
  vncAppleRsaSrpAuthenticationSchema,
  vncAppleSrpAuthenticationSchema,
  vncAuthenticationSchema,
  vncCredentialSelectionSchema,
  vncLegacyAuthenticationSchema,
  vncQemuScramAuthenticationSchema,
  vncRsaAesAuthenticationSchema,
  vncUsernamePasswordAuthenticationSchema,
} from "../validators/vnc-credentials";

// Keep the classic-only schema as a one-variant discriminated union for callers
// that intentionally accept only this profile.
export const vncPasswordAuthenticationSchema = discriminatedUnion("method", [
  vncPasswordAuthenticationVariantSchema,
]);

const vncCredentialResponseBase = {
  id: uuid(),
  name: string(),
  revision: revisionSchema,
  createdAt: string().datetime(),
  updatedAt: string().datetime(),
  hosts: array(object({ id: uuid(), displayName: string() }).strict()),
} as const;

export const vncCredentialResponseSchema = discriminatedUnion("authMethod", [
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("qemu_kerberos_ticket"),
    initiator: kerberosPrincipalSchema,
    service: kerberosServicePrincipalSchema,
    declaredExpiresAt: int().positive().max(4_294_967_295),
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("qemu_kerberos_keytab"),
    initiator: kerberosPrincipalSchema,
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("qemu_kerberos_password"),
    initiator: kerberosPrincipalSchema,
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("rsa_aes_password"),
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("rsa_aes_username_password"),
    username: rsaAesFieldSchema,
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("client_certificate"),
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("client_certificate_vnc_password"),
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("vnc_password"),
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("username_password"),
    username: boundedUtf8String(VNC_USERNAME_MAX_BYTES, "VNC username"),
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("qemu_scram_sha256"),
    username: qemuScramUsernameSchema,
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("apple_dh_username_password"),
    username: boundedUtf8String(APPLE_DH_FIELD_MAX_BYTES, "Apple DH username"),
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("apple_srp_username_password"),
    username: boundedUtf8String(VNC_USERNAME_MAX_BYTES, "Apple SRP username"),
  }).strict(),
  object({
    ...vncCredentialResponseBase,
    authMethod: literal("apple_rsa_srp_username_password"),
    username: boundedUtf8String(
      APPLE_RSA_SRP_USERNAME_MAX_BYTES,
      "Apple RSA/SRP username",
    ),
  }).strict(),
]);

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
};
const pathParams = object({ credentialId: uuid() }).strict();

export const vncCredentialsContract = c.router({
  list: {
    method: "GET",
    path: "/api/vnc/credentials",
    headers: authHeadersSchema,
    responses: {
      200: object({ credentials: array(vncCredentialResponseSchema) }).strict(),
      ...errors,
    },
    summary: "List owned VNC credentials without secrets",
  },
  create: {
    method: "POST",
    path: "/api/vnc/credentials",
    headers: authHeadersSchema,
    body: createVncCredentialRequestSchema.extend({ id: uuid() }),
    responses: { 201: vncCredentialResponseSchema, 204: c.noBody(), ...errors },
    summary: "Create a reusable VNC credential",
  },
  update: {
    method: "PATCH",
    path: "/api/vnc/credentials/:credentialId",
    headers: authHeadersSchema,
    pathParams,
    body: updateVncCredentialRequestSchema,
    responses: { 200: vncCredentialResponseSchema, ...errors },
    summary: "Update an owned VNC credential",
  },
  delete: {
    method: "DELETE",
    path: "/api/vnc/credentials/:credentialId",
    headers: authHeadersSchema,
    pathParams,
    body: object({ expectedRevision: revisionSchema }).strict(),
    responses: { 204: c.noBody(), ...errors },
    summary: "Delete an unused VNC credential",
  },
});

export type VncAuthentication = zInfer<typeof vncAuthenticationSchema>;
export type CreateVncCredentialRequest = zInfer<
  typeof createVncCredentialRequestSchema
>;
export type UpdateVncCredentialRequest = zInfer<
  typeof updateVncCredentialRequestSchema
>;
export type VncCredentialSelection = zInfer<
  typeof vncCredentialSelectionSchema
>;
export type VncCredentialResponse = zInfer<typeof vncCredentialResponseSchema>;
