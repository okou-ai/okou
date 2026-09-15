import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import {
  piMemoryStage1Days,
  piMemoryStage1Selections,
  piMemoryStage1Watermarks,
} from "@okouai/db/schema/pi-memory-stage1-schedule";
import { storages } from "@okouai/db/schema/storage";
import type { ApiDb, Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  admitPiMemoryStage1Candidate,
  getPiMemoryStage1AdmissionPrerequisiteSkipReason,
  lockPiMemoryCandidateStorage,
} from "./pi-memory-stage1-candidate.service";
import { advancePiMemoryStage1Watermark } from "./pi-memory-stage1-watermark.service";

const log = logger("PiMemoryStage1Schedule");
const PI_MEMORY_STAGE1_IDLE_MS = 6 * 60 * 60 * 1000;
const PI_MEMORY_STAGE1_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;
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
type Run = Pick<typeof agentRuns.$inferSelect, keyof typeof sourceRunColumns>;
type Day = typeof piMemoryStage1Days.$inferSelect;
export type PiMemoryStage1Selection =
  typeof piMemoryStage1Selections.$inferSelect;

export function piMemoryStage1UtcDay(time: Date): string {
  return time.toISOString().slice(0, 10);
}

function sourceArgs(run: Run) {
  const snapshot = run.launchSnapshot;
  return {
    runId: run.id,
    orgId: run.orgId,
    userId: run.userId,
    status:
      run.status === "completed" ? ("completed" as const) : ("failed" as const),
    framework: snapshot?.framework ?? null,
    generationEnabled:
      snapshot?.schemaVersion === 2
        ? snapshot.piMemoryGenerationEnabled
        : (snapshot?.schemaVersion === 3 || snapshot?.schemaVersion === 4) &&
          snapshot.framework === "pi",
    triggerSource: run.triggerSource,
    chatThreadId: run.chatThreadId,
    completedAt: run.completedAt ?? run.createdAt,
    idleDelayMs: PI_MEMORY_STAGE1_IDLE_MS,
  };
}

// Called only inside the common successful pending/queued admission transaction.
// No history scan, Storage creation, blob read, or external call under its locks.
export async function requestPiMemoryStage1Day(
  tx: Tx,
  run: Run,
): Promise<void> {
  const args = sourceArgs(run);
  const reason = getPiMemoryStage1AdmissionPrerequisiteSkipReason({
    ...args,
    status: "completed",
  });
  if (
    reason ||
    !run.chatThreadId ||
    !["pending", "queued"].includes(run.status)
  ) {
    return;
  }
  const context = await loadUserFeatureSwitchContext(tx, run.orgId, run.userId);
  if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, context)) {
    log.debug("Pi memory Stage 1 startup", {
      userId: run.userId,
      outcome: "disabled",
    });
    return;
  }
  const [owned] = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatThreads.id, run.chatThreadId),
        eq(chatThreads.userId, run.userId),
        eq(agents.orgId, run.orgId),
      ),
    )
    .limit(1);
  if (!owned) {
    return;
  }
  const requestedAt = nowDate();
  const day = piMemoryStage1UtcDay(requestedAt);
  const [created] = await tx
    .insert(piMemoryStage1Days)
    .values({
      userId: run.userId,
      orgId: run.orgId,
      triggerThreadId: run.chatThreadId,
      day,
      requestedAt,
    })
    .onConflictDoUpdate({
      target: piMemoryStage1Days.userId,
      set: {
        orgId: run.orgId,
        triggerThreadId: run.chatThreadId,
        day,
        requestedAt,
        consumedAt: null,
      },
      setWhere: lt(piMemoryStage1Days.day, day),
    })
    .returning({ userId: piMemoryStage1Days.userId });
  if (created) {
    await tx
      .delete(piMemoryStage1Selections)
      .where(eq(piMemoryStage1Selections.userId, run.userId));
  }
  log.debug("Pi memory Stage 1 startup", {
    userId: run.userId,
    orgId: run.orgId,
    day,
    outcome: created ? "requested" : "already_consumed",
  });
}

const runActivity = sql`greatest(${agentRuns.createdAt}, ${agentRuns.startedAt}, ${agentRuns.completedAt})`;
const threadActivity =
  sql`greatest(${chatThreads.lastMessageAt}, (select ${max(runActivity)} from ${agentRuns} where ${eq(agentRuns.chatThreadId, chatThreads.id)}))`.mapWith(
    chatThreads.lastMessageAt,
  );

async function readThreadSource(
  db: ApiDb,
  owner: Pick<Day, "userId" | "orgId">,
  threadId: string,
  currentTime: Date,
) {
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
        inArray(agentRuns.status, ["queued", "pending", "running"]),
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
}

async function successfulEvidence(
  tx: ApiDb,
  owner: Pick<Day, "userId" | "orgId">,
  source: NonNullable<Awaited<ReturnType<typeof readThreadSource>>["source"]>,
) {
  const watermarks = await tx
    .select({
      activityAt: piMemoryStage1Watermarks.sourceActivityAt,
      hash: piMemoryStage1Watermarks.sourceHistoryHash,
    })
    .from(piMemoryStage1Watermarks)
    .where(
      and(
        eq(piMemoryStage1Watermarks.userId, owner.userId),
        eq(piMemoryStage1Watermarks.orgId, owner.orgId),
        eq(piMemoryStage1Watermarks.chatThreadId, source.threadId),
      ),
    )
    .limit(1);
  // Bounded on first relevant selection; preserves old successful/no-output rows
  // before the canonical writer can replace their source. Native identity also
  // retains evidence after old Run history expires. No historical backfill.
  // Remove this DB/API transition read only after #33892 C verifies outgoing
  // writer drain and that no relevant legacy successes remain (#34044).
  const legacy = await tx
    .select({
      activityAt: piMemoryStage1Candidates.sourceCompletedAt,
      hash: piMemoryStage1Candidates.sourceHistoryHash,
    })
    .from(piMemoryStage1Candidates)
    .leftJoin(agentRuns, eq(agentRuns.id, piMemoryStage1Candidates.sourceRunId))
    .where(
      and(
        eq(piMemoryStage1Candidates.orgId, owner.orgId),
        eq(piMemoryStage1Candidates.userId, owner.userId),
        or(
          eq(agentRuns.chatThreadId, source.threadId),
          eq(piMemoryStage1Candidates.piSessionId, source.piSessionId),
        ),
        inArray(piMemoryStage1Candidates.status, [
          "succeeded",
          "succeeded_no_output",
        ]),
      ),
    )
    .orderBy(desc(piMemoryStage1Candidates.sourceCompletedAt))
    .limit(1);
  return [...watermarks, ...legacy].sort((a, b) => {
    return b.activityAt.getTime() - a.activityAt.getTime();
  });
}

async function commitSelectedPiMemoryStage1Day(
  tx: Tx,
  input: {
    readonly request: Day;
    readonly currentTime: Date;
    readonly chosen: readonly string[];
    readonly skips: Readonly<Record<string, number>>;
  },
): Promise<void> {
  const { request, currentTime, chosen, skips } = input;
  // Lock order: sorted source Threads -> Storage -> user/day -> candidates
  // -> blobs/watermarks/Phase 2. Never acquire a Thread after the day lock.
  if (chosen.length) {
    await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(inArray(chatThreads.id, chosen))
      .orderBy(asc(chatThreads.id))
      .for("update");
  }
  await lockPiMemoryCandidateStorage(tx, request);
  const [day] = await tx
    .select()
    .from(piMemoryStage1Days)
    .where(
      and(
        eq(piMemoryStage1Days.userId, request.userId),
        eq(piMemoryStage1Days.day, request.day),
        eq(piMemoryStage1Days.orgId, request.orgId),
        isNull(piMemoryStage1Days.consumedAt),
      ),
    )
    .for("update");
  if (!day || day.day !== piMemoryStage1UtcDay(nowDate())) {
    return;
  }
  const context = await loadUserFeatureSwitchContext(tx, day.orgId, day.userId);
  let count = 0;
  if (isFeatureEnabled(FeatureSwitchKey.PiMemory, context)) {
    for (const threadId of chosen) {
      const result = await readThreadSource(tx, day, threadId, currentTime);
      if (!result.source) {
        continue;
      }
      const source = result.source;
      const evidence = await successfulEvidence(tx, day, source);
      if (
        evidence.some((row) => {
          return (
            row.hash === source.hash || row.activityAt >= source.activityAt
          );
        })
      ) {
        continue;
      }
      const admission = await admitPiMemoryStage1Candidate(
        tx,
        sourceArgs(source.run),
      );
      if (admission.outcome === "skipped") {
        continue;
      }
      for (const previous of evidence) {
        await advancePiMemoryStage1Watermark(tx, {
          memoryStorageId: admission.memoryStorageId,
          orgId: day.orgId,
          userId: day.userId,
          chatThreadId: threadId,
          sourceActivityAt: previous.activityAt,
          sourceHistoryHash: previous.hash,
        });
      }
      count += 1;
      await tx.insert(piMemoryStage1Selections).values({
        userId: day.userId,
        orgId: day.orgId,
        day: day.day,
        slot: count,
        chatThreadId: threadId,
        memoryStorageId: admission.memoryStorageId,
        piSessionId: admission.piSessionId,
        sourceRunId: source.run.id,
        sourceHistoryHash: source.hash,
        sourceCompletedAt: sourceArgs(source.run).completedAt,
        sourceActivityAt: source.activityAt,
      });
    }
  }
  await tx
    .update(piMemoryStage1Days)
    .set({ consumedAt: currentTime })
    .where(eq(piMemoryStage1Days.userId, day.userId));
  log.debug("Pi memory Stage 1 decision", {
    userId: day.userId,
    orgId: day.orgId,
    day: day.day,
    selectedCount: count,
    outcome: count ? "selected" : "no_eligible_source",
    skips,
  });
}

export async function consumePiMemoryStage1Days(
  db: ApiDb,
  currentTime: Date,
  storageIds?: readonly string[],
): Promise<void> {
  const requests = await db
    .select()
    .from(piMemoryStage1Days)
    .where(
      and(
        eq(piMemoryStage1Days.day, piMemoryStage1UtcDay(currentTime)),
        isNull(piMemoryStage1Days.consumedAt),
        storageIds
          ? inArray(
              piMemoryStage1Days.userId,
              db
                .select({ userId: storages.userId })
                .from(storages)
                .where(inArray(storages.id, storageIds)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(piMemoryStage1Days.userId))
    .limit(64);
  for (const request of requests) {
    const ownerContext = await loadUserFeatureSwitchContext(
      db,
      request.orgId,
      request.userId,
    );
    if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, ownerContext)) {
      await db
        .update(piMemoryStage1Days)
        .set({ consumedAt: currentTime })
        .where(
          and(
            eq(piMemoryStage1Days.userId, request.userId),
            eq(piMemoryStage1Days.day, request.day),
            isNull(piMemoryStage1Days.consumedAt),
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
      const result = await readThreadSource(
        db,
        request,
        thread.id,
        currentTime,
      );
      if (result.source) {
        const evidence = await successfulEvidence(db, request, result.source);
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
    await db.transaction(async (tx) => {
      await commitSelectedPiMemoryStage1Day(tx, {
        request,
        currentTime,
        chosen,
        skips,
      });
    });
  }
}

export async function validatePiMemoryStage1Selection(
  tx: Tx,
  selection: PiMemoryStage1Selection,
  currentTime: Date,
): Promise<boolean> {
  if (selection.day !== piMemoryStage1UtcDay(currentTime)) {
    return false;
  }
  const [thread] = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, selection.chatThreadId))
    .for("update");
  if (!thread) {
    return false;
  }
  await lockPiMemoryCandidateStorage(tx, selection);
  const [day] = await tx
    .select()
    .from(piMemoryStage1Days)
    .where(
      and(
        eq(piMemoryStage1Days.userId, selection.userId),
        eq(piMemoryStage1Days.day, selection.day),
        eq(piMemoryStage1Days.orgId, selection.orgId),
      ),
    )
    .for("update");
  if (!day?.consumedAt || day.triggerThreadId === selection.chatThreadId) {
    return false;
  }
  const [frozen] = await tx
    .select()
    .from(piMemoryStage1Selections)
    .where(
      and(
        eq(piMemoryStage1Selections.userId, selection.userId),
        eq(piMemoryStage1Selections.slot, selection.slot),
        eq(piMemoryStage1Selections.day, selection.day),
        eq(piMemoryStage1Selections.chatThreadId, selection.chatThreadId),
        eq(piMemoryStage1Selections.memoryStorageId, selection.memoryStorageId),
        eq(piMemoryStage1Selections.piSessionId, selection.piSessionId),
        eq(piMemoryStage1Selections.orgId, selection.orgId),
        eq(
          piMemoryStage1Selections.sourceCompletedAt,
          selection.sourceCompletedAt,
        ),
        eq(
          piMemoryStage1Selections.sourceActivityAt,
          selection.sourceActivityAt,
        ),
        eq(piMemoryStage1Selections.sourceRunId, selection.sourceRunId),
        eq(
          piMemoryStage1Selections.sourceHistoryHash,
          selection.sourceHistoryHash,
        ),
      ),
    );
  // A blocked lock acquisition may cross midnight after the initial check.
  if (!frozen || selection.day !== piMemoryStage1UtcDay(nowDate())) {
    return false;
  }
  const context = await loadUserFeatureSwitchContext(
    tx,
    selection.orgId,
    selection.userId,
  );
  if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, context)) {
    return false;
  }
  const result = await readThreadSource(
    tx,
    selection,
    selection.chatThreadId,
    currentTime,
  );
  const source = result.source;
  return (
    !!source &&
    source.run.id === selection.sourceRunId &&
    source.hash === selection.sourceHistoryHash &&
    source.piSessionId === selection.piSessionId &&
    source.activityAt.getTime() === selection.sourceActivityAt.getTime() &&
    source.run.completedAt?.getTime() === selection.sourceCompletedAt.getTime()
  );
}
