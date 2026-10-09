import {
  piMemoryScheduleThreadLocks as threadLocks,
  piMemoryScheduleStorageLock as storageLock,
  piMemoryScheduleDayLock as dayLock,
  piMemoryScheduleOwnerFeatures as ownerFeatures,
  piMemoryScheduleThreadSource as threadSource,
  piMemoryScheduleActiveSource as activeSource,
  piMemoryScheduleLatestSource as latestSource,
  piMemoryScheduleConversation as sourceConversation,
  piMemoryScheduleWatermarks as sourceWatermarks,
  piMemoryScheduleLegacyEvidence as legacyEvidence,
  piMemoryScheduleProductThread as productThread,
  piMemoryScheduleAdmissionFeatures as admissionFeatures,
  piMemoryScheduleAdmissionSource as sourcePlan,
  piMemoryScheduleExistingStorage as existingStorage,
  piMemoryScheduleConflictStorage as conflictStorage,
  piMemoryScheduleCurrentCandidate as currentCandidate,
  PI_MEMORY_STAGE1_IDLE_MS,
  PI_MEMORY_STAGE1_MAX_AGE_MS,
  sourceArgs,
  threadActivity,
  runActivity,
  piMemoryCandidateInsertValues as candidateValues,
  piMemoryCandidateReferencePlan as referencePlan,
  requirePiMemoryCandidateReference as requireReference,
  requirePiMemoryCanonicalStorage as requireStorage,
  requirePiMemoryCandidateReplacement as requireReplacement,
  piMemoryCandidateReplacementPlan as replacementPlan,
  piMemoryScheduleSelectionValues as slotValues,
  piMemoryScheduleThreadSkipReason as threadSkipReason,
  piMemoryScheduleEvidenceUnchanged as evidenceUnchanged,
  type SelectedDayInput,
  currentDay,
  ownerEnabled,
  eligibleRun,
  historyBacked,
  selectedSource,
  orderedEvidence,
  admissionAllowed,
  admissionHistoryBacked,
  storageCreation,
  replacementDecision as decideReplacement,
  watermarkPlan,
  decisionLog,
  enabledThreads,
  storageIdOf,
  retainedHashOf,
  referenceChanges,
  dayConsumptionPlan,
  type Day,
  type PiMemoryStage1ThreadSource,
} from "./pi-memory-stage1-schedule-plan";
import { getPiMemoryStage1AdmissionPrerequisiteSkipReason } from "./pi-memory-stage1-admission-plan";
import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates as candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import {
  piMemoryStage1Days as days,
  piMemoryStage1Selections as selections,
  piMemoryStage1Watermarks as watermarks,
} from "@okouai/db/schema/pi-memory-stage1-schedule";
import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";

import { storages } from "@okouai/db/schema/storage";
import { blobs } from "@okouai/db/schema/blob";

const log = logger("PiMemoryStage1Schedule");
const THREAD_SCAN_LIMIT = 5000;
const sourceRunColumns = Object.freeze({
  id: agentRuns.id,
  orgId: agentRuns.orgId,
  userId: agentRuns.userId,
  status: agentRuns.status,
  launchSnapshot: agentRuns.launchSnapshot,
  triggerSource: agentRuns.triggerSource,
  chatThreadId: agentRuns.chatThreadId,
  completedAt: agentRuns.completedAt,
  createdAt: agentRuns.createdAt,
  sessionId: agentRuns.sessionId,
});
const candidateColumns = Object.freeze({
  memoryStorageId: candidates.memoryStorageId,
  piSessionId: candidates.piSessionId,
  sourceHistoryHash: candidates.sourceHistoryHash,
});
export type PiMemoryStage1Selection = typeof selections.$inferSelect;
export function piMemoryStage1UtcDay(time: Date): string {
  return time.toISOString().slice(0, 10);
}

const readThreadSource$ = command(
  async (
    { get },
    owner: Pick<Day, "userId" | "orgId">,
    threadId: string,
    currentTime: Date,
  ) => {
    const db = get(db$);
    const [thread] = await db
      .select({ id: chatThreads.id, activityAt: threadActivity })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.userId, owner.userId),
          eq(agents.orgId, owner.orgId),
        ),
      )
      .limit(1);
    if (!thread) {
      return { reason: "stale_selection" as const };
    }
    const [active] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, threadId),
          inArray(agentRuns.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    if (active) {
      return { reason: "active_source" as const };
    }
    if (
      thread.activityAt.getTime() >
      currentTime.getTime() - PI_MEMORY_STAGE1_IDLE_MS
    ) {
      return { reason: "recent_source" as const };
    }
    if (
      thread.activityAt.getTime() <
      currentTime.getTime() - PI_MEMORY_STAGE1_MAX_AGE_MS
    ) {
      return { reason: "old_source" as const };
    }
    // Choose the latest activity BEFORE checking source kind/snapshot/checkpoint.
    // A failed, excluded or checkpoint-less continuation cannot expose an older run.
    const [latest] = await db
      .select(sourceRunColumns)
      .from(agentRuns)
      .where(eq(agentRuns.chatThreadId, threadId))
      .orderBy(desc(runActivity), desc(agentRuns.id))
      .limit(1);
    if (
      !latest ||
      latest.userId !== owner.userId ||
      latest.orgId !== owner.orgId ||
      !latest.completedAt ||
      getPiMemoryStage1AdmissionPrerequisiteSkipReason(sourceArgs(latest))
    ) {
      return { reason: "invalid_source" as const };
    }
    if (
      latest.completedAt.getTime() <
      currentTime.getTime() - PI_MEMORY_STAGE1_MAX_AGE_MS
    ) {
      return { reason: "old_source" as const };
    }
    const [source] = await db
      .select({
        piSessionId: conversations.cliAgentSessionId,
        hash: conversations.cliAgentSessionHistoryHash,
      })
      .from(conversations)
      .innerJoin(agentSessions, eq(agentSessions.id, latest.sessionId))
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.agentId, agentSessions.agentId),
        ),
      )
      .where(
        and(
          eq(conversations.runId, latest.id),
          eq(conversations.cliAgentType, "pi"),
          eq(agentSessions.userId, owner.userId),
          eq(agentSessions.orgId, owner.orgId),
        ),
      )
      .limit(1);
    if (!source?.hash) {
      return { reason: "invalid_source" as const };
    }
    return {
      source: {
        run: latest,
        threadId,
        activityAt: thread.activityAt,
        piSessionId: source.piSessionId,
        hash: source.hash,
      },
    };
  },
);

const successfulEvidence$ = command(
  async (
    { get },
    owner: Pick<Day, "userId" | "orgId">,
    source: PiMemoryStage1ThreadSource,
  ) => {
    const db = get(db$);
    const existingWatermarks = await db
      .select({
        activityAt: watermarks.sourceActivityAt,
        hash: watermarks.sourceHistoryHash,
      })
      .from(watermarks)
      .where(
        and(
          eq(watermarks.userId, owner.userId),
          eq(watermarks.orgId, owner.orgId),
          eq(watermarks.chatThreadId, source.threadId),
        ),
      )
      .limit(1);
    // Bounded on first relevant selection; preserves old successful/no-output rows
    // before the canonical writer can replace their source. Native identity also
    // retains evidence after old Run history expires. No historical backfill.
    // Remove this DB/API transition read only after #33892 C verifies outgoing
    // writer drain and that no relevant legacy successes remain (#34044).
    const legacy = await db
      .select({
        activityAt: candidates.sourceCompletedAt,
        hash: candidates.sourceHistoryHash,
      })
      .from(candidates)
      .leftJoin(agentRuns, eq(agentRuns.id, candidates.sourceRunId))
      .where(
        and(
          eq(candidates.orgId, owner.orgId),
          eq(candidates.userId, owner.userId),
          or(
            eq(agentRuns.chatThreadId, source.threadId),
            eq(candidates.piSessionId, source.piSessionId),
          ),
          inArray(candidates.status, ["succeeded", "succeeded_no_output"]),
        ),
      )
      .orderBy(desc(candidates.sourceCompletedAt))
      .limit(1);
    return [...existingWatermarks, ...legacy].sort((a, b) => {
      return b.activityAt.getTime() - a.activityAt.getTime();
    });
  },
);

export const consumePiMemoryStage1Days$ = command(
  async ({ get, set }, currentTime: Date): Promise<void> => {
    const db = get(db$);
    const writeDb = set(writeDb$);
    const requests = await db
      .select()
      .from(days)
      .where(
        and(
          eq(days.day, piMemoryStage1UtcDay(currentTime)),
          isNull(days.consumedAt),
        ),
      )
      .orderBy(asc(days.userId))
      .limit(64);
    for (const request of requests) {
      const featureSwitchContextRows2 = await db
        .select({
          userId: userFeatureSwitches.userId,
          switches: userFeatureSwitches.switches,
        })
        .from(userFeatureSwitches)
        .where(userFeatureSwitchRowCondition(request.orgId, request.userId));
      const ownerContext = featureSwitchContextFromRows(
        request.orgId,
        request.userId,
        featureSwitchContextRows2,
      );
      if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, ownerContext)) {
        await writeDb
          .update(days)
          .set({ consumedAt: currentTime })
          .where(
            and(
              eq(days.userId, request.userId),
              eq(days.day, request.day),
              isNull(days.consumedAt),
            ),
          );
        log.debug("Pi memory Stage 1 decision", {
          userId: request.userId,
          orgId: request.orgId,
          day: request.day,
          outcome: "disabled",
          selectedCount: 0,
        });
        continue;
      }
      const threads = await db
        .select({ id: chatThreads.id, activityAt: threadActivity })
        .from(chatThreads)
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .where(
          and(
            eq(chatThreads.userId, request.userId),
            eq(agents.orgId, request.orgId),
            ne(chatThreads.id, request.triggerThreadId),
          ),
        )
        .orderBy(desc(threadActivity), asc(chatThreads.id))
        .limit(THREAD_SCAN_LIMIT);
      const chosen: string[] = [];
      const skips: Record<string, number> = {};
      for (const thread of threads) {
        const result = await set(
          readThreadSource$,
          request,
          thread.id,
          currentTime,
        );
        if (result.source) {
          const evidence = await set(
            successfulEvidence$,
            request,
            result.source,
          );
          if (
            !evidence.some((row) => {
              return (
                row.hash === result.source.hash ||
                row.activityAt >= result.source.activityAt
              );
            })
          ) {
            chosen.push(thread.id);
          } else {
            skips.unchanged_source = (skips.unchanged_source ?? 0) + 1;
          }
        } else {
          skips[result.reason] = (skips[result.reason] ?? 0) + 1;
        }
        if (chosen.length === 2) {
          break;
        }
      }
      await set(commitSelectedPiMemoryStage1Day$, {
        request,
        currentTime,
        chosen,
        skips,
      });
    }
  },
);

const commitSelectedPiMemoryStage1Day$ = command(
  async ({ set }, input: SelectedDayInput): Promise<void> => {
    const { request, currentTime, chosen, skips } = input;
    // Day consumption, candidate/reference replacement, legacy watermarks and
    // frozen slots form one atomic decision under the original lock order.
    await set(writeDb$).transaction(async (tx) => {
      // Sorted source Threads -> Storage -> user/day -> candidates -> blobs.
      if (chosen.length) {
        await tx.select().from(threadLocks(chosen));
      }
      await tx.select().from(storageLock(request));
      const [day] = await tx.select().from(dayLock(request));
      if (!currentDay(day)) {
        return;
      }
      const features = await tx.select().from(ownerFeatures(day));
      let count = 0;
      for (const threadId of enabledThreads(day, features, chosen)) {
        const [thread] = await tx.select().from(threadSource(day, threadId));
        if (!thread) {
          continue;
        }
        const [active] = await tx.select().from(activeSource(threadId));
        if (threadSkipReason(thread, !!active, currentTime)) {
          continue;
        }
        const [latest] = await tx.select().from(latestSource(threadId));
        if (!eligibleRun(latest, day, currentTime)) {
          continue;
        }
        const [conversation] = await tx
          .select()
          .from(sourceConversation(day, threadId, latest));
        if (!historyBacked(conversation)) {
          continue;
        }
        const source = selectedSource(latest, threadId, thread, conversation);
        const wm = await tx.select().from(sourceWatermarks(day, source));
        // Retain the bounded legacy transition read until #33892 C / #34044.
        const legacy = await tx.select().from(legacyEvidence(day, source));
        const evidence = orderedEvidence(wm, legacy);
        if (evidenceUnchanged(evidence, source)) {
          continue;
        }
        const args = sourceArgs(latest);
        if (!admissionAllowed(args)) {
          continue;
        }
        const [owned] = await tx.select().from(productThread(args));
        if (!owned) {
          continue;
        }
        const featureRows = await tx.select().from(admissionFeatures(args));
        if (!ownerEnabled(args, featureRows)) {
          continue;
        }
        const [checkpoint] = await tx.select().from(sourcePlan(args));
        if (!admissionHistoryBacked(checkpoint)) {
          continue;
        }
        const [existing] = await tx.select().from(existingStorage(args));
        let storageId = storageIdOf(existing);
        if (!storageId) {
          const storage = storageCreation(args);
          const [created] = await tx
            .insert(storages)
            .values(storage)
            .onConflictDoNothing()
            .returning({ id: storages.id });
          if (created) {
            storageId = created.id;
          } else {
            const [winner] = await tx.select().from(conflictStorage(args));
            storageId = requireStorage(winner);
          }
        }
        const values = candidateValues(args, storageId, checkpoint);
        const [created] = await tx
          .insert(candidates)
          .values([values])
          .onConflictDoNothing()
          .returning(candidateColumns);
        let retainHash = retainedHashOf(created);
        let releaseHash: string | undefined;
        if (!created) {
          const [current] = await tx
            .select()
            .from(currentCandidate(storageId, checkpoint));
          const decision = decideReplacement(current, args, checkpoint);
          if (decision.kind === "stale_source") {
            continue;
          }
          if (decision.kind === "replace") {
            const plan = replacementPlan(values, decision.hash, nowDate());
            const [replaced] = await tx
              .update(candidates)
              .set(plan.values)
              .where(plan.condition)
              .returning(plan.returning);
            retainHash = requireReplacement(replaced);
            releaseHash = decision.hash;
          }
        }
        for (const change of referenceChanges(retainHash, releaseHash)) {
          const plan = referencePlan(change.hash, change.delta);
          const [row] = await tx
            .update(blobs)
            .set(plan.values)
            .where(plan.condition)
            .returning(plan.returning);
          requireReference(row, change.delta);
        }
        for (const previous of evidence) {
          const watermark = watermarkPlan(day, threadId, storageId, previous);
          await tx
            .insert(watermarks)
            .values(watermark.values)
            .onConflictDoUpdate(watermark.conflict);
        }
        count += 1;
        const selection = slotValues(day, source, values, count);
        await tx.insert(selections).values(selection);
      }
      const finish = dayConsumptionPlan(day, currentTime);
      await tx.update(days).set(finish.values).where(finish.condition);
      log.debug("Pi memory Stage 1 decision", decisionLog(day, count, skips));
    });
  },
);
