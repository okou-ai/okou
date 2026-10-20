import {
  connectorAccountTargetKey,
  type ConnectorAccountSummary,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { isIntegrationManagedCustomConnector } from "@okouai/api-contracts/contracts/custom-connectors";
import { readBuiltinConnectorAccountFacts } from "@okouai/api-contracts/contracts/connector-catalog-readers";
import { type CustomConnectorReaderResponse as CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connector-readers";
import {
  listConnectorAccountSummaries,
  type ConnectorCatalogStatus,
} from "../../lib/api/domains/connectors";
import { connectorAccountCliInventoryLabel } from "./account-label";

export type MemberConnector = ConnectorCatalogStatus | CustomConnectorResponse;

type MemberConnectionStatus =
  | "not-connected"
  | "default-required"
  | "reconnect-required"
  | "setup-required"
  | "account-review-required"
  | "connected";

export interface MemberConnectorFacts {
  readonly scopeMismatch?: boolean;
  readonly integrationManaged: boolean;
  readonly accountSummary: ConnectorAccountSummary | null;
  readonly connectionId: string | null;
  readonly memberStatus: MemberConnectionStatus;
}

/** Managed-only and empty inventories do not consume ordinary account facts. */
export async function customMemberAccountSummaries(
  connectors: readonly CustomConnectorResponse[],
): Promise<ReadonlyMap<string, ConnectorAccountSummary>> {
  return connectors.some((connector) => {
    return !isIntegrationManagedCustomConnector(connector);
  })
    ? listConnectorAccountSummaries()
    : new Map();
}

export function memberAccountStatus(
  summary: ConnectorAccountSummary | null,
): MemberConnectionStatus {
  if (!summary || summary.accountCount === 0) {
    return "not-connected";
  }
  const account = summary.defaultConnection;
  if (!account) {
    return "default-required";
  }
  if (account.connectionStatus === "reconnect-required") {
    return "reconnect-required";
  }
  if (account.setupStatus === undefined) {
    return "account-review-required";
  }
  if (account.setupStatus !== "complete") return "setup-required";
  return "connected";
}

/** Current-member management facts; never an admitted Run account projection. */
export function memberConnectorFacts(
  connector: MemberConnector,
  summaries: ReadonlyMap<string, ConnectorAccountSummary>,
): MemberConnectorFacts {
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
  // This map is a successfully read complete response. Request failures never
  // reach this projection, so a missing target establishes no saved account.
  const accountSummary =
    summaries.get(connectorAccountTargetKey(target)) ?? null;
  const account = accountSummary?.defaultConnection;
  const scopeMismatch =
    !("kind" in connector) && account
      ? readBuiltinConnectorAccountFacts(connector, account).scopeMismatch
      : undefined;
  const memberStatus = memberAccountStatus(accountSummary);
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
    case "not-connected":
      return "not connected";
    case "default-required":
      return "default account required";
    case "reconnect-required":
      return "reconnect needed";
    case "setup-required":
      return facts.accountSummary?.defaultConnection?.setupStatus === "invalid"
        ? "setup invalid"
        : `missing ${facts.accountSummary?.defaultConnection?.missingRequiredFields?.join(", ") ?? "configuration"}`;
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
  if (facts.integrationManaged) {
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
