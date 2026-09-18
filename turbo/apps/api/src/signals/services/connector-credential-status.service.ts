import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";
import type { ConnectorReconnectReason } from "@okouai/api-contracts/contracts/connector-schemas";

export type ConnectorCredentialStatus = "available" | "reconnect-required";

export function connectorCredentialStatusForAccess(args: {
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
  readonly isRefreshable: boolean;
}): ConnectorCredentialStatus {
  if (args.storedNeedsReconnect) {
    return "reconnect-required";
  }
  if (args.tokenExpiresAt === null) {
    return "available";
  }
  if (args.isRefreshable) {
    return "available";
  }
  return args.tokenExpiresAt.getTime() <= args.now.getTime()
    ? "reconnect-required"
    : "available";
}

export function connectorRuntimeCredentialStatusForAccess(args: {
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
  readonly isRefreshable: boolean;
}): ConnectorCredentialStatus {
  if (args.isRefreshable) {
    return "available";
  }
  return connectorCredentialStatusForAccess(args);
}

export function connectorCredentialStatusWithMethod(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
}): ConnectorCredentialStatus {
  if (args.method.grant.kind === "none") {
    return "available";
  }
  return connectorCredentialStatusForAccess({
    storedNeedsReconnect: args.storedNeedsReconnect,
    tokenExpiresAt: args.tokenExpiresAt,
    now: args.now,
    isRefreshable: connectorAuthMethodSupportsRefreshWithMethod(args.method),
  });
}

export function connectorCredentialReconnectReasonWithMethod(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
}): ConnectorReconnectReason | null {
  if (args.method.grant.kind === "none") {
    return null;
  }
  const credentialStatus = connectorCredentialStatusForAccess({
    storedNeedsReconnect: args.storedNeedsReconnect,
    tokenExpiresAt: args.tokenExpiresAt,
    now: args.now,
    isRefreshable: connectorAuthMethodSupportsRefreshWithMethod(args.method),
  });
  if (
    credentialStatus !== "reconnect-required" ||
    args.storedNeedsReconnect ||
    args.tokenExpiresAt === null ||
    connectorAuthMethodSupportsRefreshWithMethod(args.method)
  ) {
    return null;
  }
  return "credential_expired";
}

export function connectorRuntimeCredentialStatusWithMethod(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
}): ConnectorCredentialStatus {
  if (args.method.grant.kind === "none") {
    return "available";
  }
  return connectorRuntimeCredentialStatusForAccess({
    storedNeedsReconnect: args.storedNeedsReconnect,
    tokenExpiresAt: args.tokenExpiresAt,
    now: args.now,
    isRefreshable: connectorAuthMethodSupportsRefreshWithMethod(args.method),
  });
}

function connectorAuthMethodSupportsRefreshWithMethod(
  method: ConnectorAuthMethodRuntimeConfig,
): boolean {
  return method.access.kind === "refresh-token";
}
