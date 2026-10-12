import { command } from "ccstate";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { writeDb$ } from "../external/db";
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

import { piMemoryStage1WatermarkPlan } from "./pi-memory-stage1-watermark.service";
import { and, asc, eq, gt, gte, inArray, sql, type SQL } from "drizzle-orm";

import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { blobs } from "@okouai/db/schema/blob";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";

import { piMemoryPhase2InputRevisionSql } from "./pi-memory-phase2-input-revision";
import { parseRawRows } from "../../lib/db-raw-rows";
import { z } from "zod";

// Stage 1 admission and maintenance completion retain native-history blobs. Lock
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
    revision: piMemoryPhase2InputRevisionSql({
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0225; new non-billing transactions are prohibited.
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
        const [advanced] = parseRawRows(
          z.object({ memoryStorageId: z.uuid() }),
          await tx.execute(plan.revision),
        );
        if (!advanced) {
          throw new Error("Pi memory Phase 2 input revision did not advance");
        }
      }
      return true;
    });
  },
);
