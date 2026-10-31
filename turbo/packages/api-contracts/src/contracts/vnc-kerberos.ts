import {
  array,
  base64,
  discriminatedUnion,
  int,
  literal,
  object,
  string,
  type infer as zInfer,
} from "zod";

import {
  vncKdcTransportMetadataSchema,
  vncKdcTransportSchema,
} from "./vnc-transport";

export const KERBEROS_INPUT_MAX_BYTES = 65_536;
export const KERBEROS_INPUT_MAX_BASE64 = 87_384;

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

export const kerberosPrincipalSchema = object({
  realm: string().max(255).refine(validPart),
  components: array(string().max(255).refine(validPart)).min(1).max(8),
})
  .strict()
  .refine((value) => {
    return (
      [value.realm, ...value.components].reduce((total, part) => {
        return total + encoder.encode(part).length;
      }, 0) <= 1024
    );
  });
export type KerberosPrincipal = zInfer<typeof kerberosPrincipalSchema>;

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

const materialSchema = string()
  .min(4)
  .max(KERBEROS_INPUT_MAX_BASE64)
  .check(base64());
const passwordSchema = string()
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

export const vncKerberosAuthenticationSchema = discriminatedUnion("method", [
  object({
    method: literal("qemu_kerberos_ticket"),
    initiator: kerberosPrincipalSchema,
    service: kerberosServicePrincipalSchema,
    ticketCache: materialSchema,
  }).strict(),
  object({
    method: literal("qemu_kerberos_keytab"),
    initiator: kerberosPrincipalSchema,
    keytab: materialSchema,
  }).strict(),
  object({
    method: literal("qemu_kerberos_password"),
    initiator: kerberosPrincipalSchema,
    password: passwordSchema,
  }).strict(),
]);
export type VncKerberosAuthentication = zInfer<
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

export const kerberosKdcTransportSchema = vncKdcTransportSchema;
export const kerberosKdcSchema = object({
  host: string().min(1).max(253),
  port: int().min(1).max(65_535),
  transport: kerberosKdcTransportSchema,
  ticketLifetimeSeconds: int().min(1).max(7200).default(1200),
  renewableLifetimeSeconds: int().min(0).max(7200).default(7200),
}).strict();
export type KerberosKdc = zInfer<typeof kerberosKdcSchema>;

export const kerberosKdcMetadataSchema = kerberosKdcSchema.extend({
  transport: vncKdcTransportMetadataSchema,
});
