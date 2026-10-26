import { array, literal, object, union, enum as zEnum } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { sshHostAvailabilitySchema } from "./ssh-access";
import { remoteHostIdentitySchema } from "./remote-host-identity";
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

export const vncHostSchema = union([
  vncHostBaseSchema
    .extend({
      authMethod: zEnum([
        "qemu_kerberos_ticket",
        "qemu_kerberos_keytab",
        "qemu_kerberos_password",
      ]),
      securityType: literal("qemu_x509_gssapi"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: vncRsaAesAuthenticationMethodSchema,
      securityType: zEnum(VNC_RSA_AES_SECURITY_TYPES),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("client_certificate"),
      securityType: literal("x509_none"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("client_certificate_vnc_password"),
      securityType: literal("x509_vnc"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("none"),
      securityType: literal("x509_none"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("vnc_password"),
      securityType: literal("x509_vnc"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("username_password"),
      securityType: literal("x509_plain"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("qemu_scram_sha256"),
      securityType: literal("qemu_x509_sasl"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("apple_dh_username_password"),
      securityType: literal("apple_dh"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("apple_srp_username_password"),
      securityType: literal("apple_srp"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("apple_rsa_srp_username_password"),
      securityType: literal("apple_rsa_srp"),
    })
    .strict(),
  vncHostBaseSchema
    .extend({
      authMethod: literal("vnc_password"),
      securityType: literal("apple_vnc_password"),
    })
    .strict(),
]);

export const vncHostsContract = c.router({
  list: {
    method: "GET",
    path: "/api/vnc/hosts",
    headers: authHeadersSchema,
    responses: {
      200: object({
        hosts: array(vncHostSchema),
        identities: array(remoteHostIdentitySchema),
      }).strict(),
      ...errors,
    },
    summary: "List current VNC hosts authorized for a running Agent",
  },
});
