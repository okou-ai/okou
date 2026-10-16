import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import type { PiMemoryStage1Selection } from "./pi-memory-stage1-schedule.service";
import {
  piMemoryStage1SelectionReadPlans,
  piMemoryStage1DayConsumedByAnotherThread,
  piMemoryStage1LockedSelectionValid,
  piMemoryStage1SelectionSourcePlans,
  piMemoryStage1SelectionThreadEligible,
  piMemoryStage1SelectionRunEligible,
  piMemoryStage1SelectionConversationPlan,
  piMemoryStage1SelectionSourceMatches,
} from "./pi-memory-stage1-selection-plan";

import { and, eq, sql } from "drizzle-orm";

import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";

import { z } from "zod";
import { pgTextDecoder } from "../../lib/db-structured-result";
import {
  candidateCommitPlan,
  candidateCommitSql,
  type CommitPiMemoryStage1CandidateArgs,
} from "./pi-memory-stage1-commit-plan";

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

/** Finite result reconciliation: the output, watermark and Phase2 revision commit together. */
export const commitPiMemoryStage1Candidate$ = command(
  async (
    { get, set },
    args: CommitPiMemoryStage1CandidateArgs,
    selectionToValidate?: PiMemoryStage1Selection,
  ): Promise<boolean> => {
    const plan = candidateCommitPlan(args);
    const readDb = get(db$);
    const successful =
      args.result.kind === "succeeded" ||
      args.result.kind === "succeeded_no_output";
    const entryCreatedAt = successful
      ? z.object({ entryCreatedAt: z.string() }).parse(
          (
            await readDb
              .select({
                entryCreatedAt: sql`CURRENT_TIMESTAMP::timestamp::text`.mapWith(
                  pgTextDecoder,
                ),
              })
              .from(sql`(SELECT 1) AS entry_clock`)
          )[0],
        ).entryCreatedAt
      : undefined;
    if (selectionToValidate) {
      const selection = selectionToValidate;
      if (selection.day !== args.committedAt.toISOString().slice(0, 10)) {
        return false;
      }
      const reads = piMemoryStage1SelectionReadPlans(selection);
      const [selectedThread] = await readDb.select().from(reads.thread);
      if (!selectedThread) {
        return false;
      }
      const [day] = await readDb.select().from(reads.day);
      if (!piMemoryStage1DayConsumedByAnotherThread(selection, day)) {
        return false;
      }
      const [frozen] = await readDb.select().from(reads.frozen);
      if (!frozen) {
        return false;
      }
      const observedAt = nowDate();
      if (selection.day !== observedAt.toISOString().slice(0, 10)) {
        return false;
      }
      const features = await readDb.select().from(reads.features);
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
      const [thread] = await readDb.select().from(sourcePlans.thread);
      if (!thread) {
        return false;
      }
      const [active] = await readDb.select().from(sourcePlans.active);
      if (
        !piMemoryStage1SelectionThreadEligible(
          thread,
          !!active,
          args.committedAt,
        )
      ) {
        return false;
      }
      const [latest] = await readDb.select().from(sourcePlans.latest);
      if (
        !piMemoryStage1SelectionRunEligible(latest, selection, args.committedAt)
      ) {
        return false;
      }
      const [source] = await readDb
        .select()
        .from(piMemoryStage1SelectionConversationPlan(selection, latest));
      if (
        !piMemoryStage1SelectionSourceMatches(selection, latest, thread, source)
      ) {
        return false;
      }
    }
    // Thread -> Storage -> candidate -> watermark/Phase2, including unrevalidated
    // post-midnight reconciliation of an already admitted provider result.
    if (plan.sourceThread) {
      const [thread] = await readDb
        .select()
        .from(plan.sourceThread.as("candidate_source_thread"));
      if (!thread) {
        return false;
      }
    }
    const [owner] = await readDb
      .select()
      .from(plan.storage.as("candidate_owner_storage"));
    if (!owner) {
      return false;
    }
    if (successful) {
      const [identity] = await readDb
        .select({ memoryStorageId: piMemoryStage1Candidates.memoryStorageId })
        .from(piMemoryStage1Candidates)
        .where(plan.condition);
      if (!identity) {
        return false;
      }
      z.object({ memoryStorageId: z.uuid() }).parse(identity);
    }
    const { rowCount } = await set(writeDb$).execute(
      candidateCommitSql(args, entryCreatedAt),
    );
    return rowCount === 1;
  },
);
