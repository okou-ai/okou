import { morningBriefCollectionOccurrences } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/** Historical collection ownership and cleanup; no new Native admission. */
export interface MorningBriefCollectionOwner {
  readonly orgId: string;
  readonly userId: string;
}

function memberKey(owner: MorningBriefCollectionOwner): SQL | undefined {
  return and(
    eq(orgMembersMetadata.orgId, owner.orgId),
    eq(orgMembersMetadata.userId, owner.userId),
  );
}

/**
 * Take this owner's durable member row.
 *
 * The member row this occurrence hangs from is locked and rechecked.
 * `org_members_metadata` is the source of truth for the member's own
 * preferences — including the timezone an enabled brief requires — and is
 * deleted by membership, user and organization cleanup without any background
 * reader refilling it. A cleanup
 * therefore either waits for this transaction and then cascades the row away,
 * or has already committed and leaves nothing to write. This never creates the
 * parent.
 *
 * The row's own `morning_brief_collection_revoked_at` is the durable half of
 * that boundary. Revocation stamps it in the first transaction each cleanup
 * commits, well before the parent itself is deleted, so a claim whose external
 * membership answer was resolved earlier still loses here — including when
 * revocation had no occurrence to delete. Because `FOR KEY SHARE` conflicts
 * with the `FOR UPDATE` that revocation takes on the same row, the two
 * transactions cannot decide at the same time in either order.
 *
 * This is the shared owner fence every later stage uses. A stage that already
 * holds a persisted occurrence — generation, its saved result, delivery —
 * proves the owner with exactly this call rather than reimplementing the lock
 * mode or the stamp comparison. It deliberately does not compare an
 * admission's parent generation, because such a stage has no admission to
 * compare: deleting the parent cascades its occurrence away, so a surviving
 * occurrence is itself the proof that the parent never changed.
 */
export async function lockCollectionOwner(
  tx: Tx,
  owner: MorningBriefCollectionOwner,
): Promise<boolean> {
  const member = await lockOwnerRow(tx, owner);
  return member !== undefined && member.revokedAt === null;
}

async function lockOwnerRow(
  tx: Tx,
  owner: MorningBriefCollectionOwner,
): Promise<
  { readonly revokedAt: Date | null; readonly createdAt: Date } | undefined
> {
  const [member] = await tx
    .select({
      revokedAt: orgMembersMetadata.morningBriefCollectionRevokedAt,
      createdAt: orgMembersMetadata.createdAt,
    })
    .from(orgMembersMetadata)
    .where(memberKey(owner))
    .limit(1)
    .for("key share");
  return member;
}

type MorningBriefCollectionRevocationScope =
  | {
      readonly kind: "membership";
      readonly orgId: string;
      readonly userId: string;
    }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string };

function revocationWhere(
  scope: MorningBriefCollectionRevocationScope,
): SQL | undefined {
  if (scope.kind === "membership") {
    return and(
      eq(morningBriefCollectionOccurrences.orgId, scope.orgId),
      eq(morningBriefCollectionOccurrences.userId, scope.userId),
    );
  }
  return scope.kind === "user"
    ? eq(morningBriefCollectionOccurrences.userId, scope.userId)
    : eq(morningBriefCollectionOccurrences.orgId, scope.orgId);
}

function revokedMemberWhere(
  scope: MorningBriefCollectionRevocationScope,
): SQL | undefined {
  if (scope.kind === "membership") {
    return memberKey({ orgId: scope.orgId, userId: scope.userId });
  }
  return scope.kind === "user"
    ? eq(orgMembersMetadata.userId, scope.userId)
    : eq(orgMembersMetadata.orgId, scope.orgId);
}

/**
 * Revoke this scope's collection ownership inside a cleanup transaction.
 *
 * This runs in the first transaction each membership, user and organization
 * cleanup commits, so an owner loses collection ownership before the rest of
 * their state is torn down — and the caller must pass that transaction, not a
 * connection, because the decision has to become visible with the rest of that
 * revocation and not a statement later.
 *
 * Deleting the occurrences is only half of it. Taking `FOR UPDATE` on the owner
 * rows first serializes this against the `FOR KEY SHARE` a claim or
 * finalization holds, and stamping those rows records the revocation durably.
 * That explicit lock is load-bearing and must not be folded into the `UPDATE`:
 * an `UPDATE` of a non-key column acquires `FOR NO KEY UPDATE`, which does not
 * conflict with `FOR KEY SHARE`, so a single statement would let a claim read
 * an unstamped row and commit its insert alongside this delete. No test would
 * catch that, because the regressions depend on the blocking order rather than
 * on the number of statements.
 * A claim that commits first is therefore seen and deleted here; a claim that
 * arrives later reads the stamp and refuses, even though this transaction found
 * no occurrence to delete and even though the member row itself is removed only
 * at the end of the cleanup. Other owners are untouched, and the member and
 * Agent cascades remain the final guarantee.
 *
 * A running attempt is left with nothing to finalize. Its in-flight Slack
 * requests cannot be retracted; what this guarantees is that no result of one
 * is accepted, persisted or returned once this transaction commits.
 */
export async function revokeMorningBriefCollectionOwnership(
  tx: Tx,
  scope: MorningBriefCollectionRevocationScope,
  at: Date,
): Promise<void> {
  await tx
    .select({ orgId: orgMembersMetadata.orgId })
    .from(orgMembersMetadata)
    .where(revokedMemberWhere(scope))
    .for("update");
  await tx
    .update(orgMembersMetadata)
    .set({ morningBriefCollectionRevokedAt: at, updatedAt: at })
    .where(revokedMemberWhere(scope));
  await tx
    .delete(morningBriefCollectionOccurrences)
    .where(revocationWhere(scope));
}
