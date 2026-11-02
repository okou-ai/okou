import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectors } from "@okouai/db/schema/connector";
import { and, eq } from "drizzle-orm";

export interface ConnectorAccessOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly target: ConnectorAccountTarget;
}

export function connectorAccessAccountOwner(owner: ConnectorAccessOwner) {
  return and(
    eq(connectors.orgId, owner.orgId),
    eq(connectors.userId, owner.userId),
    owner.target.kind === "builtin"
      ? eq(connectors.connectorSlug, owner.target.connectorSlug)
      : eq(connectors.customConnectorId, owner.target.customConnectorId),
  );
}
