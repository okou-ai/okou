import type { FirewallApi } from "@okouai/connectors/firewall-types";

import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";

/** Proxy-only marker; the API resolves the exact account outside the sandbox. */
const BUILTIN_MCP_AUTOMATIC_AUTH_HEADER = `Bearer \${{ secrets.MCP_ACCESS_TOKEN }}`;

export interface BuiltinConnectorMcpRuntimeAuth {
  readonly authOverride?: FirewallApi["auth"];
}

export function resolveBuiltinConnectorMcpRuntimeAuth(args: {
  readonly snapshot: ConnectorRuntimeSelection;
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly automaticAuthType: "none" | "oauth" | null;
}): BuiltinConnectorMcpRuntimeAuth | null {
  const connector = args.snapshot.connectors.get(args.connectorSlug);
  const method = connector?.methods.get(args.authMethodId);
  if (!connector?.catalogConnector.mcp || !method) {
    return null;
  }
  if (method.method.grant.kind !== "automatic") {
    // Runtime sync still publishes the plain builtin entry so reconnecting
    // away from Automatic removes a previous account auth override.
    return {};
  }
  if (args.automaticAuthType === null) {
    throw new Error(
      "Builtin Automatic account has no resolved MCP authentication",
    );
  }
  return {
    authOverride:
      args.automaticAuthType === "oauth"
        ? {
            headers: { Authorization: BUILTIN_MCP_AUTOMATIC_AUTH_HEADER },
          }
        : {},
  };
}
