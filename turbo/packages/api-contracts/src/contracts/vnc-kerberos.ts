import { z } from "zod";

export const KERBEROS_INPUT_MAX_BYTES = 65_536;
export const KERBEROS_INPUT_MAX_BASE64 = 87_384;
export const VNC_KERBEROS_VERSION_HEADER = "X-VNC-Profile-Version";
export const VNC_KERBEROS_VERSION = "kerberos-v1";

const encoder = new TextEncoder();
function validPart(value: string) {
  const length = encoder.encode(value).length;
  return (
    length >= 1 &&
    length <= 255 &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0);
      return (
        code !== undefined &&
        code > 31 &&
        !(code >= 127 && code <= 159) &&
        !(code >= 0xd800 && code <= 0xdfff)
      );
    })
  );
}

export const kerberosPrincipalSchema = z
  .object({
    realm: z.string().max(255).refine(validPart),
    components: z.array(z.string().max(255).refine(validPart)).min(1).max(8),
  })
  .strict()
  .refine((value) => {
    return (
      [value.realm, ...value.components].reduce((total, part) => {
        return total + encoder.encode(part).length;
      }, 0) <= 1024
    );
  });
export type KerberosPrincipal = z.infer<typeof kerberosPrincipalSchema>;

export function sameKerberosPrincipal(
  left: KerberosPrincipal,
  right: KerberosPrincipal,
) {
  return (
    left.realm === right.realm &&
    left.components.length === right.components.length &&
    left.components.every((part, index) => {
      return part === right.components[index];
    })
  );
}

export const kerberosServicePrincipalSchema = kerberosPrincipalSchema.refine(
  (value) => {
    return value.components.length === 2 && value.components[0] === "vnc";
  },
);

const materialSchema = z
  .string()
  .min(4)
  .max(KERBEROS_INPUT_MAX_BASE64)
  .base64();
const passwordSchema = z
  .string()
  .min(1)
  .max(1023)
  .refine((value) => {
    return (
      encoder.encode(value).length <= 1023 &&
      !value.includes(String.fromCharCode(0)) &&
      Array.from(value).every((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && !(code >= 0xd800 && code <= 0xdfff);
      })
    );
  });

export const vncKerberosAuthenticationSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("qemu_kerberos_ticket"),
      initiator: kerberosPrincipalSchema,
      service: kerberosServicePrincipalSchema,
      ticketCache: materialSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("qemu_kerberos_keytab"),
      initiator: kerberosPrincipalSchema,
      keytab: materialSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("qemu_kerberos_password"),
      initiator: kerberosPrincipalSchema,
      password: passwordSchema,
    })
    .strict(),
]);
export type VncKerberosAuthentication = z.infer<
  typeof vncKerberosAuthenticationSchema
>;
export type VncKerberosMethod = VncKerberosAuthentication["method"];
export function isVncKerberosMethod(
  method: string,
): method is VncKerberosMethod {
  return (
    method === "qemu_kerberos_ticket" ||
    method === "qemu_kerberos_keytab" ||
    method === "qemu_kerberos_password"
  );
}

export const kerberosKdcTransportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("direct") }).strict(),
  z.object({ type: z.literal("ssh"), connectionId: z.uuid() }).strict(),
]);
export const kerberosKdcSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.int().min(1).max(65_535),
    transport: kerberosKdcTransportSchema,
    ticketLifetimeSeconds: z.int().min(1).max(7200).default(1200),
    renewableLifetimeSeconds: z.int().min(0).max(7200).default(7200),
  })
  .strict();
export type KerberosKdc = z.infer<typeof kerberosKdcSchema>;
