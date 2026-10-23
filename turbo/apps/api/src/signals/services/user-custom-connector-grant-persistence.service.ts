import { command } from "ccstate";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { and, eq, inArray, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";

interface PersistUserCustomConnectorGrantsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly grants: readonly AgentCustomConnectorGrant[];
  readonly operation: "replace" | "add" | "remove";
}

export const persistUserCustomConnectorGrants$ = command(
  async (
    { set },
    args: PersistUserCustomConnectorGrantsArgs,
  ): Promise<{
    readonly status: "updated";
    readonly grants: readonly AgentCustomConnectorGrant[];
  }> => {
    const db = set(writeDb$);
    const connectorIds = args.grants.map((grant) => {
      return grant.customConnectorId;
    });
    const connectorScope = and(
      eq(userCustomConnectors.orgId, args.orgId),
      eq(userCustomConnectors.userId, args.userId),
      eq(userCustomConnectors.agentId, args.agentId),
    );
    if (args.operation === "replace") {
      await db.delete(userCustomConnectors).where(connectorScope);
    } else if (args.operation === "remove" && connectorIds.length > 0) {
      await db
        .delete(userCustomConnectors)
        .where(
          and(
            connectorScope,
            inArray(userCustomConnectors.customConnectorId, connectorIds),
          ),
        );
    }

    if (args.operation !== "remove" && args.grants.length > 0) {
      await db
        .insert(userCustomConnectors)
        .values(
          args.grants.map((grant) => {
            return {
              orgId: args.orgId,
              userId: args.userId,
              agentId: args.agentId,
              customConnectorId: grant.customConnectorId,
              permissionNames: [...grant.permissionNames],
            };
          }),
        )
        .onConflictDoUpdate({
          target: [
            userCustomConnectors.orgId,
            userCustomConnectors.userId,
            userCustomConnectors.agentId,
            userCustomConnectors.customConnectorId,
          ],
          set: {
            permissionNames: sql`excluded.permission_names`,
          },
        });
    }

    if (args.operation === "replace") {
      return {
        status: "updated",
        grants: args.grants,
      };
    }
    const rows = await db
      .select({
        customConnectorId: userCustomConnectors.customConnectorId,
        permissionNames: userCustomConnectors.permissionNames,
      })
      .from(userCustomConnectors)
      .innerJoin(
        orgCustomConnectors,
        and(
          eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
          eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
        ),
      )
      .where(and(connectorScope, eq(orgCustomConnectors.enabled, true)))
      .orderBy(userCustomConnectors.customConnectorId);
    return {
      status: "updated",
      grants: rows.map((row) => {
        return {
          customConnectorId: row.customConnectorId,
          permissionNames: [...row.permissionNames],
        };
      }),
    };
  },
);
