import { command, computed, type Computed } from "ccstate";
import { teamsOrgConnections } from "@okouai/db/runtime/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { and, eq, isNotNull, or } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { isUniqueViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
interface TeamsAccountOwner {
  readonly orgId: string;
  readonly userId: string;
}

/** Account authority belongs to its persisted organization and user. */
export function teamsAccountOwnerCondition(identity: TeamsAccountOwner) {
  return and(
    eq(teamsOrgConnections.userId, identity.userId),
    eq(teamsOrgConnections.orgId, identity.orgId),
  );
}

export function teamsAccountConnection(
  identity$: Computed<TeamsAccountOwner | Promise<TeamsAccountOwner>>,
) {
  return computed(async (get) => {
    const identity = await get(identity$);
    const rows = await get(db$)
      .select({
        connection: teamsOrgConnections,
        installation: teamsOrgInstallations,
      })
      .from(teamsOrgConnections)
      .leftJoin(
        teamsOrgInstallations,
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
      )
      .where(teamsAccountOwnerCondition(identity))
      .limit(2);
    return rows.length === 1 ? rows[0] : undefined;
  });
}

/** Only call with the tenant and object ID verified by Microsoft OAuth. */
export const connectTeamsAccount$ = command(
  async (
    { set },
    args: TeamsAccountOwner & {
      readonly tenantId: string;
      readonly aadObjectId: string;
      readonly displayName: string | null;
      readonly principalName: string | null;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const current = await db
      .select()
      .from(teamsOrgConnections)
      .where(
        or(
          and(
            eq(teamsOrgConnections.teamsTenantId, args.tenantId),
            eq(teamsOrgConnections.teamsAadObjectId, args.aadObjectId),
          ),
          teamsAccountOwnerCondition(args),
        ),
      );
    signal.throwIfAborted();
    const message =
      "Disconnect your current Teams account before connecting another identity or organization.";
    if (
      current.some((row) => {
        return (
          row.userId !== args.userId ||
          row.orgId !== args.orgId ||
          row.teamsTenantId !== args.tenantId ||
          row.teamsAadObjectId !== args.aadObjectId
        );
      })
    ) {
      return { kind: "forbidden", message } as const;
    }
    const written = await settle(
      db
        .insert(teamsOrgConnections)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          teamsTenantId: args.tenantId,
          teamsAadObjectId: args.aadObjectId,
          teamsUserDisplayName: args.displayName,
          teamsUserPrincipalName: args.principalName,
        })
        .onConflictDoUpdate({
          target: [
            teamsOrgConnections.teamsAadObjectId,
            teamsOrgConnections.teamsTenantId,
          ],
          targetWhere: isNotNull(teamsOrgConnections.teamsAadObjectId),
          set: {
            orgId: args.orgId,
            teamsUserDisplayName: args.displayName,
            teamsUserPrincipalName: args.principalName,
          },
          setWhere: teamsAccountOwnerCondition(args),
        })
        .returning(),
      signal,
    );
    if (!written.ok) {
      if (isUniqueViolation(written.error, "idx_teams_org_connections_owner")) {
        return { kind: "forbidden", message } as const;
      }
      throw written.error;
    }
    const [connection] = written.value;
    if (!connection) {
      return { kind: "forbidden", message } as const;
    }
    return { kind: "ok", connection } as const;
  },
);

/** Account-owned connections survive installation removal. */
export const removeTeamsInstallation$ = command(
  async ({ set }, tenantId: string, signal: AbortSignal) => {
    await set(writeDb$)
      .delete(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.teamsTenantId, tenantId));
    signal.throwIfAborted();
  },
);

/** Revoke identity authority on owner departure without deleting chat content. */
export const deleteTeamsOwnerAccounts$ = command(
  async (
    { set },
    owner:
      | {
          readonly kind: "owner";
          readonly orgId: string;
          readonly userId: string;
        }
      | { readonly kind: "organization"; readonly orgId: string }
      | { readonly kind: "user"; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    await db
      .delete(teamsOrgConnections)
      .where(
        owner.kind === "user"
          ? eq(teamsOrgConnections.userId, owner.userId)
          : and(
              owner.kind === "owner"
                ? eq(teamsOrgConnections.userId, owner.userId)
                : undefined,
              eq(teamsOrgConnections.orgId, owner.orgId),
            ),
      );
    signal.throwIfAborted();
  },
);
