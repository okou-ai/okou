import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import {
  MORNING_BRIEF_COLLECTION_VERSION,
  morningBriefCollectionOccurrences,
} from "@okouai/db/schema/morning-brief-collection-occurrence";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq, gt, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { ReadonlyDb } from "../external/db";

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
export interface MorningBriefCollectionAdmission {
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
export interface MorningBriefCollectionCompletion {
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

function occurrenceKey(
  admission: Pick<
    MorningBriefCollectionAdmission,
    "owner" | "scheduledFor" | "collectionKind"
  >,
): SQL | undefined {
  return and(
    eq(morningBriefCollectionOccurrences.orgId, admission.owner.orgId),
    eq(morningBriefCollectionOccurrences.userId, admission.owner.userId),
    eq(morningBriefCollectionOccurrences.scheduledFor, admission.scheduledFor),
    eq(
      morningBriefCollectionOccurrences.collectionKind,
      admission.collectionKind,
    ),
    eq(
      morningBriefCollectionOccurrences.collectionVersion,
      MORNING_BRIEF_COLLECTION_VERSION,
    ),
  );
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
  await assertErasureSubjectWritable(tx, [
    { subjectKind: "organization", subjectId: owner.orgId },
    { subjectKind: "user", subjectId: owner.userId },
  ]);
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

/**
 * The same lock, plus the parent generation this admission resolved against.
 *
 * The stamp dies with the row, so it cannot answer the case admission is
 * exposed to: a cleanup that ran to completion, followed by a legitimate rejoin
 * whose ordinary preference write inserts an unstamped replacement parent.
 * `created_at` closes that one. It is stable across every preference upsert and
 * new for every recreated row, so an admission resolved against the deleted
 * generation is refused before it claims an attempt, reaches the provider, or
 * leaves a stale occurrence in the rejoined member's way. Only admission can be
 * stale this way, which is why the shared fence above stays narrower.
 */
async function lockAdmittedCollectionOwner(
  tx: Tx,
  admission: Pick<MorningBriefCollectionAdmission, "owner" | "memberCreatedAt">,
): Promise<boolean> {
  const member = await lockOwnerRow(tx, admission.owner);
  return (
    member !== undefined &&
    member.revokedAt === null &&
    member.createdAt.getTime() === admission.memberCreatedAt.getTime()
  );
}

/**
 * Read the member preference row an admission must hang from.
 *
 * This is the same canonical row the timezone comes from, read once so the
 * admission also carries the parent generation its claim is checked against.
 */
export async function loadMorningBriefCollectionOwnerRow(
  db: Pick<ReadonlyDb, "select">,
  owner: MorningBriefCollectionOwner,
): Promise<MorningBriefCollectionOwnerRow | null> {
  const [member] = await db
    .select({
      timezone: orgMembersMetadata.timezone,
      memberCreatedAt: orgMembersMetadata.createdAt,
    })
    .from(orgMembersMetadata)
    .where(memberKey(owner))
    .limit(1);
  return member ?? null;
}

/**
 * Take the occurrence row itself before any decision is made about it.
 *
 * Every wait this transition can block on happens at or before this statement:
 * the erasure and member locks above, then this row lock behind a concurrent
 * claimant. The decision clock is therefore sampled after all of them, and the
 * guarded write that follows cannot queue again.
 */
async function lockOccurrence(
  tx: Tx,
  admission: MorningBriefCollectionAdmission,
): Promise<MorningBriefCollectionOccurrenceRow | undefined> {
  const [row] = await tx
    .select()
    .from(morningBriefCollectionOccurrences)
    .where(occurrenceKey(admission))
    .limit(1)
    .for("update");
  return row;
}

/**
 * Every frozen field a retry must still match to reuse an occurrence.
 *
 * It is exported because a later stage that holds this occurrence has to prove
 * the same thing before it acts on the owner's behalf or releases what it
 * produced: the binding an occurrence was admitted under is the only authority
 * its results ever had. A different current binding is a different authority,
 * never a licence to reuse the old one's work.
 */
export function morningBriefCollectionBindingMatches(
  row: MorningBriefCollectionOccurrenceRow,
  admission: MorningBriefCollectionAdmission,
): boolean {
  return (
    row.membershipId === admission.membershipId &&
    row.workflowId === admission.workflowId &&
    row.automationId === admission.automationId &&
    row.agentId === admission.agentId &&
    row.slackWorkspaceId === admission.slackWorkspaceId &&
    row.slackUserId === admission.slackUserId &&
    row.timezone === admission.timezone &&
    row.windowStart.getTime() === admission.windowStart.getTime() &&
    row.windowEnd.getTime() === admission.windowEnd.getTime()
  );
}

function retryAvailableAt(
  row: MorningBriefCollectionOccurrenceRow,
): Date | null {
  return row.retryAfterSeconds !== null && row.finishedAt !== null
    ? new Date(row.finishedAt.getTime() + row.retryAfterSeconds * 1000)
    : null;
}

function leaseValues(claim: MorningBriefCollectionClaim, at: Date) {
  return {
    status: "running" as const,
    attempt: claim.attempt,
    leaseToken: claim.leaseToken,
    leaseExpiresAt: claim.leaseExpiresAt,
    outcome: null,
    retryAfterSeconds: null,
    channelCount: null,
    threadCount: null,
    messageCount: null,
    requestCount: null,
    truncated: null,
    claimedAt: at,
    finishedAt: null,
    updatedAt: at,
  };
}

/**
 * Decide whether this attempt may take over an existing occurrence.
 *
 * `at` is the decision's own instant, sampled after every lock this transition
 * waited on, so a lease, retry deadline or lifetime that elapsed during those
 * waits is treated as elapsed rather than as the request's earlier reading.
 */
function reclaimDecision(
  row: MorningBriefCollectionOccurrenceRow,
  at: Date,
): Extract<MorningBriefCollectionClaimResult, { kind: "rejected" }> | null {
  if (row.status === "running" && row.leaseExpiresAt !== null) {
    // Exact deadline equality is an expired lease: the holder may no longer
    // finalize, so the occurrence is reclaimable at the same instant.
    if (row.leaseExpiresAt.getTime() > at.getTime()) {
      return { kind: "rejected", reason: "in-progress" };
    }
  }
  // Equality with the lifetime deadline is already expired, exactly as it is
  // for a lease: the occurrence stops being claimable at that instant rather
  // than one millisecond later. `created_at` is never rewritten by a re-claim,
  // so this measures the logical occurrence rather than its latest attempt.
  if (
    at.getTime() - row.createdAt.getTime() >=
    MORNING_BRIEF_COLLECTION_MAX_LIFETIME_MS
  ) {
    return { kind: "rejected", reason: "expired" };
  }
  if (row.attempt >= MORNING_BRIEF_COLLECTION_MAX_ATTEMPTS) {
    return { kind: "rejected", reason: "attempts-exhausted" };
  }
  const retryAt = retryAvailableAt(row);
  if (retryAt !== null && retryAt.getTime() > at.getTime()) {
    return { kind: "rejected", reason: "retry-pending" };
  }
  return null;
}

/**
 * Take exclusive ownership of one attempt on this occurrence.
 *
 * The owner and the occurrence row are locked before anything is decided, so
 * concurrent invocations converge on a single admitted claimant and the clock
 * this decision uses is read after those waits rather than before them. A
 * completed occurrence is never re-collected, a live lease is never stolen, and
 * no existing occurrence — completed, failed or running — is reused unless its
 * frozen window, timezone, membership generation, installation, schedule, Agent
 * and Slack binding are all still exactly the admitted ones.
 */
export async function claimMorningBriefCollection(
  tx: Tx,
  admission: MorningBriefCollectionAdmission,
  leaseToken: string,
  clock: () => Date,
): Promise<MorningBriefCollectionClaimResult> {
  if (!(await lockAdmittedCollectionOwner(tx, admission))) {
    return { kind: "rejected", reason: "owner-revoked" };
  }
  let current = await lockOccurrence(tx, admission);
  if (!current) {
    const at = clock();
    const claim = {
      attempt: 1,
      leaseToken,
      leaseExpiresAt: collectionLeaseExpiry(at),
    };
    const [created] = await tx
      .insert(morningBriefCollectionOccurrences)
      .values({
        orgId: admission.owner.orgId,
        userId: admission.owner.userId,
        scheduledFor: admission.scheduledFor,
        collectionKind: admission.collectionKind,
        collectionVersion: MORNING_BRIEF_COLLECTION_VERSION,
        windowStart: admission.windowStart,
        windowEnd: admission.windowEnd,
        timezone: admission.timezone,
        membershipId: admission.membershipId,
        workflowId: admission.workflowId,
        automationId: admission.automationId,
        agentId: admission.agentId,
        slackWorkspaceId: admission.slackWorkspaceId,
        slackUserId: admission.slackUserId,
        createdAt: at,
        ...leaseValues(claim, at),
      })
      .onConflictDoNothing()
      .returning({ attempt: morningBriefCollectionOccurrences.attempt });
    if (created) {
      return { kind: "claimed", claim };
    }
    // Another claimant committed its own first attempt between the lock above
    // and this insert, so serialize behind its row and decide against that.
    current = await lockOccurrence(tx, admission);
    if (!current) {
      // It was removed again while this insert waited for it, which means a
      // cleanup or Agent deletion won. Refuse rather than resurrect it.
      return { kind: "rejected", reason: "owner-revoked" };
    }
  }

  const at = clock();
  if (!morningBriefCollectionBindingMatches(current, admission)) {
    return { kind: "rejected", reason: "binding-changed" };
  }
  if (current.status === "completed") {
    return { kind: "already-completed", occurrence: current };
  }
  const rejected = reclaimDecision(current, at);
  if (rejected) {
    return rejected;
  }
  const reclaimed = {
    attempt: current.attempt + 1,
    leaseToken,
    leaseExpiresAt: collectionLeaseExpiry(at),
  };
  await tx
    .update(morningBriefCollectionOccurrences)
    .set(leaseValues(reclaimed, at))
    .where(occurrenceKey(admission));
  return { kind: "claimed", claim: reclaimed };
}

/**
 * Record what this attempt observed, but only if it is still the live owner.
 *
 * The owner and the occurrence row are locked first, and only then is anything
 * decided: waiting for either lock can outlast a 60-second lease, so a decision
 * taken before those waits would let an attempt that lost its lease — or its
 * caller, or its owner's authority — complete anyway. `admit` is therefore
 * consulted after both locks and before any mutation is issued, and the
 * admission instant is read last, immediately before the guarded write.
 *
 * Comparing the persisted occurrence with the admission cannot replace that
 * callback. Both copies are frozen, so they still agree after a Settings
 * disable, an Agent transfer or a Slack rebinding that committed during the
 * wait; only a fresh resolution notices. Rejecting here writes nothing at all,
 * which is strictly stronger than unwinding a committed completion.
 *
 * The update itself stays one conditional statement over the exact occurrence,
 * attempt, lease token, membership generation, running status and a deadline
 * strictly after that instant, and it can no longer queue because this
 * transaction already holds the row. A stale worker therefore neither
 * overwrites a newer claimant nor has its discarded bundle accepted, and a
 * cleanup that won the race leaves this with nothing to finalize.
 */
export async function finalizeMorningBriefCollection(
  tx: Tx,
  admission: MorningBriefCollectionAdmission,
  claim: MorningBriefCollectionClaim,
  completion: MorningBriefCollectionCompletion,
  finalization: MorningBriefCollectionFinalization,
): Promise<MorningBriefCollectionFinalizeResult> {
  if (!(await lockAdmittedCollectionOwner(tx, admission))) {
    return { kind: "owner-revoked" };
  }
  const current = await lockOccurrence(tx, admission);
  if (!current || !morningBriefCollectionBindingMatches(current, admission)) {
    return { kind: "claim-lost" };
  }
  const admitted = await finalization.admit(tx, current);
  if (admitted.kind === "rejected") {
    return admitted.reason === "owner-revoked"
      ? { kind: "owner-revoked" }
      : { kind: "binding-changed" };
  }
  const at = finalization.clock();
  const [finalized] = await tx
    .update(morningBriefCollectionOccurrences)
    .set({
      status: completion.status,
      outcome: completion.outcome,
      retryAfterSeconds: completion.retryAfterSeconds ?? null,
      channelCount: completion.counts?.channels ?? null,
      threadCount: completion.counts?.threads ?? null,
      messageCount: completion.counts?.messages ?? null,
      requestCount: completion.counts?.requests ?? null,
      truncated: completion.truncated ?? null,
      leaseToken: null,
      leaseExpiresAt: null,
      finishedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        occurrenceKey(admission),
        eq(morningBriefCollectionOccurrences.status, "running"),
        eq(morningBriefCollectionOccurrences.attempt, claim.attempt),
        eq(morningBriefCollectionOccurrences.leaseToken, claim.leaseToken),
        eq(
          morningBriefCollectionOccurrences.membershipId,
          admission.membershipId,
        ),
        gt(morningBriefCollectionOccurrences.leaseExpiresAt, at),
      ),
    )
    .returning();
  return finalized
    ? { kind: "finalized", occurrence: finalized, at }
    : { kind: "claim-lost" };
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

/**
 * Read one occurrence's frozen scope and binding.
 *
 * The row is the only durable record of the authority a collection was
 * admitted under, so anything that later revalidates that authority compares
 * against this rather than against a caller-supplied copy.
 */
export async function readMorningBriefCollectionOccurrence(
  db: Pick<ReadonlyDb, "select">,
  key: Pick<
    MorningBriefCollectionAdmission,
    "owner" | "scheduledFor" | "collectionKind"
  >,
): Promise<MorningBriefCollectionOccurrenceRow | undefined> {
  const [row] = await db
    .select()
    .from(morningBriefCollectionOccurrences)
    .where(occurrenceKey(key))
    .limit(1);
  return row;
}

/** The next lease deadline for an attempt claimed at `at`. */
function collectionLeaseExpiry(at: Date): Date {
  return new Date(at.getTime() + MORNING_BRIEF_COLLECTION_LEASE_MS);
}

/** True while `claim` may still finalize. Equality with the deadline is expired. */
export function collectionLeaseHeld(
  claim: MorningBriefCollectionClaim,
  at: Date,
): boolean {
  return claim.leaseExpiresAt.getTime() > at.getTime();
}
