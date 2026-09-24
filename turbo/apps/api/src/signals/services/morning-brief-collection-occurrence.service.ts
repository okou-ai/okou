import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { morningBriefCollectionOccurrences } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { settle } from "../utils";

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
 * Admit this owner and take their durable member row.
 *
 * Erasure admission comes first and is held through COMMIT, then the member row
 * this occurrence hangs from is locked and rechecked. `org_members_metadata` is
 * the source of truth for the member's own preferences — including the timezone
 * an enabled brief requires — and is deleted by membership, user and
 * organization cleanup without any background reader refilling it. A cleanup
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
 * proves the owner with exactly this call rather than reimplementing the
 * subject admission, the lock mode or the stamp comparison. It deliberately
 * does not compare an admission's parent generation, because such a stage has
 * no admission to compare: deleting the parent cascades its occurrence away, so
 * a surviving occurrence is itself the proof that the parent never changed.
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
  const admission = await settle(
    assertErasureSubjectWritable(tx, [
      { subjectKind: "organization", subjectId: owner.orgId },
      { subjectKind: "user", subjectId: owner.userId },
    ]),
  );
  if (!admission.ok) {
    // A closed B1 owner is a normal refusal, not an unhandled preview error.
    if (
      admission.error instanceof Error &&
      admission.error.message === "account_erasure:subject_closed"
    ) {
      return undefined;
    }
    throw admission.error;
  }
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
 * Revoke collection authority without destroying pending occurrences. Durable
 * user deletion can use this at the enqueue boundary, retaining occurrences
 * for B1 capture before eventual cleanup. FOR UPDATE must precede the stamp:
 * a non-key UPDATE alone does not conflict with a claim's FOR KEY SHARE, and
 * could allow a stale claim to commit alongside revocation.
 */
export async function markMorningBriefCollectionOwnershipRevoked(
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
}

/**
 * After capture, atomically revoke and remove occurrences in the first legacy
 * cleanup transaction. Claims that committed before this lock are deleted;
 * later claims observe the durable stamp. In-flight provider reads cannot be
 * cancelled, but their results can no longer be accepted or persisted.
 */
export async function revokeMorningBriefCollectionOwnership(
  tx: Tx,
  scope: MorningBriefCollectionRevocationScope,
  at: Date,
): Promise<void> {
  await markMorningBriefCollectionOwnershipRevoked(tx, scope, at);
  await tx
    .delete(morningBriefCollectionOccurrences)
    .where(revocationWhere(scope));
}
