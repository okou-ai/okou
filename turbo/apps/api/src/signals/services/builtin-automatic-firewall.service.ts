import type { ExecutionFirewallInlineEntry } from "@okouai/connectors/firewall-types";

import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";

/** Proxy-only marker; the API resolves the exact account outside the sandbox. */
const BUILTIN_MCP_AUTOMATIC_AUTH_HEADER = `Bearer \${{ secrets.BUILTIN_MCP_ACCESS_TOKEN }}`;

type BuiltinAutomaticRuntimeFirewall = ExecutionFirewallInlineEntry & {
  readonly sourceId: string;
  readonly customConnectorId?: never;
};

export function resolveBuiltinAutomaticRuntimeFirewall(args: {
  readonly snapshot: ConnectorRuntimeSelection;
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly sourceId: string;
}): BuiltinAutomaticRuntimeFirewall | null {
  const connector = args.snapshot.connectors.get(args.connectorSlug);
  const method = connector?.methods.get(args.authMethodId);
  if (method?.method.grant.kind !== "automatic") {
    return null;
  }
  const mcp = connector?.catalogConnector.mcp;
  if (!mcp || args.automaticAuthType === null) {
    throw new Error(
      "Builtin Automatic account has no resolved MCP authentication",
    );
  }
  return {
    kind: "inline",
    sourceId: args.sourceId,
    firewall: {
      name: args.connectorSlug,
      apis: [
        {
          id: `${args.connectorSlug}:0`,
          base: mcp.endpoint,
          auth:
            args.automaticAuthType === "oauth"
              ? {
                  headers: { Authorization: BUILTIN_MCP_AUTOMATIC_AUTH_HEADER },
                }
              : {},
          permissions: [],
        },
      ],
    },
  };
}
