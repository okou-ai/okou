import { advancePiMemoryStage1Watermark } from "./pi-memory-stage1-watermark.service";
import { and, asc, eq, gt, gte, inArray, sql, type SQL } from "drizzle-orm";

import { z } from "zod";

import {
  PI_MEMORY_TRIGGER_SOURCE_CLASSES,
  triggerSourceSchema,
} from "@okouai/api-contracts/contracts/logs";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import { executeRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { advancePiMemoryPhase2InputRevision } from "./pi-memory-phase2-job.service";
import { newStorageS3Location } from "./storage-s3-prefix.utils";

// API B / DB compatibility for #33748. Retire only after B is deployed,
// pre-B writers have drained, and B is the supported rollback floor.
async function usesExplicitCandidateReferences(tx: Tx): Promise<boolean> {
  // ROW EXCLUSIVE is compatible with other writers and blocks trigger DDL.
  // The catalog SELECT must be a separate READ COMMITTED statement AFTER the
  // lock: a statement snapshot taken before a waiting lock could be stale.
  await tx.execute(
    sql`LOCK TABLE ${piMemoryStage1Candidates} IN ROW EXCLUSIVE MODE`,
  );
  const [settings] = await executeRawRows(
    tx,
    sql`SELECT current_setting('transaction_isolation') AS isolation,
      current_setting('session_replication_role') AS replication_role`,
    z.object({
      isolation: z.literal("read committed"),
      replication_role: z.literal("origin"),
    }),
  );
  if (!settings) {
    throw new Error("Missing Pi candidate transaction settings");
  }
  const triggers = await executeRawRows(
    tx,
    sql`SELECT t.tgname AS name,
      (t.tgenabled = 'O' AND t.tgtype = 29 AND NOT t.tgdeferrable
        AND NOT t.tginitdeferred AND t.tgqual IS NULL
        AND t.tgnargs = 0 AND octet_length(t.tgargs) = 0
        AND t.tgattr::text = a.attnum::text
        AND p.proname = 'pi_memory_stage1_candidate_blob_ref_count'
        AND p.pronamespace = c.relnamespace
        AND p.proconfig IS NULL AND NOT p.prosecdef AND p.provolatile = 'v'
        AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype
        AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
        AND md5(p.prosrc) = '576154890be37fff1ec9f9f4c318428c') AS valid
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'source_history_hash'
      WHERE t.tgrelid = 'pi_memory_stage1_candidates'::regclass
        AND NOT t.tgisinternal`,
    z.object({ name: z.string(), valid: z.boolean() }),
  );
  if (triggers.length === 0) {
    return true;
  }
  if (
    triggers.length !== 1 ||
    triggers[0]?.name !== "pi_memory_stage1_candidate_blob_ref_count_trigger" ||
    !triggers[0].valid
  ) {
    throw new Error("Unexpected Pi candidate reference trigger configuration");
  }
  return false;
}

// Completion can retain checkpoint blobs before admission. Lock an existing
// owner before either operation to avoid a parent/blob cycle with cleanup.
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

/** Supported insertion path for admission and controlled fixture/repair writers. */
export async function insertPiMemoryStage1Candidates(
  tx: Tx,
  rows: readonly (typeof piMemoryStage1Candidates.$inferInsert)[],
) {
  if (rows.length === 0) {
    return [];
  }
  const ids = [
    ...new Set(
      rows.map((row) => {
        return row.memoryStorageId;
      }),
    ),
  ];
  await tx
    .select({ id: storages.id })
    .from(storages)
    .where(inArray(storages.id, ids))
    .orderBy(asc(storages.id))
    .for("no key update");
  const explicit = await usesExplicitCandidateReferences(tx);
  return await insertCandidateRows(tx, rows, explicit);
}

async function insertCandidateRows(
  tx: Tx,
  rows: readonly (typeof piMemoryStage1Candidates.$inferInsert)[],
  explicit: boolean,
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
  if (explicit) {
    for (const row of [...created].sort((a, b) => {
      return a.sourceHistoryHash.localeCompare(b.sourceHistoryHash);
    })) {
      await retainCandidateReference(tx, row.sourceHistoryHash);
    }
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
  const explicit = await usesExplicitCandidateReferences(tx);
  const deleted = await tx
    .delete(piMemoryStage1Candidates)
    .where(inArray(piMemoryStage1Candidates.memoryStorageId, [...storageIds]))
    .returning({ hash: piMemoryStage1Candidates.sourceHistoryHash });
  if (explicit) {
    await releaseCandidateReferences(
      tx,
      deleted.map((row) => {
        return row.hash;
      }),
    );
  }
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

type PiMemoryStage1AdmissionSkipReason =
  | "generation_disabled"
  | "history_not_hash_backed"
  | "missing_chat_thread"
  | "non_interactive_source"
  | "not_completed"
  | "not_pi"
  | "not_owned_chat_thread"
  | "pi_memory_disabled"
  | "invalid_source"
  | "synthetic_source"
  | "stale_source";

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

export interface AdmitPiMemoryStage1CandidateArgs {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: "completed" | "failed";
  readonly framework: "claude-code" | "codex" | "pi" | null;
  readonly generationEnabled: boolean;
  readonly triggerSource: string | null;
  readonly chatThreadId: string | null;
  readonly completedAt: Date;
  readonly idleDelayMs: number;
}

export function getPiMemoryStage1AdmissionPrerequisiteSkipReason(
  args: AdmitPiMemoryStage1CandidateArgs,
): PiMemoryStage1AdmissionSkipReason | null {
  if (args.status !== "completed") {
    return "not_completed";
  }
  if (args.framework !== "pi") {
    return "not_pi";
  }
  if (!args.generationEnabled) {
    return "generation_disabled";
  }
  const triggerSource = triggerSourceSchema.safeParse(args.triggerSource);
  if (!triggerSource.success) {
    return "invalid_source";
  }
  // The source class is decided before the Chat Thread check so a threadless
  // maintenance run or a thread-bound automation run reports its real reason
  // rather than a misleading missing_chat_thread.
  const sourceClass = PI_MEMORY_TRIGGER_SOURCE_CLASSES[triggerSource.data];
  if (sourceClass === "synthetic") {
    return "synthetic_source";
  }
  if (sourceClass === "non_interactive") {
    return "non_interactive_source";
  }
  if (args.chatThreadId === null) {
    return "missing_chat_thread";
  }
  return null;
}

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
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    tx,
    args.orgId,
    args.userId,
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
  const explicit = await usesExplicitCandidateReferences(tx);
  const eligibleAt = new Date(args.completedAt.getTime() + args.idleDelayMs);
  const [created] = await insertCandidateRows(
    tx,
    [
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
    ],
    explicit,
  );
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
  if (explicit) {
    await retainCandidateReference(tx, replaced.sourceHistoryHash);
    await releaseCandidateReferences(tx, [current.sourceHistoryHash]);
  }
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

async function lockOwnedPiMemorySourceThread(
  tx: Tx,
  userId: string,
  threadId: string,
): Promise<boolean> {
  const [thread] = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .for("key share");
  return thread !== undefined;
}

export async function commitPiMemoryStage1Candidate(
  tx: Tx,
  args: CommitPiMemoryStage1CandidateArgs,
): Promise<boolean> {
  // Take the Thread FK lock before Storage/candidate and Phase 2 locks.
  if (
    args.selectedSource &&
    !(await lockOwnedPiMemorySourceThread(
      tx,
      args.userId,
      args.selectedSource.chatThreadId,
    ))
  ) {
    return false;
  }
  // Phase 2 enqueue can take a parent FK lock after updating the candidate.
  // Take it first so cleanup cannot hold the parent while waiting for this row.
  const [owner] = await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.id, args.memoryStorageId),
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
      ),
    )
    .for("key share");
  if (!owner) {
    return false;
  }
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
  const [committed] = await tx
    .update(piMemoryStage1Candidates)
    .set({ ...common, ...resultValues })
    .where(
      and(
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
      ),
    )
    .returning({ memoryStorageId: piMemoryStage1Candidates.memoryStorageId });
  if (!committed) {
    return false;
  }
  if (
    args.result.kind === "succeeded" ||
    args.result.kind === "succeeded_no_output"
  ) {
    if (args.selectedSource) {
      await advancePiMemoryStage1Watermark(tx, {
        memoryStorageId: args.memoryStorageId,
        orgId: args.orgId,
        userId: args.userId,
        chatThreadId: args.selectedSource.chatThreadId,
        sourceActivityAt: args.selectedSource.sourceActivityAt,
        sourceHistoryHash: args.sourceHistoryHash,
      });
    }
    await advancePiMemoryPhase2InputRevision(tx, {
      memoryStorageId: args.memoryStorageId,
      orgId: args.orgId,
      userId: args.userId,
      enqueuedAt: args.committedAt,
    });
  }
  return true;
}
