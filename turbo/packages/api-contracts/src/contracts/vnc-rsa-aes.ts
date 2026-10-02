import { z } from "zod";

export const VNC_RSA_AES_FIELD_MAX_BYTES = 255;
export const VNC_RSA_PUBLIC_KEY_MAX_BYTES = 16_384;
export const VNC_RSA_AES_SECURITY_TYPES = [
  "rsa_aes_ra2",
  "rsa_aes_ra2_256",
  "rsa_aes_ra2ne",
  "rsa_aes_ra2ne_256",
] as const;
export type VncRsaAesSecurityType = (typeof VNC_RSA_AES_SECURITY_TYPES)[number];
export function isVncRsaAesSecurityType(
  value: unknown,
): value is VncRsaAesSecurityType {
  return (
    value === "rsa_aes_ra2" ||
    value === "rsa_aes_ra2_256" ||
    value === "rsa_aes_ra2ne" ||
    value === "rsa_aes_ra2ne_256"
  );
}
export function isVncRsaAesAuthenticationOnly(value: unknown): boolean {
  return value === "rsa_aes_ra2ne" || value === "rsa_aes_ra2ne_256";
}
export const vncRsaServerKeyPinSchema = z.string().regex(/^[a-fA-F0-9]{64}$/u);
export const vncRsaAesAuthenticationMethodSchema = z.enum([
  "rsa_aes_password",
  "rsa_aes_username_password",
]);
export const vncRsaAesSecuritySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("rsa_aes_ra2"),
      serverKeySha256: vncRsaServerKeyPinSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("rsa_aes_ra2_256"),
      serverKeySha256: vncRsaServerKeyPinSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("rsa_aes_ra2ne"),
      serverKeySha256: vncRsaServerKeyPinSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("rsa_aes_ra2ne_256"),
      serverKeySha256: vncRsaServerKeyPinSchema,
    })
    .strict(),
]);
