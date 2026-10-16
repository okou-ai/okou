import type {
  RunnerVncCheckRequest,
  RunnerVncResolveResponse,
} from "@okouai/api-contracts/contracts/runner-vnc";
import { isVncKerberosMethod } from "@okouai/api-contracts/contracts/vnc-kerberos";
import { cloudflareAccessCredentialsSchema } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  tailscaleCredentialsSchema,
  tailscaleTagsSchema,
} from "@okouai/api-contracts/contracts/tailscale";
import type { CurrentVncAuthority } from "./runner-vnc-authority.service";
import {
  storedVncKdcMetadata,
  storedVncTransportMetadata,
} from "./vnc-stored-route";
import { decryptStoredSecretValue } from "./crypto.utils";
import { settle } from "../utils";

export type TransportSnapshot = RunnerVncCheckRequest["expectedTransport"];
export type ResolvedVncTransport = Extract<
  RunnerVncResolveResponse,
  { outcome: "resolved_transport" }
>["transport"];
export type ResolvedVncKdcTransport = NonNullable<
  Extract<
    Extract<
      RunnerVncResolveResponse,
      { outcome: "resolved_kerberos" }
    >["security"],
    { type: "qemu_x509_gssapi" }
  >["kdc"]
>["transport"];

function roleSnapshot(
  row: CurrentVncAuthority,
  role: "rfb" | "kdc",
): TransportSnapshot | null {
  const metadata =
    role === "rfb"
      ? storedVncTransportMetadata(row)
      : storedVncKdcMetadata(row);
  if (
    metadata === null ||
    ("needsRebind" in metadata && metadata.needsRebind)
  ) {
    return null;
  }
  if (metadata.type === "direct") {
    return metadata;
  }
  if (metadata.type === "ssh") {
    const generation =
      role === "rfb" ? row.sshGeneration : row.kdcSshGeneration;
    if (generation === null) {
      throw new Error("VNC SSH connection reference is missing");
    }
    return { ...metadata, generation };
  }
  const config =
    metadata.type === "cloudflare_access"
      ? role === "rfb"
        ? row.rfbAccess
        : row.kdcAccess
      : role === "rfb"
        ? row.rfbTailscale
        : row.kdcTailscale;
  if (
    config === null ||
    !("configId" in metadata) ||
    config.id !== metadata.configId
  ) {
    return null;
  }
  return {
    type: metadata.type,
    configId: config.id,
    generation: config.generation,
  };
}

export function storedTransportSnapshot(row: CurrentVncAuthority) {
  return roleSnapshot(row, "rfb");
}
export function storedKdcSnapshot(row: CurrentVncAuthority) {
  const snapshot = roleSnapshot(row, "kdc");
  if (
    !isVncKerberosMethod(row.authMethod) ||
    row.authMethod === "qemu_kerberos_ticket"
  ) {
    if (row.kdcTransportType !== null) {
      throw new Error("Unexpected stored VNC KDC route");
    }
    return null;
  }
  if (row.kdcTransportType === null) {
    throw new Error("Missing stored VNC KDC route");
  }
  return snapshot;
}
export function hasTransportAuthority(
  row: CurrentVncAuthority,
  transport: TransportSnapshot,
) {
  return (
    transport.type !== "ssh" || (row.sshNeedsRebind === false && row.sshAllowed)
  );
}
export function hasKdcAuthority(row: CurrentVncAuthority) {
  const snapshot = storedKdcSnapshot(row);
  if (
    !isVncKerberosMethod(row.authMethod) ||
    row.authMethod === "qemu_kerberos_ticket"
  ) {
    return snapshot === null;
  }
  return (
    snapshot !== null &&
    (snapshot.type !== "ssh" ||
      (row.kdcSshNeedsRebind === false && row.kdcSshAllowed))
  );
}
export function sameTransport(
  left: TransportSnapshot,
  right: TransportSnapshot,
) {
  switch (left.type) {
    case "direct": {
      return right.type === "direct";
    }
    case "ssh": {
      return (
        right.type === "ssh" &&
        left.connectionId === right.connectionId &&
        left.generation === right.generation
      );
    }
    case "cloudflare_access":
    case "tailscale": {
      return (
        left.type === right.type &&
        left.configId === right.configId &&
        left.generation === right.generation
      );
    }
  }
}
export function sameKdc(left: CurrentVncAuthority, right: CurrentVncAuthority) {
  const a = storedKdcSnapshot(left),
    b = storedKdcSnapshot(right);
  return a === null ? b === null : b !== null && sameTransport(a, b);
}

/** Called only after exact capability selection; errors never include provider values. */
export async function decryptVncRoleTransport(
  row: CurrentVncAuthority,
  role: "rfb" | "kdc",
  snapshot: TransportSnapshot,
  signal: AbortSignal,
): Promise<ResolvedVncKdcTransport> {
  if (snapshot.type === "direct" || snapshot.type === "ssh") {
    return snapshot;
  }
  const config =
    snapshot.type === "cloudflare_access"
      ? role === "rfb"
        ? row.rfbAccess
        : row.kdcAccess
      : role === "rfb"
        ? row.rfbTailscale
        : row.kdcTailscale;
  if (
    config === null ||
    config.id !== snapshot.configId ||
    config.generation !== snapshot.generation
  ) {
    throw new Error("Missing stored VNC network authority");
  }
  const clientId = await settle(
    decryptStoredSecretValue(config.encryptedClientId),
    signal,
  );
  if (!clientId.ok) {
    throw new Error("VNC network credential decryption failed");
  }
  signal.throwIfAborted();
  const clientSecret = await settle(
    decryptStoredSecretValue(config.encryptedClientSecret),
    signal,
  );
  if (!clientSecret.ok) {
    throw new Error("VNC network credential decryption failed");
  }
  signal.throwIfAborted();
  const credentials = {
    clientId: clientId.value,
    clientSecret: clientSecret.value,
  };
  if (snapshot.type === "cloudflare_access") {
    const parsed = cloudflareAccessCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      throw new Error("Invalid stored VNC network credentials");
    }
    return { ...snapshot, credentials: parsed.data };
  }
  const parsed = tailscaleCredentialsSchema.safeParse(credentials);
  const tailscale = role === "rfb" ? row.rfbTailscale : row.kdcTailscale;
  const tags = tailscaleTagsSchema.safeParse(tailscale?.tags);
  if (!parsed.success || !tags.success) {
    throw new Error("Invalid stored VNC network credentials or tags");
  }
  return { ...snapshot, credentials: parsed.data, tags: tags.data };
}
