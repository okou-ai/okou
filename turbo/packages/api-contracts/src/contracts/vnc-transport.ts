import {
  array,
  discriminatedUnion,
  literal,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
} from "zod";

export const VNC_HOST_MAX_LENGTH = 253;
export const VNC_CA_BUNDLE_MAX_LENGTH = 65_536;
export const VNC_CA_CERTIFICATES_MAX_COUNT = 8;

export const vncTrustSchema = discriminatedUnion("mode", [
  object({ mode: literal("system") }).strict(),
  object({
    mode: literal("custom_ca"),
    caBundle: string().min(1).max(VNC_CA_BUNDLE_MAX_LENGTH),
  }).strict(),
]);

/** Independent outer TLS identity; never inferred from the gateway or inner RFB trust. */
export const vncOriginTlsSchema = object({
  serverName: string().min(1).max(VNC_HOST_MAX_LENGTH),
  trust: vncTrustSchema,
}).strict();

const direct = object({ type: literal("direct") }).strict();
const ssh = object({ type: literal("ssh"), connectionId: uuid() }).strict();
const access = object({
  type: literal("cloudflare_access"),
  configId: uuid(),
}).strict();
const detachedAccess = object({
  type: literal("cloudflare_access"),
  needsRebind: literal(true),
}).strict();
const tailscale = object({
  type: literal("tailscale"),
  configId: uuid(),
}).strict();
const detachedTailscale = object({
  type: literal("tailscale"),
  needsRebind: literal(true),
}).strict();

/** Owner input requires an explicit binding; detached shapes are metadata only. */
export const vncKdcTransportSchema = discriminatedUnion("type", [
  direct,
  ssh,
  access,
  tailscale,
]);
export const vncTransportSchema = discriminatedUnion("type", [
  direct,
  ssh,
  access.extend({ originTls: vncOriginTlsSchema.optional() }),
  tailscale,
]);

export const vncKdcTransportMetadataSchema = union([
  direct,
  ssh,
  access,
  detachedAccess,
  tailscale,
  detachedTailscale,
]);
export const vncTransportMetadataSchema = union([
  direct,
  ssh,
  access.extend({ originTls: vncOriginTlsSchema.optional() }),
  detachedAccess.extend({ originTls: vncOriginTlsSchema.optional() }),
  tailscale,
  detachedTailscale,
]);

export const vncNetworkHostReferenceSchema = object({
  id: uuid(),
  displayName: string(),
  roles: array(zEnum(["rfb", "kdc"]))
    .min(1)
    .max(2)
    .refine((roles) => {
      return new Set(roles).size === roles.length;
    }),
}).strict();
