import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import {
  MORNING_BRIEF_COLLECTION_VERSION,
  morningBriefCollectionOccurrences,
} from "@okouai/db/schema/morning-brief-collection-occurrence";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq, gt, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db, ReadonlyDb } from "../external/db";

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

/** The identity and frozen scope a claim is admitted with. */
export interface MorningBriefCollectionAdmission {
  readonly owner: MorningBriefCollectionOwner;
  readonly scheduledFor: Date;
  readonly collectionKind: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly timezone: string;
  readonly membershipId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly agentId: string;
  readonly slackWorkspaceId: string;
  readonly slackUserId: string;
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
    }
  | { readonly kind: "claim-lost" }
  | { readonly kind: "owner-revoked" };

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
 */
export async function lockCollectionOwner(
  tx: Tx,
  owner: MorningBriefCollectionOwner,
): Promise<boolean> {
  await assertErasureSubjectWritable(tx, [
    { subjectKind: "organization", subjectId: owner.orgId },
    { subjectKind: "user", subjectId: owner.userId },
  ]);
  const [member] = await tx
    .select({ orgId: orgMembersMetadata.orgId })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, owner.orgId),
        eq(orgMembersMetadata.userId, owner.userId),
      ),
    )
    .limit(1)
    .for("key share");
  return member !== undefined;
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

function reclaimDecision(
  row: MorningBriefCollectionOccurrenceRow,
  admission: MorningBriefCollectionAdmission,
  at: Date,
): Extract<MorningBriefCollectionClaimResult, { kind: "rejected" }> | null {
  if (row.status === "running" && row.leaseExpiresAt !== null) {
    // Exact deadline equality is an expired lease: the holder may no longer
    // finalize, so the occurrence is reclaimable at the same instant.
    if (row.leaseExpiresAt.getTime() > at.getTime()) {
      return { kind: "rejected", reason: "in-progress" };
    }
  }
  if (
    at.getTime() - row.createdAt.getTime() >
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
  if (!morningBriefCollectionBindingMatches(row, admission)) {
    return { kind: "rejected", reason: "binding-changed" };
  }
  return null;
}

/**
 * Take exclusive ownership of one attempt on this occurrence.
 *
 * Concurrent invocations converge on a single admitted claimant: the losing
 * insert finds the conflicting row, then serializes behind `FOR UPDATE` before
 * deciding. A completed occurrence is never re-collected, a live lease is never
 * stolen, and a retry may only reuse an occurrence whose frozen window,
 * membership generation, installation, Agent and Slack binding are unchanged.
 */
export async function claimMorningBriefCollection(
  tx: Tx,
  admission: MorningBriefCollectionAdmission,
  claim: MorningBriefCollectionClaim,
  at: Date,
): Promise<MorningBriefCollectionClaimResult> {
  if (!(await lockCollectionOwner(tx, admission.owner))) {
    return { kind: "rejected", reason: "owner-revoked" };
  }
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
      ...leaseValues({ ...claim, attempt: 1 }, at),
    })
    .onConflictDoNothing()
    .returning({ attempt: morningBriefCollectionOccurrences.attempt });
  if (created) {
    return { kind: "claimed", claim: { ...claim, attempt: 1 } };
  }

  const [current] = await tx
    .select()
    .from(morningBriefCollectionOccurrences)
    .where(occurrenceKey(admission))
    .for("update")
    .limit(1);
  if (!current) {
    // The conflicting row was removed while this insert waited for it, which
    // means a cleanup or Agent deletion won. Refuse rather than resurrect it.
    return { kind: "rejected", reason: "owner-revoked" };
  }
  if (current.status === "completed") {
    return { kind: "already-completed", occurrence: current };
  }
  const rejected = reclaimDecision(current, admission, at);
  if (rejected) {
    return rejected;
  }
  const reclaimed = { ...claim, attempt: current.attempt + 1 };
  await tx
    .update(morningBriefCollectionOccurrences)
    .set(leaseValues(reclaimed, at))
    .where(occurrenceKey(admission));
  return { kind: "claimed", claim: reclaimed };
}

/**
 * Record what this attempt observed, but only if it is still the live owner.
 *
 * The update is conditional on the exact occurrence, attempt, lease token,
 * running status and an unexpired deadline, so a stale worker can neither
 * overwrite a newer claimant nor have its discarded bundle accepted. The owner
 * lock is retaken first, so a cleanup that won the race leaves this with
 * nothing to finalize instead of allowing a completed row to survive it.
 */
export async function finalizeMorningBriefCollection(
  tx: Tx,
  admission: MorningBriefCollectionAdmission,
  claim: MorningBriefCollectionClaim,
  completion: MorningBriefCollectionCompletion,
  at: Date,
): Promise<MorningBriefCollectionFinalizeResult> {
  if (!(await lockCollectionOwner(tx, admission.owner))) {
    return { kind: "owner-revoked" };
  }
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
    ? { kind: "finalized", occurrence: finalized }
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

/**
 * Drop this scope's collection ownership inside a cleanup transaction.
 *
 * Called from the earliest local revocation each cleanup path already commits,
 * so an owner loses collection ownership before the rest of their state is torn
 * down. Deleting the row leaves a running attempt with nothing to finalize; its
 * in-flight Slack requests cannot be retracted, but its bundle can no longer be
 * accepted or returned. Other owners are untouched. The member and Agent
 * cascades remain the final guarantee when this runs first.
 */
export async function revokeMorningBriefCollectionOwnership(
  executor: Pick<Db, "delete"> | Tx,
  scope: MorningBriefCollectionRevocationScope,
): Promise<void> {
  await executor
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
export function collectionLeaseExpiry(at: Date): Date {
  return new Date(at.getTime() + MORNING_BRIEF_COLLECTION_LEASE_MS);
}

/** True while `claim` may still finalize. Equality with the deadline is expired. */
export function collectionLeaseHeld(
  claim: MorningBriefCollectionClaim,
  at: Date,
): boolean {
  return claim.leaseExpiresAt.getTime() > at.getTime();
}
