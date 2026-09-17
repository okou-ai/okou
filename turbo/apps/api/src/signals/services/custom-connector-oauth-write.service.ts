import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { and, asc, eq, or } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

interface ConnectorIdentity {
  readonly connectorId: string;
  readonly orgId: string;
}

/**
 * Complete mode/config changes in the caller's transaction. Include both the
 * old and new identities when moving a config; acquire these locks before any
 * config write, and let failures roll back the owning transaction. A newly
 * inserted parent is protected by its insert and the ordinary PK/FK checks.
 */
export async function writeCustomConnectorOAuthState<Result>(
  tx: Tx,
  connectors: readonly [ConnectorIdentity, ...ConnectorIdentity[]],
  write: () => Promise<Result>,
): Promise<Result> {
  const affected = or(
    ...connectors.map(({ connectorId, orgId }) => {
      return and(
        eq(orgCustomConnectors.id, connectorId),
        eq(orgCustomConnectors.orgId, orgId),
      );
    }),
  );
  await tx
    .select({ id: orgCustomConnectors.id })
    .from(orgCustomConnectors)
    .where(affected)
    .orderBy(asc(orgCustomConnectors.id), asc(orgCustomConnectors.orgId))
    .for("update");

  const result = await write();

  // Like the deferred triggers, validate after all writes, including valid
  // intermediate states such as changing mode before replacing the config.
  const states = await tx
    .select({
      authMode: orgCustomConnectors.authMode,
      configConnectorId: orgCustomConnectorOauthConfigs.connectorId,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(affected);
  for (const state of states) {
    // The config primary key guarantees at most one row; its composite FK
    // guarantees organization ownership and cascades when a parent is deleted.
    if ((state.authMode === "oauth") !== (state.configConnectorId !== null)) {
      throw new Error("custom connector OAuth mode and config do not match");
    }
  }
  return result;
}
