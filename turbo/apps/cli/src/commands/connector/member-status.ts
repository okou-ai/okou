import {
  connectorAccountTargetKey,
  type ConnectorAccountSummary,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorCatalogStatus } from "../../lib/api/domains/connectors";
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
  readonly integrationManaged: boolean;
  readonly accountSummary: ConnectorAccountSummary | null;
  readonly connectionId: string | null;
  readonly memberStatus: MemberConnectionStatus;
}

function declaredMissingFields(connector: CustomConnectorResponse) {
  return connector.fields.filter((field) => {
    return (
      field.required && connector.missingRequiredFields.includes(field.key)
    );
  });
}

function ordinaryMemberStatus(
  connector: MemberConnector,
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
  if ("kind" in connector) {
    if (declaredMissingFields(connector).length > 0) {
      return "setup-required";
    }
    if (!connector.connected || connector.connectedAccountId !== account.id) {
      return "account-review-required";
    }
  } else if (
    !connector.connected ||
    connector.connectionStatus === "reconnect-required" ||
    (connector.connection?.id !== undefined &&
      connector.connection.id !== null &&
      connector.connection.id !== account.id)
  ) {
    return "account-review-required";
  }
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
  return {
    integrationManaged: false,
    accountSummary,
    connectionId: accountSummary?.defaultConnection?.id ?? null,
    memberStatus: ordinaryMemberStatus(connector, accountSummary),
  };
}

export function memberConnectorStatusText(
  connector: MemberConnector,
  facts: MemberConnectorFacts,
): string {
  switch (facts.memberStatus) {
    case "not-connected":
      return "not connected";
    case "default-required":
      return "default account required";
    case "reconnect-required":
      return "reconnect needed";
    case "setup-required":
      return "kind" in connector
        ? `missing ${declaredMissingFields(connector)
            .map((field) => {
              return field.key;
            })
            .join(", ")}`
        : "setup incomplete";
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
    return memberConnectorStatusText(connector, facts);
  }
  const summary = facts.accountSummary;
  if (!summary || summary.accountCount === 0) {
    const missing = "kind" in connector ? declaredMissingFields(connector) : [];
    return missing.length > 0
      ? `(not connected; missing ${missing
          .map((field) => {
            return field.key;
          })
          .join(", ")})`
      : "(not connected)";
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
    parts.push(`(${memberConnectorStatusText(connector, facts)})`);
  }
  if (summary.accountCount > 1) {
    parts.push(`(${summary.accountCount} accounts)`);
  }
  if (summary.attentionCount > 0) {
    parts.push(
      `(${summary.attentionCount}/${summary.accountCount} need attention)`,
    );
  }
  if (!("kind" in connector) && connector.scopeMismatch) {
    parts.push("(permissions update available)");
  }
  return parts.join(" ");
}
