import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { getCustomConnector } from "../../lib/api/domains/connectors";
import { connectorAccountCliInventoryLabel } from "./account-label";
import {
  memberConnectorStatusText,
  readMemberAccountFacts,
  readMemberConnectorFacts,
  type MemberConnectorFacts,
} from "./member-status";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountLookups,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountLookup,
} from "./run-account-context";
import { customConnectorSettingsGuidance } from "./custom-connector-guidance";

type CustomConnectorCheckContext = {
  readonly id: string;
  readonly label: string;
  readonly definitionAvailable: boolean;
} & (
  | { readonly kind: "run"; readonly account: RunConnectorAccountLookup }
  | {
      readonly kind: "current";
      readonly facts: MemberConnectorFacts;
      readonly definition: CustomConnectorResponse | null;
    }
);

export async function loadCustomConnectorCheckContext(
  customConnectorId: string,
): Promise<CustomConnectorCheckContext> {
  const target = { kind: "custom", customConnectorId } as const;
  const runBound = isRunBoundConnectorContext();
  const [definition, accounts] = await Promise.all([
    getCustomConnector(customConnectorId),
    runBound ? resolveRunConnectorAccountLookups([target]) : null,
  ]);
  const context = {
    id: customConnectorId,
    label: definition?.displayName ?? customConnectorId,
    definitionAvailable: definition !== null,
  };
  if (accounts !== null) {
    const account = accounts[0];
    if (!account) {
      throw new Error("Missing run account lookup for custom connector");
    }
    return { ...context, kind: "run", account };
  }
  const facts =
    definition === null
      ? await readMemberAccountFacts(target)
      : await readMemberConnectorFacts(definition);
  return { ...context, kind: "current", facts, definition };
}

function printCurrentCustomConnectorStatus(
  context: Extract<CustomConnectorCheckContext, { kind: "current" }>,
): boolean {
  const { facts, definition } = context;
  if (facts.integrationManaged) {
    if (
      definition === null ||
      !isIntegrationManagedCustomConnector(definition)
    ) {
      throw new Error("Missing managed custom connector definition");
    }
    console.log(
      `Current integration status: ${memberConnectorStatusText(facts)}.`,
    );
    if (definition.connectedAccountId) {
      console.log(
        `Integration connection ID: ${definition.connectedAccountId}`,
      );
    }
    if (definition.missingRequiredFields.length > 0) {
      console.log(
        `Missing required configuration: ${definition.missingRequiredFields.join(", ")}`,
      );
    }
    return !definition.connected || definition.missingRequiredFields.length > 0;
  }
  console.log(`Current account status: ${memberConnectorStatusText(facts)}.`);
  const account = facts.accountSummary?.defaultConnection;
  if (account) {
    console.log(
      `Current default account: ${connectorAccountCliInventoryLabel({ ...account, connectionId: account.id })}`,
    );
    console.log(`Default connection ID: ${account.id}`);
    if (account.reconnectReason) {
      console.log(`Reconnect reason: ${account.reconnectReason}`);
    }
    if (account.missingRequiredFields.length > 0) {
      console.log(
        `Missing required configuration: ${account.missingRequiredFields.join(", ")}`,
      );
    }
  }
  return facts.memberStatus !== "connected";
}

function printRunCustomConnectorStatus(
  context: Extract<CustomConnectorCheckContext, { kind: "run" }>,
): boolean {
  const account = context.account;
  switch (account.state) {
    case "context-unavailable":
      console.log(runConnectorAccountUnavailableMessage(account.reason));
      break;
    case "not-admitted":
      console.log(`No ${context.label} account was admitted for this run.`);
      console.log("Select an available account, then start a new run.");
      break;
    case "metadata-unavailable":
      console.log(`Account used by this run: ${account.connectionId}`);
      console.log("Current account metadata is unavailable or deleted.");
      console.log("Select an available account, then start a new run.");
      break;
    case "available":
      console.log(`Account used by this run: ${account.label}`);
      console.log(`Connection ID: ${account.connectionId}`);
      if (account.metadata.reconnectReason) {
        console.log(`Reconnect reason: ${account.metadata.reconnectReason}`);
      }
      if (account.metadata.missingRequiredFields.length > 0) {
        console.log(
          `Missing required configuration: ${account.metadata.missingRequiredFields.join(", ")}`,
        );
      }
      if (account.metadata.connectionStatus === "reconnect-required") {
        console.log(
          "The account selected for this run needs to be reconnected.",
        );
        console.log("After reconnecting, start a new run.");
      } else {
        console.log("The account selected for this run is connected.");
      }
      break;
  }
  return (
    account.state !== "available" ||
    account.metadata.connectionStatus === "reconnect-required"
  );
}

export function printCustomConnectorCheckStatus(
  context: CustomConnectorCheckContext,
  platformOrigin: string,
): void {
  console.log("## Step 2: Custom connector configuration");
  console.log("");
  if (!context.definitionAvailable) {
    console.log("Current custom connector metadata is unavailable or deleted.");
  }
  const needsReview =
    context.kind === "run"
      ? printRunCustomConnectorStatus(context)
      : printCurrentCustomConnectorStatus(context);
  if (!context.definitionAvailable || needsReview) {
    console.log(customConnectorSettingsGuidance(context.id, platformOrigin));
  }
  if (context.kind === "run") {
    console.log(
      "Routing and permission diagnostics describe current intended state; they do not confirm that the runner has applied the latest update.",
    );
  }
  console.log("");
}
