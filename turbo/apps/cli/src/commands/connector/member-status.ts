import {
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
  builtinConnectorAccountFacts,
  connectorAccountTargetKey,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  listConnectorAccountConnections,
  type ConnectorAccountConnectionsResult,
  type ConnectorCatalogStatus,
} from "../../lib/api/domains/connectors";
import { connectorAccountCliInventoryLabel } from "./account-label";

export type MemberConnector = ConnectorCatalogStatus | CustomConnectorResponse;

type MemberConnectionStatus =
  | "unavailable"
  | "not-connected"
  | "default-required"
  | "reconnect-required"
  | "setup-required"
  | "account-review-required"
  | "connected";

export interface MemberConnectorFacts {
  readonly scopeMismatch?: boolean;
  readonly integrationManaged: boolean;
  readonly accountSummary: {
    readonly target: ConnectorAccountTarget;
    readonly accountCount: number;
    readonly attentionCount: number;
    readonly defaultConnection: ConnectorAccountConnection | null;
  } | null;
  readonly connectionId: string | null;
  readonly memberStatus: MemberConnectionStatus;
}

/** Preserve target status output from the complete, unfiltered target inventory. */
function memberAccountSummary(
  target: ConnectorAccountTarget,
  accounts: ConnectorAccountConnectionsResult,
): MemberConnectorFacts["accountSummary"] {
  if (accounts.state === "unavailable" || accounts.connections.length === 0) {
    return null;
  }
  return {
    target,
    accountCount: accounts.connections.length,
    attentionCount: accounts.connections.filter((account) => {
      return (
        account.connectionStatus === "reconnect-required" ||
        account.setupStatus !== "complete"
      );
    }).length,
    defaultConnection: accounts.defaultConnection,
  };
}

function memberAccountStatus(
  accounts: ConnectorAccountConnectionsResult,
): MemberConnectionStatus {
  if (accounts.state === "unavailable") return "unavailable";
  const account = accounts.defaultConnection;
  if (!account) {
    return accounts.connections.length === 0
      ? "not-connected"
      : "default-required";
  }
  if (account.connectionStatus === "reconnect-required") {
    return "reconnect-required";
  }
  if (account.setupStatus !== "complete") return "setup-required";
  return "connected";
}

/** Read one canonical target inventory for current-member status and identity. */
export async function readMemberAccountFacts(
  target: ConnectorAccountTarget,
): Promise<MemberConnectorFacts> {
  const accounts = await listConnectorAccountConnections(target, undefined, {
    includeScopeMismatch: target.kind === "builtin",
  });
  const targetKey = connectorAccountTargetKey(target);
  if (
    accounts.state === "available" &&
    (accounts.connections.some((account) => {
      return connectorAccountTargetKey(account.target) !== targetKey;
    }) ||
      (accounts.defaultConnection !== null &&
        connectorAccountTargetKey(accounts.defaultConnection.target) !==
          targetKey))
  ) {
    throw new Error("Connector account response target identity mismatch.");
  }
  const accountSummary = memberAccountSummary(target, accounts);
  const scopeMismatch =
    target.kind === "builtin"
      ? accountSummary?.defaultConnection?.scopeMismatch
      : undefined;
  const memberStatus = memberAccountStatus(accounts);
  return {
    integrationManaged: false,
    accountSummary,
    connectionId: accountSummary?.defaultConnection?.id ?? null,
    scopeMismatch,
    memberStatus:
      target.kind === "builtin" &&
      memberStatus === "connected" &&
      scopeMismatch === undefined
        ? "account-review-required"
        : memberStatus,
  };
}

/** Current-member management facts; never an admitted Run account projection. */
export async function readMemberConnectorFacts(
  connector: MemberConnector,
): Promise<MemberConnectorFacts> {
  if ("kind" in connector && isIntegrationManagedCustomConnector(connector)) {
    return {
      integrationManaged: true,
      accountSummary: null,
      connectionId: connector.connectedAccountId ?? null,
      memberStatus: connector.connected ? "connected" : "not-connected",
    };
  }
  const target =
    "kind" in connector
      ? { kind: "custom" as const, customConnectorId: connector.id }
      : { kind: "builtin" as const, connectorSlug: connector.slug };
  const facts = await readMemberAccountFacts(target);
  const account = facts.accountSummary?.defaultConnection;
  const scopeMismatch =
    !("kind" in connector) && account
      ? builtinConnectorAccountFacts(connector, account).scopeMismatch
      : undefined;
  return {
    ...facts,
    scopeMismatch,
  };
}

export function memberConnectorStatusText(facts: MemberConnectorFacts): string {
  switch (facts.memberStatus) {
    case "unavailable":
      return "account status unavailable";
    case "not-connected":
      return "not connected";
    case "default-required":
      return "default account required";
    case "reconnect-required":
      return "reconnect needed";
    case "setup-required":
      return facts.accountSummary?.defaultConnection?.setupStatus === "invalid"
        ? "setup invalid"
        : `missing ${facts.accountSummary?.defaultConnection?.missingRequiredFields.join(", ") ?? "configuration"}`;
    case "account-review-required":
      return "account review required";
    case "connected":
      return "connected";
  }
}

export function memberConnectorAccountText(
  connector: MemberConnector,
  facts: MemberConnectorFacts,
): string {
  if (facts.integrationManaged || facts.memberStatus === "unavailable") {
    return memberConnectorStatusText(facts);
  }
  const summary = facts.accountSummary;
  if (!summary || summary.accountCount === 0) {
    return "(not connected)";
  }
  const account = summary.defaultConnection;
  const parts = [
    account
      ? !account.displayName && account.externalUsername
        ? `@${account.externalUsername}`
        : connectorAccountCliInventoryLabel({
            ...account,
            connectionId: account.id,
          })
      : "(no default account)",
  ];
  if (facts.memberStatus !== "connected") {
    parts.push(`(${memberConnectorStatusText(facts)})`);
  }
  if (summary.accountCount > 1) {
    parts.push(`(${summary.accountCount} accounts)`);
  }
  if (summary.attentionCount > 0) {
    parts.push(
      `(${summary.attentionCount}/${summary.accountCount} need attention)`,
    );
  }
  if (!("kind" in connector) && facts.scopeMismatch) {
    parts.push("(permissions update available)");
  }
  return parts.join(" ");
}
