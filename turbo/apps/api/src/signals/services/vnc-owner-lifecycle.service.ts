import { createHash, randomUUID } from "node:crypto";

import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { vncAuthorityRevisions } from "@okouai/db/schema/vnc-authority-revision";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { isClerkResourceNotFound, type ClerkClient } from "../external/clerk";
import type { Db, ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";

interface OwnerIdentity {
  readonly orgId: string;
  readonly userId: string;
}

export interface VncOwner extends OwnerIdentity {
  readonly membershipId: string;
}

type VncRevisions = readonly {
  readonly scopeKey: string;
  readonly revision: string;
  readonly membershipIdHash: string | null;
}[];

// An absent row and a first membership observation have the same cleanup epoch.
const INITIAL_REVISION = "00000000-0000-4000-8000-000000000000";

export interface VncAdmission {
  readonly owner: VncOwner;
  readonly revisions: VncRevisions;
}

/** Deleted external identities deny access; dependency failures stay visible. */
export async function loadCurrentVncMembershipId(
  clerk: ClerkClient,
  owner: OwnerIdentity,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await settle(
    loadCurrentMembershipId(clerk, owner, signal),
    signal,
  );
  if (result.ok) {
    return result.value;
  }
  if (!isClerkResourceNotFound(result.error)) {
    throw result.error;
  }
  return null;
}

type VncAuthorityScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | (OwnerIdentity & { readonly kind: "membership" });

type VncCleanupScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | (VncOwner & { readonly kind: "membership" });

function scopeKey(scope: VncAuthorityScope): string {
  const identity =
    scope.kind === "user"
      ? [scope.kind, scope.userId]
      : scope.kind === "organization"
        ? [scope.kind, scope.orgId]
        : [scope.kind, scope.orgId, scope.userId];
  // Retain only a domain-separated, pseudonymous cleanup fence after deletion.
  return createHash("sha256")
    .update(JSON.stringify(["vnc-authority-v1", ...identity]))
    .digest("hex");
}

function ownerScopeKeys(owner: OwnerIdentity): readonly string[] {
  return [
    scopeKey({ kind: "user", userId: owner.userId }),
    scopeKey({ kind: "organization", orgId: owner.orgId }),
    scopeKey({ kind: "membership", ...owner }),
  ].sort();
}

/** Capture before fresh Clerk authentication and KMS; never rebase a request. */
export async function snapshotVncRevisions(
  db: Pick<ReadonlyDb, "select">,
  owner: OwnerIdentity,
): Promise<VncRevisions> {
  const keys = ownerScopeKeys(owner);
  const rows = await db
    .select()
    .from(vncAuthorityRevisions)
    .where(inArray(vncAuthorityRevisions.scopeKey, [...keys]));
  return keys.map((key) => {
    const row = rows.find((entry) => {
      return entry.scopeKey === key;
    });
    return {
      scopeKey: key,
      revision: row?.revision ?? INITIAL_REVISION,
      membershipIdHash: row?.membershipIdHash ?? null,
    };
  });
}

async function lockScope(
  tx: Tx,
  key: string,
  mode: "shared" | "exclusive",
): Promise<void> {
  const lockKey = `vnc-authority:${key}`;
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
): Promise<void> {
  if (!connectionCondition || !credentialCondition) {
    throw new Error("VNC cleanup requires an exact owner scope");
  }
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
  await tx.delete(vncConnections).where(connectionCondition);
  await tx.delete(vncCredentials).where(credentialCondition);
}

/** B1 -> shared cleanup scopes -> exclusive owner -> compare -> business rows. */
export async function enterVncWrite(
  tx: Tx,
  admission: VncAdmission,
): Promise<boolean> {
  const { owner } = admission;
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
  const ownerLock = `vnc-owner:${scopeKey({ kind: "membership", ...owner })}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerLock}, 0))`,
  );
  const current = await snapshotVncRevisions(tx, owner);
  if (
    admission.revisions.length !== current.length ||
    current.some((entry, index) => {
      const admitted = admission.revisions[index];
      return (
        admitted?.scopeKey !== entry.scopeKey ||
        admitted.revision !== entry.revision
      );
    })
  ) {
    return false;
  }
  const membershipKey = scopeKey({ kind: "membership", ...owner });
  const currentMembership = current.find((entry) => {
    return entry.scopeKey === membershipKey;
  });
  const observedMembership = admission.revisions.find((entry) => {
    return entry.scopeKey === membershipKey;
  });
  if (!currentMembership || !observedMembership) {
    throw new Error("VNC admission is missing its membership scope");
  }
  const membershipIdHash = createHash("sha256")
    .update(JSON.stringify(["vnc-membership-v1", owner.membershipId]))
    .digest("hex");
  if (
    currentMembership.membershipIdHash !==
      observedMembership.membershipIdHash &&
    currentMembership.membershipIdHash !== membershipIdHash
  ) {
    return false;
  }
  // A successful new membership observation also fences older in-flight
  // admissions, even before its predecessor's deletion webhook arrives.
  if (currentMembership.membershipIdHash !== membershipIdHash) {
    await tx
      .insert(vncAuthorityRevisions)
      .values({
        scopeKey: membershipKey,
        revision: INITIAL_REVISION,
        membershipIdHash,
      })
      .onConflictDoUpdate({
        target: vncAuthorityRevisions.scopeKey,
        set: { membershipIdHash },
      });
  }
  // A fresh membership can save the same endpoint without recovering old data.
  await deleteVncRows(
    tx,
    and(
      eq(vncConnections.orgId, owner.orgId),
      eq(vncConnections.userId, owner.userId),
      ne(vncConnections.membershipId, owner.membershipId),
    ),
    and(
      eq(vncCredentials.orgId, owner.orgId),
      eq(vncCredentials.userId, owner.userId),
      ne(vncCredentials.membershipId, owner.membershipId),
    ),
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
  await tx
    .insert(vncAuthorityRevisions)
    .values({ scopeKey: key, revision: randomUUID() })
    .onConflictDoUpdate({
      target: vncAuthorityRevisions.scopeKey,
      set: { revision: randomUUID() },
    });

  if (scope.kind === "user") {
    await deleteVncRows(
      tx,
      eq(vncConnections.userId, scope.userId),
      eq(vncCredentials.userId, scope.userId),
    );
    return;
  }
  if (scope.kind === "organization") {
    await deleteVncRows(
      tx,
      eq(vncConnections.orgId, scope.orgId),
      eq(vncCredentials.orgId, scope.orgId),
    );
    return;
  }

  await deleteVncRows(
    tx,
    and(
      eq(vncConnections.orgId, scope.orgId),
      eq(vncConnections.userId, scope.userId),
      eq(vncConnections.membershipId, scope.membershipId),
    ),
    and(
      eq(vncCredentials.orgId, scope.orgId),
      eq(vncCredentials.userId, scope.userId),
      eq(vncCredentials.membershipId, scope.membershipId),
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
