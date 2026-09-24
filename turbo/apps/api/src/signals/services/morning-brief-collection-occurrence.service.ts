import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import {
  MORNING_BRIEF_COLLECTION_VERSION,
  morningBriefCollectionOccurrences,
} from "@okouai/db/schema/morning-brief-collection-occurrence";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq, gt, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { ReadonlyDb } from "../external/db";
import { settle } from "../utils";

/**
 * Occurrence, attempt and lease ownership for the Morning Brief collector.
 *
 * Every function here is a database boundary only: no provider read, no network
 * call and no source content passes through it. The rules it enforces are
 * described in [the collection contract](../../../../../../docs/morning-brief-collection.md).
 */

/** How long a claimed attempt owns the occurrence before it can be reclaimed. */
const MORNING_BRIEF_COLLECTION_LEASE_MS = 60_000;

/** Total attempts one occurrence may ever consume. */
const MORNING_BRIEF_COLLECTION_MAX_ATTEMPTS = 3;

/** How long an occurrence stays claimable after it was first admitted. */
const MORNING_BRIEF_COLLECTION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface MorningBriefCollectionOwner {
  readonly orgId: string;
  readonly userId: string;
}

/** The member preference row an admission resolved its owner against. */
interface MorningBriefCollectionOwnerRow {
  readonly timezone: string | null;
  /**
   * When that durable parent row was created.
   *
   * Ordinary preference writes upsert the row and leave this untouched, while
   * membership, user and organization cleanup delete it and a later rejoin
   * inserts a new one. It is therefore the local generation of the parent an
   * occurrence hangs from, and it is what the claim compares so a request
   * admitted against the deleted generation cannot write under its
   * replacement. It is deliberately not part of the occurrence's frozen
   * binding: deleting the parent cascades every occurrence away, so a surviving
   * row always hangs from the generation that admitted it.
   */
  readonly memberCreatedAt: Date;
}

/** The identity and frozen scope a claim is admitted with. */
interface MorningBriefCollectionAdmission {
  readonly owner: MorningBriefCollectionOwner;
  readonly memberCreatedAt: Date;
  readonly scheduledFor: Date;
  readonly collectionKind: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly timezone: string;
  readonly membershipId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly agentId: string;
  /**
   * The native Slack binding, present exactly for a Slack-only occurrence.
   *
   * A source-independent occurrence has no single binding to pin — its owner
   * may have no Slack installation at all — so it carries null here rather than
   * a placeholder the comparison below would treat as a real workspace.
   */
  readonly slackWorkspaceId: string | null;
  readonly slackUserId: string | null;
}

export interface MorningBriefCollectionClaim {
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export type MorningBriefCollectionOccurrenceRow =
  typeof morningBriefCollectionOccurrences.$inferSelect;

type MorningBriefCollectionClaimResult =
  | { readonly kind: "claimed"; readonly claim: MorningBriefCollectionClaim }
  | {
      readonly kind: "already-completed";
      readonly occurrence: MorningBriefCollectionOccurrenceRow;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "in-progress"
        | "retry-pending"
        | "attempts-exhausted"
        | "expired"
        | "binding-changed"
        | "owner-revoked";
    };

type MorningBriefCollectionFinalizeResult =
  | {
      readonly kind: "finalized";
      readonly occurrence: MorningBriefCollectionOccurrenceRow;
      /** The admitted instant this completion was written with. */
      readonly at: Date;
    }
  | { readonly kind: "claim-lost" }
  | { readonly kind: "owner-revoked" }
  | { readonly kind: "binding-changed" };

/**
 * Whether a completion may still be written, decided after every lock wait.
 *
 * This layer owns database ownership and knows nothing about the caller or the
 * owner's live authority, so the one decision it cannot make itself is injected
 * as a callback. There is deliberately no default: a finalization without a
 * final admission would be an always-allow path.
 */
export type MorningBriefCollectionFinalAdmission =
  | { readonly kind: "admitted" }
  | {
      readonly kind: "rejected";
      readonly reason: "owner-revoked" | "binding-changed";
    };

/**
 * The last check a completion passes, taken inside its own transaction.
 *
 * It runs after the owner and occurrence locks and before any mutation, with
 * the persisted occurrence it is about to write. Throwing from it unwinds the
 * whole transaction, which is how a cancelled caller leaves nothing behind.
 */
type MorningBriefCollectionFinalAdmit = (
  tx: Tx,
  occurrence: MorningBriefCollectionOccurrenceRow,
) => Promise<MorningBriefCollectionFinalAdmission>;

/** The two decisions a finalization takes from its caller. */
interface MorningBriefCollectionFinalization {
  /** Sampled after every wait, immediately before the guarded write. */
  readonly clock: () => Date;
  readonly admit: MorningBriefCollectionFinalAdmit;
}

/** The terminal facts a finished attempt records. Never source content. */
interface MorningBriefCollectionCompletion {
  readonly status: "completed" | "failed";
  readonly outcome: NonNullable<MorningBriefCollectionOccurrenceRow["outcome"]>;
  readonly retryAfterSeconds?: number;
  readonly counts?: {
    readonly channels: number;
    readonly threads: number;
    readonly messages: number;
    readonly requests: number;
  };
  readonly truncated?: boolean;
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
