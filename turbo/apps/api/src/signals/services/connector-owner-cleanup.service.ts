import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { builtinConnectorDcrRegistrations } from "@okouai/db/schema/connector-dcr-registration";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { eq, type SQL } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  deleteConnectorCredentialStorageConnectionsForOwner,
  type ConnectorOwnerScope,
} from "./connector-credential-storage-write.service";

interface ConnectorOwnerDeleteConditions {
  readonly builtinGrant: SQL;
  readonly customGrant: SQL;
  readonly oauthState: SQL;
}

function connectorOwnerDeleteConditions(
  owner: ConnectorOwnerScope,
): ConnectorOwnerDeleteConditions {
  return owner.kind === "user"
    ? {
        builtinGrant: eq(userBuiltinConnectors.userId, owner.userId),
        customGrant: eq(userCustomConnectors.userId, owner.userId),
        oauthState: eq(connectorOauthStates.userId, owner.userId),
      }
    : {
        builtinGrant: eq(userBuiltinConnectors.orgId, owner.orgId),
        customGrant: eq(userCustomConnectors.orgId, owner.orgId),
        oauthState: eq(connectorOauthStates.orgId, owner.orgId),
      };
}

export async function deleteConnectorOwnerState(
  db: Db,
  owner: ConnectorOwnerScope,
  signal: AbortSignal,
): Promise<void> {
  if (owner.kind === "user") {
    await db
      .delete(feishuOrgConnections)
      .where(eq(feishuOrgConnections.userId, owner.userId));
    signal.throwIfAborted();
  }

  const conditions = connectorOwnerDeleteConditions(owner);
  await db.delete(userBuiltinConnectors).where(conditions.builtinGrant);
  signal.throwIfAborted();
  await db.delete(userCustomConnectors).where(conditions.customGrant);
  signal.throwIfAborted();
  await db.delete(connectorOauthStates).where(conditions.oauthState);
  signal.throwIfAborted();

  await deleteConnectorCredentialStorageConnectionsForOwner(db, owner, signal);

  if (owner.kind === "organization") {
    await db
      .delete(builtinConnectorDcrRegistrations)
      .where(eq(builtinConnectorDcrRegistrations.orgId, owner.orgId));
    signal.throwIfAborted();
    await db
      .delete(orgCustomConnectors)
      .where(eq(orgCustomConnectors.orgId, owner.orgId));
    signal.throwIfAborted();
  }
}
