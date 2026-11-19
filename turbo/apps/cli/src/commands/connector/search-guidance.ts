import type { ConnectedConnectors } from "@okouai/api-contracts/contracts/connected-connectors";
import {
  CALLBACK_PROMPT_GUIDANCE,
  connectorActionUrl,
  currentChatSupportsActionCallback,
  finalizeActionUrl,
} from "./action-url";
import {
  connectorHasSavedAccounts,
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
    label: `Review ${connector.label} accounts`,
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
        label: `Connect ${connector.label}`,
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
  directory: ConnectedConnectors,
): ConnectorSearchAction {
  return connectorHasSavedAccounts(connector, directory)
    ? accountSettingsAction(connector)
    : connectAction(connector);
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
    "These services are supported by Okou. When a service is needed for the user's task, the connection links below open account setup in Okou. The user completes sign-in there; credentials stay out of chat and private files can remain private.",
  );
  if (args.runBound) {
    console.log(
      "Run okou connector account list <slug> --json to inspect this Chat's accounts. Switch an enabled account with okou connector account switch. For a disabled account, use okou connector account switch-request to get owner approval.",
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
