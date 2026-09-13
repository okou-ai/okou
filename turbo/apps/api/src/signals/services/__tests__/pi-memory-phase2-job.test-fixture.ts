import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { blobs } from "@okouai/db/schema/blob";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages, storageVersions } from "@okouai/db/schema/storage";

import { db } from "../../../lib/db";
import {
  insertPiMemoryStage1Candidates,
  deleteStoragesWithPiMemoryCandidates,
} from "../pi-memory-stage1-candidate.service";

const fixtureHashes = Symbol("fixtureHashes");

interface Phase2TestScope {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly baseVersion: Phase2TestVersion;
  readonly [fixtureHashes]: Set<string>;
}

interface Phase2TestVersion {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly message: string | null;
  readonly createdBy: string;
}

export interface Phase2CandidateInput {
  readonly piSessionId: string;
  readonly sourceRunId?: string;
  readonly sourceHistoryHash?: string;
  readonly sourceCompletedAt?: Date;
  readonly status?:
    | "pending"
    | "leased"
    | "succeeded"
    | "succeeded_no_output"
    | "retryable_failure"
    | "terminal_failure";
  readonly rawMemory?: string | null;
  readonly rolloutSummary?: string | null;
  readonly rolloutSlug?: string | null;
  readonly generatedAt?: Date | null;
  readonly leaseToken?: string | null;
  readonly leaseExpiresAt?: Date | null;
  readonly retryAt?: Date | null;
  readonly retryCount?: number;
  readonly lastErrorClass?: string | null;
  readonly usageCount?: number;
  readonly lastUsedAt?: Date | null;
  readonly lastSelectedSourceHistoryHash?: string | null;
}

type Phase2CandidateStatus = Exclude<Phase2CandidateInput["status"], undefined>;

function candidateHash(scope: Phase2TestScope, piSessionId: string): string {
  return createHash("sha256")
    .update(`${scope.memoryStorageId}:${piSessionId}:${randomUUID()}`)
    .digest("hex");
}

async function insertFixtureBlobs(
  scope: Phase2TestScope,
  hashes: readonly string[],
): Promise<void> {
  for (const hash of hashes) {
    scope[fixtureHashes].add(hash);
  }
  if (hashes.length === 0) {
    return;
  }
  await db()
    .insert(blobs)
    .values(
      hashes.map((hash) => {
        return {
          hash,
          rawSize: 1,
          encoding: "identity",
          encodedSize: 1,
          refCount: 1,
        };
      }),
    )
    .onConflictDoNothing();
}

export async function createPhase2TestScope(
  label: string,
  overrides: {
    readonly userId?: string;
    readonly emptyBase?: boolean;
    readonly s3Prefix?: string;
  } = {},
): Promise<Phase2TestScope> {
  const memoryStorageId = randomUUID();
  const orgId = `phase2-${label}-org-${randomUUID()}`;
  const userId = overrides.userId ?? `phase2-${label}-user-${randomUUID()}`;
  const generatedBaseVersion = phase2TestVersion(
    { memoryStorageId, orgId, userId },
    "base",
  );
  const baseVersion = overrides.emptyBase
    ? {
        ...generatedBaseVersion,
        versionId: createHash("sha256")
          .update(`storage:${memoryStorageId}\n`)
          .digest("hex"),
        s3Key: `${orgId}/${memoryStorageId}/empty`,
        size: 0,
        archiveSize: 0,
        fileCount: 0,
      }
    : generatedBaseVersion;
  const scope = {
    memoryStorageId,
    orgId,
    userId,
  } as Phase2TestScope;
  Object.defineProperty(scope, "baseVersion", {
    value: baseVersion,
    enumerable: false,
  });
  Object.defineProperty(scope, fixtureHashes, {
    value: new Set<string>(),
    enumerable: false,
  });
  await db()
    .insert(storages)
    .values({
      id: scope.memoryStorageId,
      orgId: scope.orgId,
      userId: scope.userId,
      name: MEMORY_ARTIFACT_NAME,
      s3Prefix: overrides.s3Prefix ?? `${scope.orgId}/${scope.memoryStorageId}`,
    });
  await db().insert(storageVersions).values(storageVersionRow(baseVersion));
  await db()
    .update(storages)
    .set({
      headVersionId: baseVersion.versionId,
      size: baseVersion.size,
      fileCount: baseVersion.fileCount,
    })
    .where(eq(storages.id, scope.memoryStorageId));
  onTestFinished(async () => {
    const versions = await db()
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(eq(storageVersions.storageId, scope.memoryStorageId));
    if (versions.length > 0) {
      await db()
        .update(storages)
        .set({ headVersionId: null })
        .where(
          inArray(
            storages.headVersionId,
            versions.map((version) => {
              return version.id;
            }),
          ),
        );
    }
    await db().transaction(async (tx) => {
      await deleteStoragesWithPiMemoryCandidates(
        tx,
        eq(storages.id, scope.memoryStorageId),
      );
    });
    const hashes = [...scope[fixtureHashes]];
    if (hashes.length > 0) {
      await db().delete(blobs).where(inArray(blobs.hash, hashes));
    }
  });
  return scope;
}

function phase2TestVersion(
  scope: Pick<Phase2TestScope, "memoryStorageId" | "orgId" | "userId">,
  label: string,
  overrides: Partial<Omit<Phase2TestVersion, "storageId">> = {},
): Phase2TestVersion {
  const versionId = createHash("sha256")
    .update(`${scope.memoryStorageId}:${label}:${randomUUID()}`)
    .digest("hex");
  return {
    storageId: scope.memoryStorageId,
    versionId,
    s3Key: `${scope.orgId}/${scope.memoryStorageId}/${versionId}`,
    size: 101,
    archiveSize: 67,
    fileCount: 3,
    message: null,
    createdBy: "pi-memory-test",
    ...overrides,
  };
}

function storageVersionRow(version: Phase2TestVersion) {
  return {
    id: version.versionId,
    storageId: version.storageId,
    s3Key: version.s3Key,
    size: version.size,
    archiveSize: version.archiveSize,
    fileCount: version.fileCount,
    message: version.message,
    createdBy: version.createdBy,
  };
}

export async function insertPhase2StorageVersion(
  scope: Phase2TestScope,
  label: string,
  overrides: Partial<Omit<Phase2TestVersion, "storageId">> = {},
): Promise<Phase2TestVersion> {
  const version = phase2TestVersion(scope, label, overrides);
  await db().insert(storageVersions).values(storageVersionRow(version));
  return version;
}

export async function setPhase2StorageHead(
  scope: Phase2TestScope,
  version: Phase2TestVersion,
  updatedAt = new Date("2026-09-03T04:00:00.000Z"),
): Promise<void> {
  await db()
    .update(storages)
    .set({
      headVersionId: version.versionId,
      size: version.size,
      fileCount: version.fileCount,
      updatedAt,
    })
    .where(
      and(
        eq(storages.id, scope.memoryStorageId),
        eq(storages.orgId, scope.orgId),
        eq(storages.userId, scope.userId),
      ),
    );
}

export async function insertPhase2Candidates(
  scope: Phase2TestScope,
  inputs: readonly Phase2CandidateInput[],
): Promise<readonly string[]> {
  const now = new Date("2026-09-03T04:00:00.000Z");
  const hashes = inputs.map((input) => {
    return input.sourceHistoryHash ?? candidateHash(scope, input.piSessionId);
  });
  await insertFixtureBlobs(scope, hashes);
  await db().transaction(async (tx) => {
    await insertPiMemoryStage1Candidates(
      tx,
      inputs.map((input, index) => {
        return phase2CandidateRow(scope, input, hashes[index] as string, now);
      }),
    );
  });
  return hashes;
}

function phase2CandidateOutput(
  input: Phase2CandidateInput,
  status: Phase2CandidateStatus,
  sourceCompletedAt: Date,
) {
  if (status === "succeeded") {
    return {
      rawMemory: input.rawMemory ?? "raw memory",
      rolloutSummary: input.rolloutSummary ?? "rollout summary",
      rolloutSlug: input.rolloutSlug ?? null,
      generatedAt: input.generatedAt ?? sourceCompletedAt,
    };
  }
  return {
    rawMemory: null,
    rolloutSummary: null,
    rolloutSlug: null,
    generatedAt:
      status === "succeeded_no_output"
        ? (input.generatedAt ?? sourceCompletedAt)
        : null,
  };
}

function phase2CandidateRow(
  scope: Phase2TestScope,
  input: Phase2CandidateInput,
  sourceHistoryHash: string,
  now: Date,
): typeof piMemoryStage1Candidates.$inferInsert {
  const status = input.status ?? "succeeded";
  const sourceCompletedAt = input.sourceCompletedAt ?? now;
  return {
    memoryStorageId: scope.memoryStorageId,
    orgId: scope.orgId,
    userId: scope.userId,
    piSessionId: input.piSessionId,
    sourceRunId: input.sourceRunId ?? randomUUID(),
    sourceHistoryHash,
    sourceCompletedAt,
    eligibleAt: sourceCompletedAt,
    status,
    leaseToken: input.leaseToken ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    retryAt: input.retryAt ?? null,
    retryCount: input.retryCount ?? (status === "terminal_failure" ? 3 : 0),
    lastErrorClass:
      input.lastErrorClass ??
      (status === "terminal_failure" ? "attempts_exhausted" : null),
    ...phase2CandidateOutput(input, status, sourceCompletedAt),
    usageCount: input.usageCount ?? 0,
    lastUsedAt: input.lastUsedAt ?? null,
    lastSelectedSourceHistoryHash: input.lastSelectedSourceHistoryHash ?? null,
  };
}

export async function insertPendingPhase2Job(
  scope: Phase2TestScope,
  overrides: Partial<typeof piMemoryPhase2Jobs.$inferInsert> = {},
): Promise<void> {
  await db()
    .insert(piMemoryPhase2Jobs)
    .values({
      ...scope,
      status: "pending",
      inputRevision: 1,
      completedRevision: 0,
      retryCount: 0,
      ...(overrides.status === "leased"
        ? {
            claimedBaseVersionId:
              overrides.claimedBaseVersionId ?? scope.baseVersion.versionId,
            lastObservedHeadVersionId:
              overrides.lastObservedHeadVersionId ??
              scope.baseVersion.versionId,
            ...(overrides.legacyLeaseToken === undefined &&
            overrides.sandboxLeaseToken === undefined &&
            overrides.leaseToken !== undefined
              ? { sandboxLeaseToken: overrides.leaseToken }
              : {}),
          }
        : {}),
      ...overrides,
    });
}

export async function readPhase2Job(scope: Phase2TestScope) {
  const [job] = await db()
    .select()
    .from(piMemoryPhase2Jobs)
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, scope.orgId),
        eq(piMemoryPhase2Jobs.userId, scope.userId),
      ),
    );
  return job;
}
