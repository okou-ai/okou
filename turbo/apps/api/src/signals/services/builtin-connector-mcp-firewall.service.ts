import type { ExecutionFirewallInlineEntry } from "@okouai/connectors/firewall-types";

import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";

/** Proxy-only marker; the API resolves the exact account outside the sandbox. */
const BUILTIN_MCP_AUTOMATIC_AUTH_HEADER = `Bearer \${{ secrets.MCP_ACCESS_TOKEN }}`;

type BuiltinConnectorMcpRuntimeFirewall = ExecutionFirewallInlineEntry & {
  readonly sourceId: string;
  readonly customConnectorId?: never;
};

export function resolveBuiltinConnectorMcpRuntimeFirewall(args: {
  readonly snapshot: ConnectorRuntimeSelection;
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly sourceId: string;
}): BuiltinConnectorMcpRuntimeFirewall | null {
  const connector = args.snapshot.connectors.get(args.connectorSlug);
  const method = connector?.methods.get(args.authMethodId);
  if (!connector?.catalogConnector.mcp || !method) {
    return null;
  }
  if (method.method.grant.kind !== "automatic") {
    // A running account may have switched away from Automatic on reconnect.
    // Replace its previous inline auth with the current catalog configuration.
    const firewall = args.snapshot.serverFirewalls.getRuntimeFirewall(
      args.connectorSlug,
    );
    if (!firewall) {
      throw new Error("Builtin MCP connector has no catalog firewall");
    }
    return {
      kind: "inline",
      sourceId: args.sourceId,
      firewall: {
        ...firewall,
        apis: firewall.apis.map((api, index) => {
          return { ...api, id: `${args.connectorSlug}:${index}` };
        }),
      },
    };
  }
  if (args.automaticAuthType === null) {
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
          base: connector.catalogConnector.mcp.endpoint,
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
