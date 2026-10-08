import { command } from "ccstate";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { writeDb$ } from "../external/db";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryStage1Watermarks } from "@okouai/db/schema/pi-memory-stage1-schedule";
import type { PiMemoryStage1Selection } from "./pi-memory-stage1-schedule.service";
import {
  piMemoryStage1SelectionLockPlans,
  piMemoryStage1DayConsumedByAnotherThread,
  piMemoryStage1LockedSelectionValid,
  piMemoryStage1SelectionSourcePlans,
  piMemoryStage1SelectionThreadEligible,
  piMemoryStage1SelectionRunEligible,
  piMemoryStage1SelectionConversationPlan,
  piMemoryStage1SelectionSourceMatches,
} from "./pi-memory-stage1-selection-plan";
import {
  getPiMemoryStage1AdmissionPrerequisiteSkipReason,
  type AdmitPiMemoryStage1CandidateArgs,
  type PiMemoryStage1AdmissionSkipReason,
} from "./pi-memory-stage1-admission-plan";

import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { piMemoryStage1WatermarkPlan } from "./pi-memory-stage1-watermark.service";
import { and, asc, eq, gt, gte, inArray, sql, type SQL } from "drizzle-orm";

import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";

import { piMemoryPhase2InputRevisionPlan } from "./pi-memory-phase2-job.service";
import { newStorageS3Location } from "./storage-s3-prefix.utils";

// Stage 1 admission and maintenance completion retain checkpoint blobs. Lock
// their existing owner first to avoid a parent/blob cycle with cleanup.
export async function lockPiMemoryCandidateStorage(
  tx: Tx,
  owner: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, owner.orgId),
        eq(storages.userId, owner.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .for("no key update");
}

async function retainCandidateReference(tx: Tx, hash: string): Promise<void> {
  const [retained] = await tx
    .update(blobs)
    .set({ refCount: sql`${blobs.refCount} + 1` })
    .where(eq(blobs.hash, hash))
    .returning({ hash: blobs.hash });
  if (!retained) {
    throw new Error("Pi memory candidate source blob does not exist");
  }
}

async function releaseCandidateReferences(
  tx: Tx,
  hashes: readonly string[],
): Promise<void> {
  const counts = new Map<string, number>();
  for (const hash of hashes) {
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  for (const [hash, count] of [...counts].sort(([a], [b]) => {
    return a.localeCompare(b);
  })) {
    const [released] = await tx
      .update(blobs)
      .set({ refCount: sql`${blobs.refCount} - ${count}` })
      .where(and(eq(blobs.hash, hash), gte(blobs.refCount, count)))
      .returning({ hash: blobs.hash });
    if (!released) {
      throw new Error(
        "Pi memory candidate source blob has no retained reference",
      );
    }
  }
}

async function insertCandidateRows(
  tx: Tx,
  rows: readonly (typeof piMemoryStage1Candidates.$inferInsert)[],
) {
  const created = await tx
    .insert(piMemoryStage1Candidates)
    .values([...rows])
    .onConflictDoNothing()
    .returning({
      memoryStorageId: piMemoryStage1Candidates.memoryStorageId,
      piSessionId: piMemoryStage1Candidates.piSessionId,
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
    });
  for (const row of [...created].sort((a, b) => {
    return a.sourceHistoryHash.localeCompare(b.sourceHistoryHash);
  })) {
    await retainCandidateReference(tx, row.sourceHistoryHash);
  }
  return created;
}

/** Lock parents before children, including standalone candidate retention cleanup. */
export async function deletePiMemoryStage1Candidates(
  tx: Tx,
  storageIds: readonly string[],
): Promise<number> {
  if (storageIds.length === 0) {
    return 0;
  }
  await tx
    .select({ id: storages.id })
    .from(storages)
    .where(inArray(storages.id, [...storageIds]))
    .orderBy(asc(storages.id))
    .for("no key update");
  const deleted = await tx
    .delete(piMemoryStage1Candidates)
    .where(inArray(piMemoryStage1Candidates.memoryStorageId, [...storageIds]))
    .returning({ hash: piMemoryStage1Candidates.sourceHistoryHash });
  await releaseCandidateReferences(
    tx,
    deleted.map((row) => {
      return row.hash;
    }),
  );
  return deleted.length;
}

/** The caller owns the transaction; never put external Clerk/S3 work in it. */
export async function deleteStoragesWithPiMemoryCandidates(
  tx: Tx,
  condition: SQL,
): Promise<number> {
  const parents = await tx
    .select({ id: storages.id })
    .from(storages)
    .where(condition)
    .orderBy(asc(storages.id))
    .for("update");
  const ids = parents.map((row) => {
    return row.id;
  });
  if (ids.length === 0) {
    return 0;
  }
  await deletePiMemoryStage1Candidates(tx, ids);
  const deleted = await tx
    .delete(storages)
    .where(inArray(storages.id, ids))
    .returning({ id: storages.id });
  return deleted.length;
}

type PiMemoryStage1Admission =
  | {
      readonly outcome: "created" | "exact_retry" | "replaced";
      readonly memoryStorageId: string;
      readonly piSessionId: string;
      readonly sourceHistoryHash: string;
    }
  | {
      readonly outcome: "skipped";
      readonly reason: PiMemoryStage1AdmissionSkipReason;
      readonly memoryStorageId?: string;
      readonly piSessionId?: string;
      readonly sourceHistoryHash?: string;
    };

async function ownsProductChatThread(
  tx: Tx,
  args: AdmitPiMemoryStage1CandidateArgs,
): Promise<boolean> {
  if (args.chatThreadId === null) {
    return false;
  }
  const [thread] = await tx
    .select({ id: chatThreads.id })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .innerJoin(
      chatThreads,
      and(
        eq(chatThreads.id, agentRuns.chatThreadId),
        eq(chatThreads.agentId, agentSessions.agentId),
      ),
    )
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.orgId, args.orgId),
        eq(chatThreads.id, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.orgId, args.orgId),
        eq(agents.orgId, args.orgId),
      ),
    )
    .limit(1);
  // Private maintenance has no product Agent/session/thread binding, even
  // though its run uses the same owner and the ordinary "agent" source.
  return thread !== undefined;
}

async function resolveMemoryStorageId(
  tx: Tx,
  args: Pick<AdmitPiMemoryStage1CandidateArgs, "orgId" | "userId">,
): Promise<string> {
  const [existing] = await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .for("no key update")
    .limit(1);
  if (existing) {
    return existing.id;
  }

  const location = newStorageS3Location(args.orgId);
  const [created] = await tx
    .insert(storages)
    .values({
      id: location.storageId,
      orgId: args.orgId,
      userId: args.userId,
      name: MEMORY_ARTIFACT_NAME,
      s3Prefix: location.s3Prefix,
    })
    .onConflictDoNothing()
    .returning({ id: storages.id });
  if (created) {
    return created.id;
  }

  const [winner] = await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .for("no key update")
    .limit(1);
  if (!winner) {
    throw new Error("Memory Storage create race produced no canonical row");
  }
  return winner.id;
}

/**
 * Ordered gates before any source read or candidate write: static
 * prerequisites, then Chat Thread ownership, then the owning Run's PiMemory
 * switch. The owner's identity decides the switch, never the caller; off means
 * the source is not read and no candidate is written or replaced.
 */
async function getPiMemoryStage1AdmissionSkipReason(
  tx: Tx,
  args: AdmitPiMemoryStage1CandidateArgs,
): Promise<PiMemoryStage1AdmissionSkipReason | null> {
  const prerequisiteSkipReason =
    getPiMemoryStage1AdmissionPrerequisiteSkipReason(args);
  if (prerequisiteSkipReason !== null) {
    return prerequisiteSkipReason;
  }
  if (!(await ownsProductChatThread(tx, args))) {
    return "not_owned_chat_thread";
  }
  const featureSwitchContextRows0 = await tx
    .select({
      userId: userFeatureSwitches.userId,
      switches: userFeatureSwitches.switches,
    })
    .from(userFeatureSwitches)
    .where(userFeatureSwitchRowCondition(args.orgId, args.userId));
  const featureSwitchContext = featureSwitchContextFromRows(
    args.orgId,
    args.userId,
    featureSwitchContextRows0,
  );
  return isFeatureEnabled(FeatureSwitchKey.PiMemory, featureSwitchContext)
    ? null
    : "pi_memory_disabled";
}

async function readPiMemoryCandidateSource(tx: Tx, runId: string) {
  const [source] = await tx
    .select({
      piSessionId: conversations.cliAgentSessionId,
      sourceHistoryHash: conversations.cliAgentSessionHistoryHash,
    })
    .from(conversations)
    .innerJoin(blobs, eq(conversations.cliAgentSessionHistoryHash, blobs.hash))
    .where(
      and(eq(conversations.runId, runId), eq(conversations.cliAgentType, "pi")),
    )
    .limit(1);
  return source;
}

export async function admitPiMemoryStage1Candidate(
  tx: Tx,
  args: AdmitPiMemoryStage1CandidateArgs,
): Promise<PiMemoryStage1Admission> {
  const skipReason = await getPiMemoryStage1AdmissionSkipReason(tx, args);
  if (skipReason !== null) {
    return { outcome: "skipped", reason: skipReason };
  }

  const source = await readPiMemoryCandidateSource(tx, args.runId);
  if (!source?.sourceHistoryHash) {
    return { outcome: "skipped", reason: "history_not_hash_backed" };
  }

  const memoryStorageId = await resolveMemoryStorageId(tx, args);
  const eligibleAt = new Date(args.completedAt.getTime() + args.idleDelayMs);
  const [created] = await insertCandidateRows(tx, [
    {
      memoryStorageId,
      orgId: args.orgId,
      userId: args.userId,
      piSessionId: source.piSessionId,
      sourceRunId: args.runId,
      sourceHistoryHash: source.sourceHistoryHash,
      sourceCompletedAt: args.completedAt,
      eligibleAt,
      status: "pending",
    },
  ]);
  if (created) {
    return {
      outcome: "created",
      memoryStorageId,
      piSessionId: source.piSessionId,
      sourceHistoryHash: source.sourceHistoryHash,
    };
  }

  const [current] = await tx
    .select({
      sourceCompletedAt: piMemoryStage1Candidates.sourceCompletedAt,
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
    })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, source.piSessionId),
      ),
    )
    .for("update", { of: piMemoryStage1Candidates })
    .limit(1);
  if (!current) {
    throw new Error("Pi memory candidate conflict produced no canonical row");
  }
  if (current.sourceHistoryHash === source.sourceHistoryHash) {
    return {
      outcome: "exact_retry",
      memoryStorageId,
      piSessionId: source.piSessionId,
      sourceHistoryHash: source.sourceHistoryHash,
    };
  }
  if (current.sourceCompletedAt >= args.completedAt) {
    return {
      outcome: "skipped",
      reason: "stale_source",
      memoryStorageId,
      piSessionId: source.piSessionId,
      sourceHistoryHash: source.sourceHistoryHash,
    };
  }

  const [replaced] = await tx
    .update(piMemoryStage1Candidates)
    .set({
      sourceRunId: args.runId,
      sourceHistoryHash: source.sourceHistoryHash,
      sourceCompletedAt: args.completedAt,
      eligibleAt,
      status: "pending",
      leaseToken: null,
      leaseExpiresAt: null,
      retryAt: null,
      retryCount: 0,
      lastErrorClass: null,
      rawMemory: null,
      rolloutSummary: null,
      rolloutSlug: null,
      generatedAt: null,
      lastSelectedSourceHistoryHash: null,
      usageCount: 0,
      lastUsedAt: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, source.piSessionId),
        eq(
          piMemoryStage1Candidates.sourceHistoryHash,
          current.sourceHistoryHash,
        ),
      ),
    )
    .returning({
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
    });
  if (!replaced) {
    throw new Error("Locked Pi memory candidate lost its source replacement");
  }
  await retainCandidateReference(tx, replaced.sourceHistoryHash);
  await releaseCandidateReferences(tx, [current.sourceHistoryHash]);
  return {
    outcome: "replaced",
    memoryStorageId,
    piSessionId: source.piSessionId,
    sourceHistoryHash: source.sourceHistoryHash,
  };
}

export type PiMemoryStage1CommitResult =
  | {
      readonly kind: "succeeded";
      readonly rawMemory: string;
      readonly rolloutSummary: string;
      readonly rolloutSlug?: string;
    }
  | { readonly kind: "succeeded_no_output" }
  | {
      readonly kind: "retryable_failure";
      readonly retryAt: Date;
      readonly errorClass: string;
    }
  | { readonly kind: "terminal_failure"; readonly errorClass: string };

interface CommitPiMemoryStage1CandidateArgs {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
  readonly leaseToken: string;
  readonly committedAt: Date;
  readonly result: PiMemoryStage1CommitResult;
  readonly selectedSource?: {
    readonly chatThreadId: string;
    readonly sourceRunId: string;
    readonly sourceActivityAt: Date;
  };
}

function candidateCommitValues(args: CommitPiMemoryStage1CandidateArgs) {
  const common = {
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: args.committedAt,
  };
  const resultValues =
    args.result.kind === "succeeded"
      ? {
          status: args.result.kind,
          rawMemory: args.result.rawMemory,
          rolloutSummary: args.result.rolloutSummary,
          rolloutSlug: args.result.rolloutSlug ?? null,
          generatedAt: args.committedAt,
          lastSelectedSourceHistoryHash: null,
          retryAt: null,
          lastErrorClass: null,
        }
      : args.result.kind === "succeeded_no_output"
        ? {
            status: args.result.kind,
            rawMemory: null,
            rolloutSummary: null,
            rolloutSlug: null,
            generatedAt: args.committedAt,
            lastSelectedSourceHistoryHash: null,
            retryAt: null,
            lastErrorClass: null,
          }
        : args.result.kind === "retryable_failure"
          ? {
              status: args.result.kind,
              rawMemory: null,
              rolloutSummary: null,
              rolloutSlug: null,
              generatedAt: null,
              lastSelectedSourceHistoryHash: null,
              retryAt: args.result.retryAt,
              retryCount: sql`${piMemoryStage1Candidates.retryCount} + 1`,
              lastErrorClass: args.result.errorClass,
            }
          : {
              status: args.result.kind,
              rawMemory: null,
              rolloutSummary: null,
              rolloutSlug: null,
              generatedAt: null,
              lastSelectedSourceHistoryHash: null,
              retryAt: null,
              lastErrorClass: args.result.errorClass,
            };
  return { ...common, ...resultValues };
}
function candidateCommitCondition(args: CommitPiMemoryStage1CandidateArgs) {
  return and(
    eq(piMemoryStage1Candidates.memoryStorageId, args.memoryStorageId),
    eq(piMemoryStage1Candidates.orgId, args.orgId),
    eq(piMemoryStage1Candidates.userId, args.userId),
    eq(piMemoryStage1Candidates.piSessionId, args.piSessionId),
    eq(piMemoryStage1Candidates.sourceHistoryHash, args.sourceHistoryHash),
    args.selectedSource
      ? eq(
          piMemoryStage1Candidates.sourceRunId,
          args.selectedSource.sourceRunId,
        )
      : undefined,
    eq(piMemoryStage1Candidates.status, "leased"),
    eq(piMemoryStage1Candidates.leaseToken, args.leaseToken),
    gt(piMemoryStage1Candidates.leaseExpiresAt, args.committedAt),
  );
}

function candidateCommitPlan(args: CommitPiMemoryStage1CandidateArgs) {
  const builder = new QueryBuilder();
  return {
    condition: candidateCommitCondition(args),
    values: candidateCommitValues(args),
    sourceThread: args.selectedSource
      ? builder
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, args.selectedSource.chatThreadId),
              eq(chatThreads.userId, args.userId),
            ),
          )
          .for("key share")
          .as("candidate_source_thread")
      : undefined,
    storage: builder
      .select({ id: storages.id })
      .from(storages)
      .where(
        and(
          eq(storages.id, args.memoryStorageId),
          eq(storages.orgId, args.orgId),
          eq(storages.userId, args.userId),
        ),
      )
      .for("key share")
      .as("candidate_owner_storage"),
    watermark: args.selectedSource
      ? piMemoryStage1WatermarkPlan({
          memoryStorageId: args.memoryStorageId,
          orgId: args.orgId,
          userId: args.userId,
          chatThreadId: args.selectedSource.chatThreadId,
          sourceActivityAt: args.selectedSource.sourceActivityAt,
          sourceHistoryHash: args.sourceHistoryHash,
        })
      : undefined,
    revision: piMemoryPhase2InputRevisionPlan({
      memoryStorageId: args.memoryStorageId,
      orgId: args.orgId,
      userId: args.userId,
      enqueuedAt: args.committedAt,
    }),
  };
}

/** Finite result reconciliation: the output, watermark and Phase2 revision commit together. */
export const commitPiMemoryStage1Candidate$ = command(
  async (
    { set },
    args: CommitPiMemoryStage1CandidateArgs,
    selectionToValidate?: PiMemoryStage1Selection,
  ): Promise<boolean> => {
    const plan = candidateCommitPlan(args);
    return await set(writeDb$).transaction(async (tx) => {
      if (selectionToValidate) {
        const selection = selectionToValidate;
        if (selection.day !== args.committedAt.toISOString().slice(0, 10)) {
          return false;
        }
        const locks = piMemoryStage1SelectionLockPlans(selection);
        const [lockedThread] = await tx.select().from(locks.thread);
        if (!lockedThread) {
          return false;
        }
        await tx.select().from(locks.storage);
        const [day] = await tx.select().from(locks.day);
        if (!piMemoryStage1DayConsumedByAnotherThread(selection, day)) {
          return false;
        }
        const [frozen] = await tx.select().from(locks.frozen);
        if (!frozen) {
          return false;
        }
        const observedAt = nowDate();
        if (selection.day !== observedAt.toISOString().slice(0, 10)) {
          return false;
        }
        const features = await tx.select().from(locks.features);
        if (
          !piMemoryStage1LockedSelectionValid(
            selection,
            { day, frozen: !!frozen, features },
            observedAt,
          )
        ) {
          return false;
        }
        const sourcePlans = piMemoryStage1SelectionSourcePlans(selection);
        const [thread] = await tx.select().from(sourcePlans.thread);
        if (!thread) {
          return false;
        }
        const [active] = await tx.select().from(sourcePlans.active);
        if (
          !piMemoryStage1SelectionThreadEligible(
            thread,
            !!active,
            args.committedAt,
          )
        ) {
          return false;
        }
        const [latest] = await tx.select().from(sourcePlans.latest);
        if (
          !piMemoryStage1SelectionRunEligible(
            latest,
            selection,
            args.committedAt,
          )
        ) {
          return false;
        }
        const [source] = await tx
          .select()
          .from(piMemoryStage1SelectionConversationPlan(selection, latest));
        if (
          !piMemoryStage1SelectionSourceMatches(
            selection,
            latest,
            thread,
            source,
          )
        ) {
          return false;
        }
      }
      // Thread -> Storage -> candidate -> watermark/Phase2, including unrevalidated
      // post-midnight reconciliation of an already admitted provider result.
      if (plan.sourceThread) {
        const [thread] = await tx.select().from(plan.sourceThread);
        if (!thread) {
          return false;
        }
      }
      const [owner] = await tx.select().from(plan.storage);
      if (!owner) {
        return false;
      }
      const [committed] = await tx
        .update(piMemoryStage1Candidates)
        .set(plan.values)
        .where(plan.condition)
        .returning({
          memoryStorageId: piMemoryStage1Candidates.memoryStorageId,
        });
      if (!committed) {
        return false;
      }
      if (
        args.result.kind === "succeeded" ||
        args.result.kind === "succeeded_no_output"
      ) {
        if (plan.watermark) {
          await tx
            .insert(piMemoryStage1Watermarks)
            .values(plan.watermark.values)
            .onConflictDoUpdate(plan.watermark.conflict);
        }
        const [advanced] = await tx
          .insert(piMemoryPhase2Jobs)
          .values(plan.revision.values)
          .onConflictDoUpdate(plan.revision.conflict)
          .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
        if (!advanced) {
          throw new Error("Pi memory Phase 2 input revision did not advance");
        }
      }
      return true;
    });
  },
);
