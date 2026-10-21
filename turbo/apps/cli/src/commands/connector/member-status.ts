import {
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
  builtinConnectorAccountFacts,
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
export function memberAccountSummary(
  target: ConnectorAccountTarget,
  accounts: ConnectorAccountConnectionsResult | null,
): MemberConnectorFacts["accountSummary"] {
  if (
    !accounts ||
    accounts.state === "unavailable" ||
    accounts.connections.length === 0
  ) {
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

export function memberAccountStatus(
  accounts: ConnectorAccountConnectionsResult | null,
): MemberConnectionStatus {
  if (accounts?.state === "unavailable") return "unavailable";
  if (!accounts) return "not-connected";
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
  const accounts = await listConnectorAccountConnections(target, undefined, {
    includeScopeMismatch: target.kind === "builtin",
  });
  const accountSummary = memberAccountSummary(target, accounts);
  const account = accountSummary?.defaultConnection;
  const scopeMismatch =
    !("kind" in connector) && account
      ? builtinConnectorAccountFacts(connector, account).scopeMismatch
      : undefined;
  const memberStatus = memberAccountStatus(accounts);
  return {
    integrationManaged: false,
    accountSummary,
    connectionId: accountSummary?.defaultConnection?.id ?? null,
    scopeMismatch,
    memberStatus:
      !("kind" in connector) &&
      memberStatus === "connected" &&
      scopeMismatch === undefined
        ? "account-review-required"
        : memberStatus,
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
