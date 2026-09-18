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

export function builtinConnectorCredentialStatusWithMethod(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly automaticAuthType?: "none" | "oauth" | null;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
}): ConnectorCredentialStatus {
  if (builtinConnectorMethodNeedsNoCredentials(args)) {
    return "available";
  }
  if (
    args.method.grant.kind === "automatic" &&
    args.automaticAuthType !== "oauth"
  ) {
    return "reconnect-required";
  }
  return connectorCredentialStatusForAccess({
    storedNeedsReconnect: args.storedNeedsReconnect,
    tokenExpiresAt: args.tokenExpiresAt,
    now: args.now,
    isRefreshable: builtinConnectorAuthMethodSupportsRefreshWithMethod(
      args.method,
    ),
  });
}

export function builtinConnectorCredentialReconnectReasonWithMethod(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly automaticAuthType?: "none" | "oauth" | null;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
}): ConnectorReconnectReason | null {
  if (builtinConnectorMethodNeedsNoCredentials(args)) {
    return null;
  }
  const credentialStatus = connectorCredentialStatusForAccess({
    storedNeedsReconnect: args.storedNeedsReconnect,
    tokenExpiresAt: args.tokenExpiresAt,
    now: args.now,
    isRefreshable: builtinConnectorAuthMethodSupportsRefreshWithMethod(
      args.method,
    ),
  });
  if (
    credentialStatus !== "reconnect-required" ||
    args.storedNeedsReconnect ||
    args.tokenExpiresAt === null ||
    builtinConnectorAuthMethodSupportsRefreshWithMethod(args.method)
  ) {
    return null;
  }
  return "credential_expired";
}

export function builtinConnectorRuntimeCredentialStatusWithMethod(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly automaticAuthType?: "none" | "oauth" | null;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
}): ConnectorCredentialStatus {
  if (builtinConnectorMethodNeedsNoCredentials(args)) {
    return "available";
  }
  if (
    args.method.grant.kind === "automatic" &&
    args.automaticAuthType !== "oauth"
  ) {
    return "reconnect-required";
  }
  return connectorRuntimeCredentialStatusForAccess({
    storedNeedsReconnect: args.storedNeedsReconnect,
    tokenExpiresAt: args.tokenExpiresAt,
    now: args.now,
    isRefreshable: builtinConnectorAuthMethodSupportsRefreshWithMethod(
      args.method,
    ),
  });
}

function builtinConnectorAuthMethodSupportsRefreshWithMethod(
  method: ConnectorAuthMethodRuntimeConfig,
): boolean {
  return (
    method.access.kind === "refresh-token" || method.access.kind === "automatic"
  );
}

function builtinConnectorMethodNeedsNoCredentials(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly automaticAuthType?: "none" | "oauth" | null;
}): boolean {
  return (
    args.method.grant.kind === "none" ||
    (args.method.grant.kind === "automatic" &&
      args.automaticAuthType === "none")
  );
}
