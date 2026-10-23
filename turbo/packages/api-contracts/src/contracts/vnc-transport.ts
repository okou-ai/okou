import * as z from "zod";

export const VNC_HOST_MAX_LENGTH = 253;
export const VNC_CA_BUNDLE_MAX_LENGTH = 65_536;
export const VNC_CA_CERTIFICATES_MAX_COUNT = 8;

export const vncTrustSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("system") }).strict(),
  z
    .object({
      mode: z.literal("custom_ca"),
      caBundle: z.string().min(1).max(VNC_CA_BUNDLE_MAX_LENGTH),
    })
    .strict(),
]);

/** Independent outer TLS identity; never inferred from the gateway or inner RFB trust. */
export const vncOriginTlsSchema = z
  .object({
    serverName: z.string().min(1).max(VNC_HOST_MAX_LENGTH),
    trust: vncTrustSchema,
  })
  .strict();

const direct = z.object({ type: z.literal("direct") }).strict();
const ssh = z
  .object({ type: z.literal("ssh"), connectionId: z.uuid() })
  .strict();
const access = z
  .object({ type: z.literal("cloudflare_access"), configId: z.uuid() })
  .strict();
const detachedAccess = z
  .object({
    type: z.literal("cloudflare_access"),
    needsRebind: z.literal(true),
  })
  .strict();
const tailscale = z
  .object({ type: z.literal("tailscale"), configId: z.uuid() })
  .strict();
const detachedTailscale = z
  .object({ type: z.literal("tailscale"), needsRebind: z.literal(true) })
  .strict();

/** Owner input requires an explicit binding; detached shapes are metadata only. */
export const vncKdcTransportSchema = z.discriminatedUnion("type", [
  direct,
  ssh,
  access,
  tailscale,
]);
export const vncTransportSchema = z.discriminatedUnion("type", [
  direct,
  ssh,
  access.extend({ originTls: vncOriginTlsSchema.optional() }),
  tailscale,
]);

export const vncKdcTransportMetadataSchema = z.union([
  direct,
  ssh,
  access,
  detachedAccess,
  tailscale,
  detachedTailscale,
]);
export const vncTransportMetadataSchema = z.union([
  direct,
  ssh,
  access.extend({ originTls: vncOriginTlsSchema.optional() }),
  detachedAccess.extend({ originTls: vncOriginTlsSchema.optional() }),
  tailscale,
  detachedTailscale,
]);

export const vncNetworkHostReferenceSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    roles: z
      .array(z.enum(["rfb", "kdc"]))
      .min(1)
      .max(2)
      .refine((roles) => {
        return new Set(roles).size === roles.length;
      }),
  })
  .strict();
