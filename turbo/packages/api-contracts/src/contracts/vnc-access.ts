import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { sshHostAvailabilitySchema } from "./ssh-access";
import { vncConnectionMetadataSchema } from "./vnc-connections";
import {
  VNC_RSA_AES_SECURITY_TYPES,
  vncRsaAesAuthenticationMethodSchema,
} from "./vnc-rsa-aes";

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};

const vncHostBaseSchema = vncConnectionMetadataSchema
  .pick({
    id: true,
    displayName: true,
    host: true,
    port: true,
  })
  .extend({ availability: sshHostAvailabilitySchema });

export const vncHostSchema = z.union([
  vncHostBaseSchema
    .extend({
      authMethod: z.enum([
        "qemu_kerberos_ticket",
        "qemu_kerberos_keytab",
        "qemu_kerberos_password",
      ]),
      securityType: z.literal("qemu_x509_gssapi"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: vncRsaAesAuthenticationMethodSchema,
      securityType: z.enum(VNC_RSA_AES_SECURITY_TYPES),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("client_certificate"),
      securityType: z.literal("x509_none"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("client_certificate_vnc_password"),
      securityType: z.literal("x509_vnc"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("none"),
      securityType: z.literal("x509_none"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("vnc_password"),
      securityType: z.literal("x509_vnc"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("username_password"),
      securityType: z.literal("x509_plain"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("qemu_scram_sha256"),
      securityType: z.literal("qemu_x509_sasl"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("apple_dh_username_password"),
      securityType: z.literal("apple_dh"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("apple_srp_username_password"),
      securityType: z.literal("apple_srp"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("apple_rsa_srp_username_password"),
      securityType: z.literal("apple_rsa_srp"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: z.literal("vnc_password"),
      securityType: z.literal("apple_vnc_password"),
    })
    .strict(),
]);

export const vncHostsContract = c.router({
  list: {
    method: "GET",
    path: "/api/vnc/hosts",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ hosts: z.array(vncHostSchema) }).strict(),
      ...errors,
    },
    summary: "List current VNC hosts authorized for a running Agent",
  },
});
