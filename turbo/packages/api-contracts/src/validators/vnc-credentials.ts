import {
  discriminatedUnion,
  int,
  literal,
  object,
  string,
  union,
  uuid,
} from "zod";

import { vncKerberosAuthenticationSchema } from "../contracts/vnc-kerberos";
import { VNC_RSA_AES_FIELD_MAX_BYTES } from "../contracts/vnc-rsa-aes";

export const VNC_DISPLAY_NAME_MAX_LENGTH = 128;
export const VNC_PASSWORD_MAX_LENGTH = 8;
export const VNC_USERNAME_MAX_BYTES = 255;
export const VNC_USERNAME_PASSWORD_MAX_BYTES = 1_023;
export const APPLE_DH_FIELD_MAX_BYTES = 63;
export const APPLE_RSA_SRP_USERNAME_MAX_BYTES = 234;
// PEM encodings are bounded separately from the DER limits enforced at the API and Runner.
export const VNC_CLIENT_CHAIN_PEM_MAX_LENGTH = 96_000;
export const VNC_CLIENT_KEY_PEM_MAX_LENGTH = 24_000;

const nameSchema = string().trim().min(1).max(VNC_DISPLAY_NAME_MAX_LENGTH);
export function boundedUtf8String(maxBytes: number, label: string) {
  return string()
    .refine((value) => {
      const length = new TextEncoder().encode(value).byteLength;
      return length >= 1 && length <= maxBytes;
    }, `${label} must be between 1 and ${maxBytes} UTF-8 bytes`)
    .refine((value) => {
      return !value.includes("\u0000");
    }, `${label} must not contain NUL`);
}

export const vncPasswordAuthenticationVariantSchema = object({
  method: literal("vnc_password"),
  password: string()
    .min(1)
    .max(VNC_PASSWORD_MAX_LENGTH)
    .refine((value) => {
      return !/[^\x20-\x7e]/u.test(value);
    }, "VNC passwords require printable ASCII bytes"),
}).strict();

export const vncUsernamePasswordAuthenticationSchema = object({
  method: literal("username_password"),
  username: boundedUtf8String(VNC_USERNAME_MAX_BYTES, "VNC username"),
  password: boundedUtf8String(
    VNC_USERNAME_PASSWORD_MAX_BYTES,
    "VNC username/password password",
  ),
}).strict();

// QEMU 8.2.2 SCRAM's exact ASCII input boundary: reject SASLprep-sensitive
// bytes before encryption instead of silently normalizing them in the engine.
export const qemuScramUsernameSchema = string()
  .min(1)
  .max(255)
  .regex(
    /^[\x21-\x2b\x2d-\x3c\x3e-\x7e]+$/u,
    "SCRAM username must be printable ASCII without space, comma or equals",
  );
const qemuScramPasswordSchema = string()
  .min(1)
  .max(VNC_USERNAME_PASSWORD_MAX_BYTES)
  .regex(/^[\x20-\x7e]+$/u, "SCRAM password must be printable ASCII");
export const vncQemuScramAuthenticationSchema = object({
  method: literal("qemu_scram_sha256"),
  username: qemuScramUsernameSchema,
  password: qemuScramPasswordSchema,
}).strict();

export const vncAppleDhAuthenticationSchema = object({
  method: literal("apple_dh_username_password"),
  username: boundedUtf8String(APPLE_DH_FIELD_MAX_BYTES, "Apple DH username"),
  password: boundedUtf8String(APPLE_DH_FIELD_MAX_BYTES, "Apple DH password"),
}).strict();

export const vncAppleSrpAuthenticationSchema = object({
  method: literal("apple_srp_username_password"),
  username: boundedUtf8String(VNC_USERNAME_MAX_BYTES, "Apple SRP username"),
  password: boundedUtf8String(
    VNC_USERNAME_PASSWORD_MAX_BYTES,
    "Apple SRP password",
  ),
}).strict();

export const vncAppleRsaSrpAuthenticationSchema = object({
  method: literal("apple_rsa_srp_username_password"),
  username: boundedUtf8String(
    APPLE_RSA_SRP_USERNAME_MAX_BYTES,
    "Apple RSA/SRP username",
  ),
  password: boundedUtf8String(
    VNC_USERNAME_PASSWORD_MAX_BYTES,
    "Apple RSA/SRP password",
  ),
}).strict();

export const rsaAesFieldSchema = boundedUtf8String(
  VNC_RSA_AES_FIELD_MAX_BYTES,
  "RSA-AES field",
)
  .max(VNC_RSA_AES_FIELD_MAX_BYTES)
  .refine((value) => {
    return !/[\uD800-\uDFFF]/u.test(value);
  }, "RSA-AES fields require well-formed Unicode");
export const vncRsaAesAuthenticationSchema = discriminatedUnion("method", [
  object({
    method: literal("rsa_aes_password"),
    password: rsaAesFieldSchema,
  }).strict(),
  object({
    method: literal("rsa_aes_username_password"),
    username: rsaAesFieldSchema,
    password: rsaAesFieldSchema,
  }).strict(),
]);

const clientIdentityInput = {
  certificateChain: string().min(1).max(VNC_CLIENT_CHAIN_PEM_MAX_LENGTH),
  privateKey: string().min(1).max(VNC_CLIENT_KEY_PEM_MAX_LENGTH),
} as const;

export const vncLegacyAuthenticationSchema = discriminatedUnion("method", [
  vncPasswordAuthenticationVariantSchema,
  vncUsernamePasswordAuthenticationSchema,
  vncAppleDhAuthenticationSchema,
  vncAppleSrpAuthenticationSchema,
  vncAppleRsaSrpAuthenticationSchema,
]);

export const vncAuthenticationSchema = discriminatedUnion("method", [
  ...vncLegacyAuthenticationSchema.options,
  ...vncKerberosAuthenticationSchema.options,
  vncQemuScramAuthenticationSchema,
  ...vncRsaAesAuthenticationSchema.options,
  object({
    method: literal("client_certificate"),
    ...clientIdentityInput,
  }).strict(),
  object({
    method: literal("client_certificate_vnc_password"),
    ...clientIdentityInput,
    password: vncPasswordAuthenticationVariantSchema.shape.password,
  }).strict(),
]);
export const revisionSchema = int().positive().max(2_147_483_647);

export const createVncCredentialRequestSchema = object({
  name: nameSchema,
  authentication: vncAuthenticationSchema,
}).strict();

export const updateVncCredentialRequestSchema = object({
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

export const vncCredentialSelectionSchema = union([
  object({ id: uuid() }).strict(),
  object({ create: createVncCredentialRequestSchema }).strict(),
]);
