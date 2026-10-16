import { isIP } from "node:net";
import {
  vncConnectionMetadataSchema,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncKdcTransportMetadataSchema,
  vncOriginTlsSchema,
  vncTransportMetadataSchema,
} from "@okouai/api-contracts/contracts/vnc-transport";
import {
  isVncRsaAesAuthenticationOnly,
  isVncRsaAesSecurityType,
} from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import {
  canonicalizeVncHost,
  prepareVncTrust,
} from "./vnc-configuration.utils";
import { canonicalTailscaleDestination } from "./tailscale-destination";

type StoredRoute = Pick<
  typeof vncConnections.$inferSelect,
  | "host"
  | "port"
  | "transportType"
  | "sshConnectionId"
  | "cloudflareAccessId"
  | "tailscaleId"
  | "originTlsServerName"
  | "originTlsTrustMode"
  | "originTlsCaBundle"
  | "kdcHost"
  | "kdcPort"
  | "kdcTransportType"
  | "kdcSshConnectionId"
  | "kdcCloudflareAccessId"
  | "kdcTailscaleId"
>;
type StoredSecurity = StoredRoute &
  Pick<
    typeof vncConnections.$inferSelect,
    | "securityType"
    | "trustMode"
    | "caBundle"
    | "x509ServerName"
    | "rsaServerKeySha256"
    | "kerberosService"
    | "kerberosTicketLifetimeSeconds"
    | "kerberosRenewableLifetimeSeconds"
  >;

function validateNativeDestination(
  type: StoredRoute["transportType"],
  host: string,
  port: number,
) {
  if (type === "tailscale") {
    if (canonicalTailscaleDestination(host) !== host) {
      throw new Error("Invalid stored native VNC peer target");
    }
  } else if (type === "cloudflare_access") {
    const canonical = canonicalizeVncHost(host);
    if (
      !canonical.ok ||
      canonical.value !== host ||
      isIP(host) !== 0 ||
      !host.includes(".") ||
      port !== 443
    ) {
      throw new Error("Invalid stored native VNC gateway target");
    }
  }
}

export function storedVncOriginTls(row: StoredRoute) {
  if (
    row.originTlsServerName === null &&
    row.originTlsTrustMode === null &&
    row.originTlsCaBundle === null
  ) {
    return null;
  }
  const parsed = vncOriginTlsSchema.safeParse({
    serverName: row.originTlsServerName,
    trust:
      row.originTlsTrustMode === "system"
        ? { mode: "system" }
        : { mode: row.originTlsTrustMode, caBundle: row.originTlsCaBundle },
  });
  if (
    !parsed.success ||
    row.transportType !== "cloudflare_access" ||
    (row.originTlsTrustMode === "system" && row.originTlsCaBundle !== null)
  ) {
    throw new Error("Invalid stored VNC origin TLS configuration");
  }
  const name = canonicalizeVncHost(parsed.data.serverName);
  const trust = prepareVncTrust(parsed.data.trust);
  if (!name.ok || name.value !== parsed.data.serverName || !trust.ok) {
    throw new Error("Invalid stored VNC origin TLS trust");
  }
  return parsed.data;
}

function validateStoredReferences(
  type: StoredRoute["transportType"],
  sshId: string | null,
  accessId: string | null,
  tailscaleId: string | null,
) {
  if (
    (type === "ssh") !== (sshId !== null) ||
    (type !== "cloudflare_access" && accessId !== null) ||
    (type !== "tailscale" && tailscaleId !== null)
  ) {
    throw new Error("Invalid stored VNC route references");
  }
}

export function storedVncTransportMetadata(row: StoredRoute) {
  validateStoredReferences(
    row.transportType,
    row.sshConnectionId,
    row.cloudflareAccessId,
    row.tailscaleId,
  );
  validateNativeDestination(row.transportType, row.host, row.port);
  const originTls = storedVncOriginTls(row);
  switch (row.transportType) {
    case "direct": {
      return vncTransportMetadataSchema.parse({ type: "direct" });
    }
    case "ssh": {
      return vncTransportMetadataSchema.parse({
        type: "ssh",
        connectionId: row.sshConnectionId,
      });
    }
    case "cloudflare_access": {
      return vncTransportMetadataSchema.parse({
        type: "cloudflare_access",
        ...(row.cloudflareAccessId === null
          ? { needsRebind: true }
          : { configId: row.cloudflareAccessId }),
        ...(originTls === null ? {} : { originTls }),
      });
    }
    case "tailscale": {
      return vncTransportMetadataSchema.parse({
        type: "tailscale",
        ...(row.tailscaleId === null
          ? { needsRebind: true }
          : { configId: row.tailscaleId }),
      });
    }
  }
}

export function storedVncKdcMetadata(row: StoredRoute) {
  if (row.kdcTransportType === null) {
    if (
      row.kdcHost !== null ||
      row.kdcPort !== null ||
      row.kdcSshConnectionId !== null ||
      row.kdcCloudflareAccessId !== null ||
      row.kdcTailscaleId !== null
    ) {
      throw new Error("Unexpected stored VNC KDC route");
    }
    return null;
  }
  if (row.kdcHost === null || row.kdcPort === null) {
    throw new Error("Missing stored VNC KDC target");
  }
  validateStoredReferences(
    row.kdcTransportType,
    row.kdcSshConnectionId,
    row.kdcCloudflareAccessId,
    row.kdcTailscaleId,
  );
  validateNativeDestination(row.kdcTransportType, row.kdcHost, row.kdcPort);
  switch (row.kdcTransportType) {
    case "direct": {
      return vncKdcTransportMetadataSchema.parse({ type: "direct" });
    }
    case "ssh": {
      if (row.kdcHost !== "127.0.0.1" && row.kdcHost !== "::1") {
        throw new Error("Invalid stored VNC KDC SSH target");
      }
      return vncKdcTransportMetadataSchema.parse({
        type: "ssh",
        connectionId: row.kdcSshConnectionId,
      });
    }
    case "cloudflare_access": {
      return vncKdcTransportMetadataSchema.parse({
        type: "cloudflare_access",
        ...(row.kdcCloudflareAccessId === null
          ? { needsRebind: true }
          : { configId: row.kdcCloudflareAccessId }),
      });
    }
    case "tailscale": {
      return vncKdcTransportMetadataSchema.parse({
        type: "tailscale",
        ...(row.kdcTailscaleId === null
          ? { needsRebind: true }
          : { configId: row.kdcTailscaleId }),
      });
    }
  }
}

export function hasProtectedVncRawRoute(row: StoredRoute) {
  return (
    (row.transportType === "ssh" &&
      (row.host === "127.0.0.1" || row.host === "::1")) ||
    row.transportType === "tailscale" ||
    (row.transportType === "cloudflare_access" &&
      storedVncOriginTls(row) !== null)
  );
}

function isAppleVncSecurityType(type: StoredSecurity["securityType"]) {
  return (
    type === "apple_vnc_password" ||
    type === "apple_dh" ||
    type === "apple_srp" ||
    type === "apple_rsa_srp"
  );
}

function validateStoredVncTrust(row: StoredSecurity) {
  const rawApple = isAppleVncSecurityType(row.securityType);
  const rsa = isVncRsaAesSecurityType(row.securityType);
  if (
    (rawApple || isVncRsaAesAuthenticationOnly(row.securityType)) &&
    !hasProtectedVncRawRoute(row)
  ) {
    throw new Error("Invalid stored VNC raw profile protection");
  }
  if (rawApple || rsa) {
    if (
      row.trustMode !== "none" ||
      row.caBundle !== null ||
      row.x509ServerName !== null ||
      (rsa ? row.rsaServerKeySha256 === null : row.rsaServerKeySha256 !== null)
    ) {
      throw new Error("Invalid stored VNC profile trust");
    }
  } else if (
    row.rsaServerKeySha256 !== null ||
    row.trustMode === "none" ||
    (row.trustMode === "system" ? row.caBundle !== null : row.caBundle === null)
  ) {
    throw new Error("Invalid stored VNC X509 trust");
  }
}

export function storedVncSecurity(
  row: StoredSecurity,
): VncConnectionResponse["security"] {
  validateStoredVncTrust(row);
  const rawApple = isAppleVncSecurityType(row.securityType);
  const rsa = isVncRsaAesSecurityType(row.securityType);
  const kdc = storedVncKdcMetadata(row);
  return vncConnectionMetadataSchema.shape.security.parse({
    type: row.securityType,
    ...(rsa ? { serverKeySha256: row.rsaServerKeySha256 } : {}),
    ...(rawApple || rsa
      ? {}
      : {
          trust:
            row.trustMode === "system"
              ? { mode: "system" }
              : { mode: row.trustMode, caBundle: row.caBundle },
          ...(row.x509ServerName === null
            ? {}
            : { serverName: row.x509ServerName }),
        }),
    ...(row.securityType !== "qemu_x509_gssapi"
      ? {}
      : {
          service: row.kerberosService,
          ...(kdc === null
            ? {}
            : {
                kdc: {
                  host: row.kdcHost,
                  port: row.kdcPort,
                  transport: kdc,
                  ticketLifetimeSeconds: row.kerberosTicketLifetimeSeconds,
                  renewableLifetimeSeconds:
                    row.kerberosRenewableLifetimeSeconds,
                },
              }),
        }),
  });
}
