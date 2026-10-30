import {
  discriminatedUnion,
  int,
  literal,
  object,
  string,
  union,
  uuid,
} from "zod";

import {
  kerberosKdcSchema,
  kerberosServicePrincipalSchema,
} from "../contracts/vnc-kerberos";
import {
  VNC_DISPLAY_NAME_MAX_LENGTH,
  vncCredentialSelectionSchema,
} from "./vnc-credentials";
import { vncRsaAesSecuritySchema } from "../contracts/vnc-rsa-aes";
import {
  VNC_HOST_MAX_LENGTH,
  vncTrustSchema,
  vncTransportSchema,
} from "../contracts/vnc-transport";

const displayNameSchema = string()
  .trim()
  .min(1)
  .max(VNC_DISPLAY_NAME_MAX_LENGTH);
const hostSchema = string().min(1).max(VNC_HOST_MAX_LENGTH);
export const portSchema = int().min(1).max(65_535);
export const generationSchema = int().positive().max(2_147_483_647);

export const vncX509NoneSecurityVariantSchema = object({
  type: literal("x509_none"),
  trust: vncTrustSchema,
  serverName: hostSchema.optional(),
}).strict();
export const vncX509VncSecurityVariantSchema = object({
  type: literal("x509_vnc"),
  trust: vncTrustSchema,
  serverName: hostSchema.optional(),
}).strict();
export const vncX509PlainSecurityVariantSchema = object({
  type: literal("x509_plain"),
  trust: vncTrustSchema,
  serverName: hostSchema.optional(),
}).strict();
export const vncQemuX509SaslSecurityVariantSchema = object({
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
export const vncAppleVncPasswordSecurityVariantSchema = object({
  type: literal("apple_vnc_password"),
}).strict();
export const vncAppleDhSecurityVariantSchema = object({
  type: literal("apple_dh"),
}).strict();
export const vncAppleSrpSecurityVariantSchema = object({
  type: literal("apple_srp"),
}).strict();
export const vncAppleRsaSrpSecurityVariantSchema = object({
  type: literal("apple_rsa_srp"),
}).strict();
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
