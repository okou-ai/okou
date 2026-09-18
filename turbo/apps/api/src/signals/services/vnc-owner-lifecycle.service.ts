import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { agentVncAccess } from "@okouai/db/schema/agent-vnc-access";
import { agents } from "@okouai/db/schema/agent";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { isClerkResourceNotFound, type ClerkClient } from "../external/clerk";
import type { Db } from "../external/db";
import { settle } from "../utils";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";

export interface VncOwner {
  readonly orgId: string;
  readonly userId: string;
}

/** Deleted external identities deny access; dependency failures stay visible. */
export async function hasCurrentVncMembership(
  clerk: ClerkClient,
  owner: VncOwner,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await settle(
    loadCurrentMembershipId(clerk, owner, signal),
    signal,
  );
  if (result.ok) {
    return result.value !== null;
  }
  if (!isClerkResourceNotFound(result.error)) {
    throw result.error;
  }
  return false;
}

type VncCleanupScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | (VncOwner & { readonly kind: "owner" });

function scopeKey(scope: VncCleanupScope): string {
  const identity =
    scope.kind === "user"
      ? [scope.kind, scope.userId]
      : scope.kind === "organization"
        ? [scope.kind, scope.orgId]
        : [scope.kind, scope.orgId, scope.userId];
  return JSON.stringify(identity);
}

function ownerScopeKeys(owner: VncOwner): readonly string[] {
  return [
    scopeKey({ kind: "user", userId: owner.userId }),
    scopeKey({ kind: "organization", orgId: owner.orgId }),
    scopeKey({ kind: "owner", ...owner }),
  ].sort();
}

async function lockScope(
  tx: Tx,
  key: string,
  mode: "shared" | "exclusive",
): Promise<void> {
  const lockKey = `vnc-cleanup:${key}`;
  await tx.execute(
    mode === "shared"
      ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${lockKey}, 0))`
      : sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

async function deleteVncRows(
  tx: Tx,
  connectionCondition: SQL | undefined,
  credentialCondition: SQL | undefined,
  grantCondition: SQL | undefined,
): Promise<void> {
  if (!connectionCondition || !credentialCondition || !grantCondition) {
    throw new Error("VNC cleanup requires an exact owner scope");
  }
  // Membership cleanup later locks Runs. Hold their grant parents first so
  // Agent deletion cannot hold a Run while waiting on our grant deletion.
  await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      inArray(
        agents.id,
        tx
          .select({ id: agentVncAccess.agentId })
          .from(agentVncAccess)
          .where(grantCondition),
      ),
    )
    .orderBy(asc(agents.id))
    .for("share");
  // Overlapping user/organization cleanup locks rows in the same global order.
  await tx
    .select({ id: vncConnections.id })
    .from(vncConnections)
    .where(connectionCondition)
    .orderBy(asc(vncConnections.id))
    .for("update");
  await tx
    .select({ id: vncCredentials.id })
    .from(vncCredentials)
    .where(credentialCondition)
    .orderBy(asc(vncCredentials.id))
    .for("update");
  await tx
    .select({ agentId: agentVncAccess.agentId })
    .from(agentVncAccess)
    .where(grantCondition)
    .orderBy(
      asc(agentVncAccess.orgId),
      asc(agentVncAccess.userId),
      asc(agentVncAccess.agentId),
    )
    .for("update");
  await tx.delete(vncConnections).where(connectionCondition);
  await tx.delete(vncCredentials).where(credentialCondition);
  // Grants may exist with no connections.
  await tx.delete(agentVncAccess).where(grantCondition);
}

/** B1 -> shared cleanup scopes -> exclusive owner -> business rows. */
export async function enterVncWrite(tx: Tx, owner: VncOwner): Promise<boolean> {
  const writable = await settle(
    assertErasureSubjectWritable(tx, [
      { subjectKind: "organization", subjectId: owner.orgId },
      { subjectKind: "user", subjectId: owner.userId },
    ]),
  );
  if (!writable.ok) {
    if (
      writable.error instanceof Error &&
      writable.error.message === "account_erasure:subject_closed"
    ) {
      return false;
    }
    throw writable.error;
  }
  const keys = ownerScopeKeys(owner);
  for (const key of keys) {
    await lockScope(tx, key, "shared");
  }
  const ownerLock = `vnc-owner:${scopeKey({ kind: "owner", ...owner })}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerLock}, 0))`,
  );
  return true;
}

/** Call before any other business-row lock in an enclosing cleanup transaction. */
export async function eraseVncOwner(
  tx: Tx,
  scope: VncCleanupScope,
): Promise<void> {
  const key = scopeKey(scope);
  await lockScope(tx, key, "exclusive");
  if (scope.kind === "user") {
    await deleteVncRows(
      tx,
      eq(vncConnections.userId, scope.userId),
      eq(vncCredentials.userId, scope.userId),
      eq(agentVncAccess.userId, scope.userId),
    );
    return;
  }
  if (scope.kind === "organization") {
    await deleteVncRows(
      tx,
      eq(vncConnections.orgId, scope.orgId),
      eq(vncCredentials.orgId, scope.orgId),
      eq(agentVncAccess.orgId, scope.orgId),
    );
    return;
  }

  await deleteVncRows(
    tx,
    and(
      eq(vncConnections.orgId, scope.orgId),
      eq(vncConnections.userId, scope.userId),
    ),
    and(
      eq(vncCredentials.orgId, scope.orgId),
      eq(vncCredentials.userId, scope.userId),
    ),
    and(
      eq(agentVncAccess.orgId, scope.orgId),
      eq(agentVncAccess.userId, scope.userId),
    ),
  );
}

export async function eraseVncOwnerData(
  db: Db,
  scope: VncCleanupScope,
): Promise<void> {
  await db.transaction(async (tx) => {
    await eraseVncOwner(tx, scope);
  });
}
