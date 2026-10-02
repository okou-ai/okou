import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { VNC_RSA_AES_FIELD_MAX_BYTES } from "./vnc-rsa-aes";

export const VNC_DISPLAY_NAME_MAX_LENGTH = 128;
export const VNC_PASSWORD_MAX_LENGTH = 8;
export const VNC_USERNAME_MAX_BYTES = 255;
export const VNC_USERNAME_PASSWORD_MAX_BYTES = 1_023;
export const APPLE_DH_FIELD_MAX_BYTES = 63;
export const APPLE_RSA_SRP_USERNAME_MAX_BYTES = 234;
// PEM encodings are bounded separately from the DER limits enforced at the API and Runner.
export const VNC_CLIENT_CHAIN_PEM_MAX_LENGTH = 96_000;
export const VNC_CLIENT_KEY_PEM_MAX_LENGTH = 24_000;

const nameSchema = z.string().trim().min(1).max(VNC_DISPLAY_NAME_MAX_LENGTH);
function boundedUtf8String(maxBytes: number, label: string) {
  return z
    .string()
    .refine((value) => {
      const length = new TextEncoder().encode(value).byteLength;
      return length >= 1 && length <= maxBytes;
    }, `${label} must be between 1 and ${maxBytes} UTF-8 bytes`)
    .refine((value) => {
      return !value.includes("\u0000");
    }, `${label} must not contain NUL`);
}

const vncPasswordAuthenticationVariantSchema = z
  .object({
    method: z.literal("vnc_password"),
    password: z
      .string()
      .min(1)
      .max(VNC_PASSWORD_MAX_LENGTH)
      .refine((value) => {
        return !/[^\x20-\x7e]/u.test(value);
      }, "VNC passwords require printable ASCII bytes"),
  })
  .strict();

// Keep the classic-only schema as a one-variant discriminated union for callers
// that intentionally accept only this profile.
export const vncPasswordAuthenticationSchema = z.discriminatedUnion("method", [
  vncPasswordAuthenticationVariantSchema,
]);

export const vncUsernamePasswordAuthenticationSchema = z
  .object({
    method: z.literal("username_password"),
    username: boundedUtf8String(VNC_USERNAME_MAX_BYTES, "VNC username"),
    password: boundedUtf8String(
      VNC_USERNAME_PASSWORD_MAX_BYTES,
      "VNC username/password password",
    ),
  })
  .strict();

// QEMU 8.2.2 SCRAM's exact ASCII input boundary: reject SASLprep-sensitive
// bytes before encryption instead of silently normalizing them in the engine.
const qemuScramUsernameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[\x21-\x2b\x2d-\x3c\x3e-\x7e]+$/u,
    "SCRAM username must be printable ASCII without space, comma or equals",
  );
const qemuScramPasswordSchema = z
  .string()
  .min(1)
  .max(VNC_USERNAME_PASSWORD_MAX_BYTES)
  .regex(/^[\x20-\x7e]+$/u, "SCRAM password must be printable ASCII");
export const vncQemuScramAuthenticationSchema = z
  .object({
    method: z.literal("qemu_scram_sha256"),
    username: qemuScramUsernameSchema,
    password: qemuScramPasswordSchema,
  })
  .strict();

export const vncAppleDhAuthenticationSchema = z
  .object({
    method: z.literal("apple_dh_username_password"),
    username: boundedUtf8String(APPLE_DH_FIELD_MAX_BYTES, "Apple DH username"),
    password: boundedUtf8String(APPLE_DH_FIELD_MAX_BYTES, "Apple DH password"),
  })
  .strict();

export const vncAppleSrpAuthenticationSchema = z
  .object({
    method: z.literal("apple_srp_username_password"),
    username: boundedUtf8String(VNC_USERNAME_MAX_BYTES, "Apple SRP username"),
    password: boundedUtf8String(
      VNC_USERNAME_PASSWORD_MAX_BYTES,
      "Apple SRP password",
    ),
  })
  .strict();

export const vncAppleRsaSrpAuthenticationSchema = z
  .object({
    method: z.literal("apple_rsa_srp_username_password"),
    username: boundedUtf8String(
      APPLE_RSA_SRP_USERNAME_MAX_BYTES,
      "Apple RSA/SRP username",
    ),
    password: boundedUtf8String(
      VNC_USERNAME_PASSWORD_MAX_BYTES,
      "Apple RSA/SRP password",
    ),
  })
  .strict();

const rsaAesFieldSchema = boundedUtf8String(
  VNC_RSA_AES_FIELD_MAX_BYTES,
  "RSA-AES field",
)
  .max(VNC_RSA_AES_FIELD_MAX_BYTES)
  .refine(
    (value) => {return !/[\uD800-\uDFFF]/u.test(value)},
    "RSA-AES fields require well-formed Unicode",
  );
export const vncRsaAesAuthenticationSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("rsa_aes_password"),
      password: rsaAesFieldSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("rsa_aes_username_password"),
      username: rsaAesFieldSchema,
      password: rsaAesFieldSchema,
    })
    .strict(),
]);

const clientIdentityInput = {
  certificateChain: z.string().min(1).max(VNC_CLIENT_CHAIN_PEM_MAX_LENGTH),
  privateKey: z.string().min(1).max(VNC_CLIENT_KEY_PEM_MAX_LENGTH),
} as const;

export const vncLegacyAuthenticationSchema = z.discriminatedUnion("method", [
  vncPasswordAuthenticationVariantSchema,
  vncUsernamePasswordAuthenticationSchema,
  vncAppleDhAuthenticationSchema,
  vncAppleSrpAuthenticationSchema,
  vncAppleRsaSrpAuthenticationSchema,
]);

export const vncAuthenticationSchema = z.discriminatedUnion("method", [
  ...vncLegacyAuthenticationSchema.options,
  vncQemuScramAuthenticationSchema,
  ...vncRsaAesAuthenticationSchema.options,
  z
    .object({ method: z.literal("client_certificate"), ...clientIdentityInput })
    .strict(),
  z
    .object({
      method: z.literal("client_certificate_vnc_password"),
      ...clientIdentityInput,
      password: vncPasswordAuthenticationVariantSchema.shape.password,
    })
    .strict(),
]);
const revisionSchema = z.int().positive().max(2_147_483_647);

export const createVncCredentialRequestSchema = z
  .object({ name: nameSchema, authentication: vncAuthenticationSchema })
  .strict();

export const updateVncCredentialRequestSchema = z
  .object({
    expectedRevision: revisionSchema,
    name: nameSchema.optional(),
    authentication: vncAuthenticationSchema.optional(),
  })
  .strict()
  .refine(
    (value) => {
      return value.name !== undefined || value.authentication !== undefined;
    },
    { message: "At least one VNC credential field must be updated" },
  );

export const vncCredentialSelectionSchema = z.union([
  z.object({ id: z.uuid() }).strict(),
  z.object({ create: createVncCredentialRequestSchema }).strict(),
]);

const vncCredentialResponseBase = {
  id: z.uuid(),
  name: z.string(),
  revision: revisionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  hosts: z.array(z.object({ id: z.uuid(), displayName: z.string() }).strict()),
} as const;

export const vncCredentialResponseSchema = z.discriminatedUnion("authMethod", [
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("rsa_aes_password"),
    })
    .strict(),
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("rsa_aes_username_password"),
      username: rsaAesFieldSchema,
    })
    .strict(),
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("client_certificate"),
    })
    .strict(),
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("client_certificate_vnc_password"),
    })
    .strict(),
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("vnc_password"),
    })
    .strict(),
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("username_password"),
      username: boundedUtf8String(VNC_USERNAME_MAX_BYTES, "VNC username"),
    })
    .strict(),
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("qemu_scram_sha256"),
      username: qemuScramUsernameSchema,
    })
    .strict(),
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("apple_dh_username_password"),
      username: boundedUtf8String(
        APPLE_DH_FIELD_MAX_BYTES,
        "Apple DH username",
      ),
    })
    .strict(),
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("apple_srp_username_password"),
      username: boundedUtf8String(VNC_USERNAME_MAX_BYTES, "Apple SRP username"),
    })
    .strict(),
  z
    .object({
      ...vncCredentialResponseBase,
      authMethod: z.literal("apple_rsa_srp_username_password"),
      username: boundedUtf8String(
        APPLE_RSA_SRP_USERNAME_MAX_BYTES,
        "Apple RSA/SRP username",
      ),
    })
    .strict(),
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
const pathParams = z.object({ credentialId: z.uuid() }).strict();

export const vncCredentialsContract = c.router({
  list: {
    method: "GET",
    path: "/api/vnc/credentials",
    headers: authHeadersSchema,
    responses: {
      200: z
        .object({ credentials: z.array(vncCredentialResponseSchema) })
        .strict(),
      ...errors,
    },
    summary: "List owned VNC credentials without secrets",
  },
  create: {
    method: "POST",
    path: "/api/vnc/credentials",
    headers: authHeadersSchema,
    body: createVncCredentialRequestSchema.extend({ id: z.uuid() }),
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
    body: z.object({ expectedRevision: revisionSchema }).strict(),
    responses: { 204: c.noBody(), ...errors },
    summary: "Delete an unused VNC credential",
  },
});

export type VncAuthentication = z.infer<typeof vncAuthenticationSchema>;
export type CreateVncCredentialRequest = z.infer<
  typeof createVncCredentialRequestSchema
>;
export type UpdateVncCredentialRequest = z.infer<
  typeof updateVncCredentialRequestSchema
>;
export type VncCredentialSelection = z.infer<
  typeof vncCredentialSelectionSchema
>;
export type VncCredentialResponse = z.infer<typeof vncCredentialResponseSchema>;
