import type { ConnectorDiscoveryAgentContext } from "./agent-context";
import {
  CALLBACK_PROMPT_GUIDANCE,
  connectorActionUrl,
  currentChatSupportsActionCallback,
  finalizeActionUrl,
} from "./action-url";
import {
  isConnectorDiscoveryAuthorized,
  type ConnectorDiscoveryDefinition,
  type ConnectorDiscoveryItem,
} from "./discovery";
import type { RunConnectorAccountLookup } from "./run-account-context";

export interface ConnectorSearchAction {
  readonly label: string;
  readonly path: string;
  readonly supportsCallback: boolean;
}

function accountSettingsAction(
  connector: Pick<ConnectorDiscoveryDefinition, "kind" | "slug" | "label">,
): ConnectorSearchAction {
  return {
    label: `Review ${connector.label} accounts and agent access`,
    path: "/connectors",
    supportsCallback: false,
  };
}

function connectAction(
  connector: Pick<ConnectorDiscoveryDefinition, "kind" | "slug" | "label">,
): ConnectorSearchAction {
  return connector.kind === "custom"
    ? accountSettingsAction(connector)
    : {
        label: `Connect or authorize ${connector.label}`,
        path: `/connectors/${connector.slug}/connect`,
        supportsCallback: true,
      };
}

export function runConnectorSearchAction(
  connector: Pick<ConnectorDiscoveryDefinition, "kind" | "slug" | "label">,
  lookup: RunConnectorAccountLookup,
): ConnectorSearchAction | null {
  switch (lookup.state) {
    case "available":
      if (lookup.metadata.connectionStatus !== "reconnect-required") {
        return null;
      }
      return connector.kind === "custom"
        ? accountSettingsAction(connector)
        : {
            label: `Reconnect ${connector.label} (${lookup.label})`,
            path: `/connectors/${connector.slug}/reconnect/${lookup.connectionId}`,
            supportsCallback: true,
          };
    case "not-admitted":
      return connectAction(connector);
    case "metadata-unavailable":
    case "context-unavailable":
      return accountSettingsAction(connector);
  }
}

export function currentConnectorSearchAction(
  connector: ConnectorDiscoveryItem,
  agentContext: ConnectorDiscoveryAgentContext | null,
): ConnectorSearchAction | null {
  const authorized =
    !agentContext || isConnectorDiscoveryAuthorized(connector, agentContext);
  if (connector.kind === "custom") {
    return connector.customConnector.connected && authorized
      ? null
      : accountSettingsAction(connector);
  }
  if (connector.catalogConnector.connectionStatus === "reconnect-required") {
    return accountSettingsAction(connector);
  }
  if (!connector.catalogConnector.connected) {
    return connectAction(connector);
  }
  return authorized
    ? null
    : {
        label: `Authorize ${connector.label}`,
        path: `/connectors/${connector.slug}/authorize`,
        supportsCallback: true,
      };
}

export function connectorSearchActionLinks(args: {
  readonly actions: readonly ConnectorSearchAction[];
  readonly origin: string;
  readonly agentId: string | undefined;
  readonly callbackPrompt: string | undefined;
}) {
  return args.actions.map((action) => {
    if (args.callbackPrompt !== undefined && !action.supportsCallback) {
      throw new Error(
        "This connector needs an account or access review in Connectors settings, which does not support --callback-prompt.",
      );
    }
    const url = connectorActionUrl({
      origin: args.origin,
      path: action.path,
      agentId: args.agentId,
    });
    return {
      label: action.label,
      url: finalizeActionUrl(new URL(url), args.callbackPrompt, args.agentId),
      supportsCallback: action.supportsCallback,
    };
  });
}

export function printConnectorSearchGuidance(args: {
  readonly actions: readonly ConnectorSearchAction[];
  readonly origin: string;
  readonly agentId: string | undefined;
  readonly runBound: boolean;
  readonly callbackPrompt: string | undefined;
}): void {
  if (args.actions.length === 0) {
    return;
  }
  const links = connectorSearchActionLinks(args);

  console.log("");
  console.log("Connection context:");
  console.log(
    "These services are supported by Okou. When a service is needed for the user's task, the connection links below let you help the user connect or authorize it now. The user completes sign-in or approval in Okou; credentials stay out of chat and private files can remain private.",
  );
  if (args.runBound) {
    console.log(
      '"Not admitted" means no account was selected for this run; it does not establish whether the user already has a connected account. Connector changes apply to future runs. The command okou connector account list <slug> --json shows existing account IDs, and okou connector account switch-request --help describes selecting one for this chat.',
    );
  }
  for (const link of links) {
    console.log(`  [${link.label}](${link.url})`);
  }

  if (args.callbackPrompt !== undefined) {
    console.log(
      "This link starts the next round in the current chat with the supplied prompt after the user completes the action. The current turn can end after sharing the exact link, including all query parameters; the connection is pending until the user completes it.",
    );
  } else if (
    currentChatSupportsActionCallback(args.agentId) &&
    args.actions.some((action) => {
      return action.supportsCallback;
    })
  ) {
    console.log(
      `When only one connector or permission action is needed, okou connector search <slug> --limit 1 --callback-prompt "<brief task and next step>" provides a link that continues this chat after the user completes the action. ${CALLBACK_PROMPT_GUIDANCE} Ordinary links support tasks that need multiple access actions.`,
    );
  }
}
