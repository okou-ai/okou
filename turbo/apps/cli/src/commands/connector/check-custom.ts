import { getCustomConnector } from "../../lib/api/domains/connectors";
import {
  resolveRunConnectorAccountLookups,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountLookup,
} from "./run-account-context";
import { customConnectorSettingsGuidance } from "./custom-connector-guidance";

interface CustomConnectorCheckContext {
  readonly id: string;
  readonly label: string;
  readonly definitionAvailable: boolean;
  readonly account: RunConnectorAccountLookup;
}

export async function loadCustomConnectorCheckContext(
  customConnectorId: string,
): Promise<CustomConnectorCheckContext> {
  const [definition, accounts] = await Promise.all([
    getCustomConnector(customConnectorId),
    resolveRunConnectorAccountLookups([{ kind: "custom", customConnectorId }]),
  ]);
  const account = accounts[0];
  if (!account) {
    throw new Error("Missing run account lookup for custom connector");
  }
  return {
    id: customConnectorId,
    label: definition?.displayName ?? customConnectorId,
    definitionAvailable: definition !== null,
    account,
  };
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
      console.log(`Setup status: ${account.metadata.setupStatus}`);
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
      } else if (account.metadata.setupStatus !== "complete") {
        console.log(
          "The account selected for this run requires configuration review.",
        );
        console.log("After updating the account, start a new run.");
      } else {
        console.log("The account selected for this run is connected.");
      }
      break;
  }
  if (
    !context.definitionAvailable ||
    account.state !== "available" ||
    account.metadata.connectionStatus === "reconnect-required" ||
    account.metadata.setupStatus !== "complete"
  ) {
    console.log(customConnectorSettingsGuidance(context.id, platformOrigin));
  }
  console.log(
    "Routing and permission diagnostics describe current intended state; they do not confirm that the runner has applied the latest update.",
  );
  console.log("");
}
