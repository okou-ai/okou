import { randomUUID } from "node:crypto";

import {
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import {
  PI_MEMORY_PHASE2_MAX_ATTEMPTS,
  PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES,
  PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES,
  piMemoryPhase2Jobs,
} from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { piMemoryPhase2SelectionDigest } from "@okouai/pi-agent-runtime/api";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { ApiDb, Tx } from "../../lib/db-types";

export const PI_MEMORY_PHASE2_LEASE_DURATION_MS = 60 * 60 * 1000;
export const PI_MEMORY_PHASE2_RETRY_DELAY_MS = 60 * 60 * 1000;
export const PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const PI_MEMORY_PHASE2_MAX_UNUSED_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PiMemoryPhase2OwnerScope {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
}

export interface PiMemoryPhase2SelectedCandidate {
  readonly piSessionId: string;
  readonly sourceRunId: string;
  readonly sourceHistoryHash: string;
  readonly sourceCompletedAt: Date;
  readonly rawMemory: string;
  readonly rolloutSummary: string;
  readonly rolloutSlug: string | null;
}

interface ClaimedPiMemoryPhase2BaseVersion {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
}

export interface ClaimedPiMemoryPhase2Job extends PiMemoryPhase2OwnerScope {
  readonly s3Prefix: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly claimedRevision: number;
  readonly reconciliationQueuedAt: Date | null;
  readonly baseVersion: ClaimedPiMemoryPhase2BaseVersion;
  readonly selected: readonly PiMemoryPhase2SelectedCandidate[];
}

interface ClaimPiMemoryPhase2JobArgs {
  readonly currentTime: Date;
  readonly scope?: PiMemoryPhase2OwnerScope;
}

interface PiMemoryPhase2LeaseFence extends PiMemoryPhase2OwnerScope {
  readonly leaseToken: string;
  readonly claimedRevision: number;
  readonly claimedBaseVersionId: string;
  readonly currentTime: Date;
  readonly expectedMaintenanceRunId?: string | null;
  /** Bound orphan recovery retains the exact run/token fence after expiry. */
  readonly allowExpiredLease?: boolean;
}

interface PiMemoryPhase2SelectionMetadata {
  readonly digest: string;
  readonly count: number;
  readonly utf8Bytes: number;
}

function candidateUtf8Bytes(
  candidate: PiMemoryPhase2SelectedCandidate,
): number {
  return (
    Buffer.byteLength(candidate.rawMemory, "utf8") +
    Buffer.byteLength(candidate.rolloutSummary, "utf8") +
    Buffer.byteLength(candidate.rolloutSlug ?? "", "utf8")
  );
}

function selectionMetadata(
  selected: readonly PiMemoryPhase2SelectedCandidate[],
): PiMemoryPhase2SelectionMetadata | null {
  if (selected.length > PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES) {
    return null;
  }
  const piSessionIds = new Set<string>();
  let utf8Bytes = 0;
  for (const candidate of selected) {
    if (piSessionIds.has(candidate.piSessionId)) {
      return null;
    }
    piSessionIds.add(candidate.piSessionId);
    utf8Bytes += candidateUtf8Bytes(candidate);
    if (utf8Bytes > PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES) {
      return null;
    }
  }
  return {
    digest: piMemoryPhase2SelectionDigest(selected),
    count: selected.length,
    utf8Bytes,
  };
}

export async function advancePiMemoryPhase2InputRevision(
  tx: Tx,
  args: PiMemoryPhase2OwnerScope & { readonly enqueuedAt: Date },
): Promise<void> {
  const [advanced] = await tx
    .insert(piMemoryPhase2Jobs)
    .values({
      memoryStorageId: args.memoryStorageId,
      orgId: args.orgId,
      userId: args.userId,
      status: "pending",
      inputRevision: 1,
      completedRevision: 0,
      retryCount: 0,
      updatedAt: args.enqueuedAt,
    })
    .onConflictDoUpdate({
      target: piMemoryPhase2Jobs.memoryStorageId,
      set: {
        orgId: args.orgId,
        userId: args.userId,
        status: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN 'leased'
          ELSE 'pending'
        END`,
        inputRevision: sql`${piMemoryPhase2Jobs.inputRevision} + 1`,
        claimedRevision: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedRevision}
          ELSE NULL
        END`,
        claimedBaseVersionId: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedBaseVersionId}
          ELSE NULL
        END`,
        leaseToken: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.leaseToken}
          ELSE NULL
        END`,
        leaseExpiresAt: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.leaseExpiresAt}
          ELSE NULL
        END`,
        sandboxLeaseToken: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.sandboxLeaseToken}
          ELSE NULL
        END`,
        maintenanceRunId: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.maintenanceRunId}
          ELSE NULL
        END`,
        retryCount: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.retryCount}
          ELSE 0
        END`,
        retryAt: null,
        lastErrorClass: null,
        claimedSelectionDigest: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedSelectionDigest}
          ELSE NULL
        END`,
        claimedSelectedCount: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedSelectedCount}
          ELSE NULL
        END`,
        claimedSelectedUtf8Bytes: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedSelectedUtf8Bytes}
          ELSE NULL
        END`,
        updatedAt: args.enqueuedAt,
      },
    })
    .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
  if (!advanced) {
    throw new Error("Pi memory Phase 2 input revision did not advance");
  }
}

export async function notifyPiMemoryPhase2ExternalHeadChange(
  tx: Tx,
  args: PiMemoryPhase2OwnerScope & {
    readonly observedHeadVersionId: string;
    readonly changedAt: Date;
    readonly sourceRunId?: string;
  },
): Promise<boolean> {
  const [memory] = await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.id, args.memoryStorageId),
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        ne(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
        eq(storages.headVersionId, args.observedHeadVersionId),
      ),
    )
    .limit(1)
    .for("update", { of: storages });
  if (!memory) {
    return false;
  }

  const [updated] = await tx
    .update(piMemoryPhase2Jobs)
    .set({
      status: sql`CASE
        WHEN ${piMemoryPhase2Jobs.maintenanceRunId} = ${args.sourceRunId ?? null}
        THEN ${piMemoryPhase2Jobs.status}
        WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN 'leased'
        ELSE 'pending'
      END`,
      inputRevision: sql`CASE
        WHEN ${piMemoryPhase2Jobs.maintenanceRunId} = ${args.sourceRunId ?? null}
        THEN ${piMemoryPhase2Jobs.inputRevision}
        ELSE ${piMemoryPhase2Jobs.inputRevision} + 1
      END`,
      reconciliationRevision: sql`CASE
        WHEN ${piMemoryPhase2Jobs.maintenanceRunId} = ${args.sourceRunId ?? null}
        THEN ${piMemoryPhase2Jobs.reconciliationRevision}
        ELSE ${piMemoryPhase2Jobs.inputRevision} + 1
      END`,
      claimedRevision: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedRevision}
        ELSE NULL
        END`,
      sandboxLeaseToken: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.sandboxLeaseToken}
        ELSE NULL
      END`,
      maintenanceRunId: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.maintenanceRunId}
        ELSE NULL
      END`,
      claimedBaseVersionId: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedBaseVersionId}
        ELSE NULL
      END`,
      leaseToken: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.leaseToken}
        ELSE NULL
      END`,
      leaseExpiresAt: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.leaseExpiresAt}
        ELSE NULL
      END`,
      retryCount: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.retryCount}
        ELSE 0
      END`,
      retryAt: null,
      lastErrorClass: null,
      claimedSelectionDigest: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedSelectionDigest}
        ELSE NULL
      END`,
      claimedSelectedCount: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedSelectedCount}
        ELSE NULL
      END`,
      claimedSelectedUtf8Bytes: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedSelectedUtf8Bytes}
        ELSE NULL
      END`,
      lastObservedHeadVersionId: args.observedHeadVersionId,
      updatedAt: args.changedAt,
    })
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, args.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, args.orgId),
        eq(piMemoryPhase2Jobs.userId, args.userId),
        or(
          isNull(piMemoryPhase2Jobs.lastObservedHeadVersionId),
          ne(
            piMemoryPhase2Jobs.lastObservedHeadVersionId,
            args.observedHeadVersionId,
          ),
        ),
      ),
    )
    .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
  return updated !== undefined;
}

function claimScopeCondition(scope: PiMemoryPhase2OwnerScope | undefined) {
  return scope
    ? and(
        eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, scope.orgId),
        eq(piMemoryPhase2Jobs.userId, scope.userId),
      )
    : undefined;
}

async function selectClaimCandidates(
  tx: Tx,
  scope: PiMemoryPhase2OwnerScope,
  currentTime: Date,
): Promise<readonly PiMemoryPhase2SelectedCandidate[]> {
  const oldestAllowed = new Date(
    currentTime.getTime() - PI_MEMORY_PHASE2_MAX_UNUSED_AGE_MS,
  );
  const ranked = await tx
    .select({
      piSessionId: piMemoryStage1Candidates.piSessionId,
      sourceRunId: piMemoryStage1Candidates.sourceRunId,
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
      sourceCompletedAt: piMemoryStage1Candidates.sourceCompletedAt,
      rawMemory: piMemoryStage1Candidates.rawMemory,
      rolloutSummary: piMemoryStage1Candidates.rolloutSummary,
      rolloutSlug: piMemoryStage1Candidates.rolloutSlug,
    })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryStage1Candidates.orgId, scope.orgId),
        eq(piMemoryStage1Candidates.userId, scope.userId),
        eq(piMemoryStage1Candidates.status, "succeeded"),
        sql`(
          btrim(${piMemoryStage1Candidates.rawMemory}, E' \t\n\r\f\v') <> '' OR
          btrim(${piMemoryStage1Candidates.rolloutSummary}, E' \t\n\r\f\v') <> ''
        )`,
        or(
          and(
            isNotNull(piMemoryStage1Candidates.lastUsedAt),
            gte(piMemoryStage1Candidates.lastUsedAt, oldestAllowed),
            lte(piMemoryStage1Candidates.lastUsedAt, currentTime),
          ),
          and(
            isNull(piMemoryStage1Candidates.lastUsedAt),
            gte(piMemoryStage1Candidates.sourceCompletedAt, oldestAllowed),
            lte(piMemoryStage1Candidates.sourceCompletedAt, currentTime),
          ),
        ),
      ),
    )
    .orderBy(
      desc(piMemoryStage1Candidates.usageCount),
      desc(
        sql`COALESCE(
          ${piMemoryStage1Candidates.lastUsedAt},
          ${piMemoryStage1Candidates.sourceCompletedAt}
        )`,
      ),
      desc(piMemoryStage1Candidates.sourceCompletedAt),
      desc(piMemoryStage1Candidates.piSessionId),
    )
    .limit(PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES);

  const selected: PiMemoryPhase2SelectedCandidate[] = [];
  let selectedUtf8Bytes = 0;
  for (const candidate of ranked) {
    if (candidate.rawMemory === null || candidate.rolloutSummary === null) {
      throw new Error("Succeeded Pi memory Stage 1 candidate has no output");
    }
    const snapshot = {
      piSessionId: candidate.piSessionId,
      sourceRunId: candidate.sourceRunId,
      sourceHistoryHash: candidate.sourceHistoryHash,
      sourceCompletedAt: candidate.sourceCompletedAt,
      rawMemory: candidate.rawMemory,
      rolloutSummary: candidate.rolloutSummary,
      rolloutSlug: candidate.rolloutSlug,
    };
    const nextUtf8Bytes = selectedUtf8Bytes + candidateUtf8Bytes(snapshot);
    if (nextUtf8Bytes > PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES) {
      break;
    }
    selected.push(snapshot);
    selectedUtf8Bytes = nextUtf8Bytes;
  }
  return selected.sort((left, right) => {
    if (left.piSessionId < right.piSessionId) {
      return -1;
    }
    if (left.piSessionId > right.piSessionId) {
      return 1;
    }
    return 0;
  });
}

async function lockPhase2CandidateSet(
  tx: Tx,
  scope: PiMemoryPhase2OwnerScope,
): Promise<void> {
  await tx
    .select({ piSessionId: piMemoryStage1Candidates.piSessionId })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryStage1Candidates.orgId, scope.orgId),
        eq(piMemoryStage1Candidates.userId, scope.userId),
      ),
    )
    .orderBy(asc(piMemoryStage1Candidates.piSessionId))
    .for("update", { of: piMemoryStage1Candidates });
}

export async function claimPiMemoryPhase2Job(
  db: ApiDb,
  args: ClaimPiMemoryPhase2JobArgs,
): Promise<ClaimedPiMemoryPhase2Job | null> {
  return await db.transaction(async (tx) => {
    const claimableStorage = await lockNextClaimableStorage(tx, args);
    if (!claimableStorage) {
      return null;
    }

    const [baseVersion] = await tx
      .select({
        storageId: storageVersions.storageId,
        versionId: storageVersions.id,
        s3Key: storageVersions.s3Key,
        size: storageVersions.size,
        archiveSize: storageVersions.archiveSize,
        fileCount: storageVersions.fileCount,
      })
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, claimableStorage.memoryStorageId),
          eq(storageVersions.id, claimableStorage.baseVersionId),
        ),
      )
      .limit(1);
    if (!baseVersion) {
      return null;
    }

    const scope = {
      memoryStorageId: claimableStorage.memoryStorageId,
      orgId: claimableStorage.orgId,
      userId: claimableStorage.userId,
    };
    await lockPhase2CandidateSet(tx, scope);
    const selected = await selectClaimCandidates(tx, scope, args.currentTime);
    const job = await lockClaimableJob(tx, args, scope);
    if (!job) {
      return null;
    }

    const retryCount =
      job.status === "leased"
        ? job.claimedRevision === job.inputRevision
          ? job.retryCount + 1
          : 0
        : job.retryCount;
    if (retryCount >= PI_MEMORY_PHASE2_MAX_ATTEMPTS) {
      await tx
        .update(piMemoryPhase2Jobs)
        .set({
          status: "terminal_failure",
          claimedRevision: null,
          claimedBaseVersionId: null,
          leaseToken: null,
          sandboxLeaseToken: null,
          leaseExpiresAt: null,
          maintenanceRunId: null,
          retryCount: PI_MEMORY_PHASE2_MAX_ATTEMPTS,
          retryAt: null,
          lastErrorClass: "lease_expired",
          claimedSelectionDigest: null,
          claimedSelectedCount: null,
          claimedSelectedUtf8Bytes: null,
          updatedAt: args.currentTime,
        })
        .where(
          and(
            eq(piMemoryPhase2Jobs.memoryStorageId, job.memoryStorageId),
            eq(piMemoryPhase2Jobs.orgId, job.orgId),
            eq(piMemoryPhase2Jobs.userId, job.userId),
          ),
        );
      return null;
    }

    const metadata = selectionMetadata(selected);
    if (metadata === null) {
      throw new Error("Claimed Pi memory Phase 2 selection is out of bounds");
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      args.currentTime.getTime() + PI_MEMORY_PHASE2_LEASE_DURATION_MS,
    );
    const [leased] = await tx
      .update(piMemoryPhase2Jobs)
      .set({
        status: "leased",
        claimedRevision: job.inputRevision,
        claimedBaseVersionId: baseVersion.versionId,
        leaseToken,
        legacyLeaseToken: null,
        sandboxLeaseToken: leaseToken,
        leaseExpiresAt,
        maintenanceRunId: null,
        retryCount,
        retryAt: null,
        lastErrorClass: null,
        claimedSelectionDigest: metadata.digest,
        claimedSelectedCount: metadata.count,
        claimedSelectedUtf8Bytes: metadata.utf8Bytes,
        lastObservedHeadVersionId: baseVersion.versionId,
        updatedAt: args.currentTime,
      })
      .where(
        and(
          eq(piMemoryPhase2Jobs.memoryStorageId, job.memoryStorageId),
          eq(piMemoryPhase2Jobs.orgId, job.orgId),
          eq(piMemoryPhase2Jobs.userId, job.userId),
        ),
      )
      .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
    if (!leased) {
      throw new Error("Locked Pi memory Phase 2 job could not be leased");
    }
    return {
      ...scope,
      s3Prefix: claimableStorage.s3Prefix,
      leaseToken,
      leaseExpiresAt,
      claimedRevision: job.inputRevision,
      reconciliationQueuedAt:
        job.reconciliationRevision > job.completedRevision
          ? job.updatedAt
          : null,
      baseVersion,
      selected,
    };
  });
}

interface LockedClaimableJob extends PiMemoryPhase2OwnerScope {
  readonly status:
    | "pending"
    | "leased"
    | "retryable_failure"
    | "idle"
    | "terminal_failure";
  readonly inputRevision: number;
  readonly completedRevision: number;
  readonly reconciliationRevision: number;
  readonly claimedRevision: number | null;
  readonly retryCount: number;
  readonly updatedAt: Date;
}

interface LockedClaimableStorage extends PiMemoryPhase2OwnerScope {
  readonly baseVersionId: string;
  readonly s3Prefix: string;
}

function claimableJobCondition(args: ClaimPiMemoryPhase2JobArgs) {
  const cooldownBoundary = new Date(
    args.currentTime.getTime() - PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS,
  );
  return and(
    gt(piMemoryPhase2Jobs.inputRevision, piMemoryPhase2Jobs.completedRevision),
    or(
      eq(piMemoryPhase2Jobs.status, "pending"),
      and(
        eq(piMemoryPhase2Jobs.status, "retryable_failure"),
        lte(piMemoryPhase2Jobs.retryAt, args.currentTime),
      ),
      and(
        eq(piMemoryPhase2Jobs.status, "leased"),
        lte(piMemoryPhase2Jobs.leaseExpiresAt, args.currentTime),
        isNull(piMemoryPhase2Jobs.maintenanceRunId),
      ),
    ),
    or(
      gt(
        piMemoryPhase2Jobs.reconciliationRevision,
        piMemoryPhase2Jobs.completedRevision,
      ),
      isNull(piMemoryPhase2Jobs.lastSucceededAt),
      lte(piMemoryPhase2Jobs.lastSucceededAt, cooldownBoundary),
    ),
    claimScopeCondition(args.scope),
  );
}

async function lockNextClaimableStorage(
  tx: Tx,
  args: ClaimPiMemoryPhase2JobArgs,
): Promise<LockedClaimableStorage | null> {
  const [storage] = await tx
    .select({
      memoryStorageId: piMemoryPhase2Jobs.memoryStorageId,
      orgId: piMemoryPhase2Jobs.orgId,
      userId: piMemoryPhase2Jobs.userId,
      baseVersionId: storages.headVersionId,
      s3Prefix: storages.s3Prefix,
    })
    .from(piMemoryPhase2Jobs)
    .innerJoin(
      storages,
      and(
        eq(storages.id, piMemoryPhase2Jobs.memoryStorageId),
        eq(storages.orgId, piMemoryPhase2Jobs.orgId),
        eq(storages.userId, piMemoryPhase2Jobs.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
        ne(storages.userId, VOLUME_ORG_USER_ID),
      ),
    )
    .innerJoin(
      storageVersions,
      and(
        eq(storageVersions.storageId, storages.id),
        eq(storageVersions.id, storages.headVersionId),
      ),
    )
    .where(and(claimableJobCondition(args), isNotNull(storages.headVersionId)))
    .orderBy(
      asc(piMemoryPhase2Jobs.updatedAt),
      asc(piMemoryPhase2Jobs.memoryStorageId),
    )
    .limit(1)
    .for("update", { of: storages, skipLocked: true });
  if (!storage?.baseVersionId) {
    return null;
  }
  return {
    memoryStorageId: storage.memoryStorageId,
    orgId: storage.orgId,
    userId: storage.userId,
    baseVersionId: storage.baseVersionId,
    s3Prefix: storage.s3Prefix,
  };
}

async function lockClaimableJob(
  tx: Tx,
  args: ClaimPiMemoryPhase2JobArgs,
  scope: PiMemoryPhase2OwnerScope,
): Promise<LockedClaimableJob | null> {
  const [job] = await tx
    .select({
      memoryStorageId: piMemoryPhase2Jobs.memoryStorageId,
      orgId: piMemoryPhase2Jobs.orgId,
      userId: piMemoryPhase2Jobs.userId,
      status: piMemoryPhase2Jobs.status,
      inputRevision: piMemoryPhase2Jobs.inputRevision,
      completedRevision: piMemoryPhase2Jobs.completedRevision,
      reconciliationRevision: piMemoryPhase2Jobs.reconciliationRevision,
      claimedRevision: piMemoryPhase2Jobs.claimedRevision,
      retryCount: piMemoryPhase2Jobs.retryCount,
      updatedAt: piMemoryPhase2Jobs.updatedAt,
    })
    .from(piMemoryPhase2Jobs)
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, scope.orgId),
        eq(piMemoryPhase2Jobs.userId, scope.userId),
        claimableJobCondition(args),
      ),
    )
    .limit(1)
    .for("update", { of: piMemoryPhase2Jobs });
  return job ?? null;
}

function exactLeaseCondition(args: PiMemoryPhase2LeaseFence) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, args.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, args.orgId),
    eq(piMemoryPhase2Jobs.userId, args.userId),
    eq(piMemoryPhase2Jobs.status, "leased"),
    eq(piMemoryPhase2Jobs.leaseToken, args.leaseToken),
    eq(piMemoryPhase2Jobs.sandboxLeaseToken, args.leaseToken),
    eq(piMemoryPhase2Jobs.claimedRevision, args.claimedRevision),
    eq(piMemoryPhase2Jobs.claimedBaseVersionId, args.claimedBaseVersionId),
    ...(args.allowExpiredLease
      ? []
      : [gt(piMemoryPhase2Jobs.leaseExpiresAt, args.currentTime)]),
    ...(args.expectedMaintenanceRunId === undefined
      ? []
      : [
          args.expectedMaintenanceRunId === null
            ? isNull(piMemoryPhase2Jobs.maintenanceRunId)
            : eq(
                piMemoryPhase2Jobs.maintenanceRunId,
                args.expectedMaintenanceRunId,
              ),
        ]),
  );
}

export async function failPiMemoryPhase2Job(
  db: ApiDb,
  args: PiMemoryPhase2LeaseFence & { readonly errorClass: string },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [job] = await tx
      .select({
        inputRevision: piMemoryPhase2Jobs.inputRevision,
        retryCount: piMemoryPhase2Jobs.retryCount,
      })
      .from(piMemoryPhase2Jobs)
      .where(exactLeaseCondition(args))
      .limit(1)
      .for("update", { of: piMemoryPhase2Jobs });
    if (!job) {
      return false;
    }

    const hasNewerInput = job.inputRevision > args.claimedRevision;
    const retryCount = hasNewerInput ? 0 : job.retryCount + 1;
    const terminal = retryCount >= PI_MEMORY_PHASE2_MAX_ATTEMPTS;
    const [failed] = await tx
      .update(piMemoryPhase2Jobs)
      .set({
        status: hasNewerInput
          ? "pending"
          : terminal
            ? "terminal_failure"
            : "retryable_failure",
        claimedRevision: null,
        claimedBaseVersionId: null,
        leaseToken: null,
        sandboxLeaseToken: null,
        leaseExpiresAt: null,
        maintenanceRunId: null,
        retryCount,
        retryAt:
          hasNewerInput || terminal
            ? null
            : new Date(
                args.currentTime.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS,
              ),
        lastErrorClass: hasNewerInput ? null : args.errorClass,
        claimedSelectionDigest: null,
        claimedSelectedCount: null,
        claimedSelectedUtf8Bytes: null,
        updatedAt: args.currentTime,
      })
      .where(exactLeaseCondition(args))
      .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
    return failed !== undefined;
  });
}
