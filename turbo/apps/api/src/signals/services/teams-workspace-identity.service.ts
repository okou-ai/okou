import { command, computed, type Computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { and, eq, exists, inArray, isNull, isNotNull, or } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { isUniqueViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
import {
  createUserFeatureSwitchContext,
  loadUserFeatureSwitchContext$,
} from "./feature-switches.service";

interface TeamsAccountOwner {
  readonly orgId: string;
  readonly userId: string;
}

export function teamsWorkspaceIdentityEnabled(
  identity$: Computed<TeamsAccountOwner | Promise<TeamsAccountOwner>>,
) {
  const resolved$ = computed(async (get) => {
    return await get(identity$);
  });
  const context$ = createUserFeatureSwitchContext(resolved$);
  return computed(async (get) => {
    return isFeatureEnabled(
      FeatureSwitchKey.TeamsWorkspaceIdentity,
      await get(context$),
    );
  });
}

/** GA writers leave orgId null while the switch is off. Retire installation-
 * derived ownership only after the writer, row and rollback gates in #43729. */
export function teamsAccountOwnerCondition(identity: TeamsAccountOwner) {
  return and(
    eq(teamsOrgConnections.userId, identity.userId),
    or(
      eq(teamsOrgConnections.orgId, identity.orgId),
      and(
        isNull(teamsOrgConnections.orgId),
        eq(teamsOrgInstallations.orgId, identity.orgId),
      ),
    ),
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
      .select({
        connection: teamsOrgConnections,
        installationOrgId: teamsOrgInstallations.orgId,
      })
      .from(teamsOrgConnections)
      .leftJoin(
        teamsOrgInstallations,
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
      )
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
      current.some(({ connection: row, installationOrgId }) => {
        return (
          row.userId !== args.userId ||
          (row.orgId ?? installationOrgId) !== args.orgId ||
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
          setWhere: and(
            eq(teamsOrgConnections.userId, args.userId),
            or(
              eq(teamsOrgConnections.orgId, args.orgId),
              and(
                isNull(teamsOrgConnections.orgId),
                exists(
                  db
                    .select({ tenantId: teamsOrgInstallations.teamsTenantId })
                    .from(teamsOrgInstallations)
                    .where(
                      and(
                        eq(
                          teamsOrgInstallations.teamsTenantId,
                          teamsOrgConnections.teamsTenantId,
                        ),
                        eq(teamsOrgInstallations.orgId, args.orgId),
                      ),
                    ),
                ),
              ),
            ),
          ),
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
    const db = set(writeDb$);
    const [installation] = await db
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.teamsTenantId, tenantId))
      .limit(1);
    signal.throwIfAborted();
    if (installation?.orgId) {
      const legacy = await db
        .select()
        .from(teamsOrgConnections)
        .where(
          and(
            eq(teamsOrgConnections.teamsTenantId, tenantId),
            isNull(teamsOrgConnections.orgId),
          ),
        );
      signal.throwIfAborted();
      for (const connection of legacy) {
        const features = await set(
          loadUserFeatureSwitchContext$,
          installation.orgId,
          connection.userId,
          signal,
        );
        if (
          isFeatureEnabled(FeatureSwitchKey.TeamsWorkspaceIdentity, features)
        ) {
          const accounts = await db
            .select({ id: teamsOrgConnections.id })
            .from(teamsOrgConnections)
            .leftJoin(
              teamsOrgInstallations,
              eq(
                teamsOrgInstallations.teamsTenantId,
                teamsOrgConnections.teamsTenantId,
              ),
            )
            .where(
              teamsAccountOwnerCondition({
                orgId: installation.orgId,
                userId: connection.userId,
              }),
            )
            .limit(2);
          signal.throwIfAborted();
          if (accounts.length !== 1 || accounts[0]?.id !== connection.id) {
            continue;
          }
          const promoted = await settle(
            db
              .update(teamsOrgConnections)
              .set({ orgId: installation.orgId })
              .where(
                and(
                  eq(teamsOrgConnections.id, connection.id),
                  isNull(teamsOrgConnections.orgId),
                ),
              ),
            signal,
          );
          if (
            !promoted.ok &&
            !isUniqueViolation(
              promoted.error,
              "idx_teams_org_connections_owner",
            )
          ) {
            throw promoted.error;
          }
        }
      }
    }
    await db
      .delete(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsTenantId, tenantId),
          isNull(teamsOrgConnections.orgId),
        ),
      );
    signal.throwIfAborted();
    await db
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
              or(
                eq(teamsOrgConnections.orgId, owner.orgId),
                and(
                  isNull(teamsOrgConnections.orgId),
                  inArray(
                    teamsOrgConnections.teamsTenantId,
                    db
                      .select({ tenantId: teamsOrgInstallations.teamsTenantId })
                      .from(teamsOrgInstallations)
                      .where(eq(teamsOrgInstallations.orgId, owner.orgId)),
                  ),
                ),
              ),
            ),
      );
    signal.throwIfAborted();
  },
);
