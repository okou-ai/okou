import {
  usagePricingResolution$,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import {
  observePiMemoryStage1Cost,
  observePiMemoryStage1MissingUsage,
} from "./pi-memory-stage1-cost.service";
import {
  checkPiMemoryQuota,
  PiMemoryQuotaError,
} from "./pi-memory-quota.service";
import { checkOrgCreditsForRunAdmission } from "./run-admission.service";
import {
  PI_MEMORY_STAGE1_MODEL,
  PiMemoryStage1ProviderError,
  PiMemoryStage1BudgetError,
  type PiMemoryStage1Evidence,
  projectPiMemoryStage1Evidence,
  redactPiMemoryStage1Secrets,
  runPiMemoryStage1Extraction,
  type PiMemoryStage1ProviderResult,
} from "@okouai/pi-agent-runtime/api";
import {
  resolvePiMemoryStage1Credential,
  PiMemoryStage1CredentialError,
  PiMemoryStage1CredentialRefreshError,
  type PiMemoryStage1CredentialResult,
} from "./pi-memory-stage1-credential.service";
import { piMemoryStage1Selections } from "@okouai/db/schema/pi-memory-stage1-schedule";
import {
  consumePiMemoryStage1Days,
  validatePiMemoryStage1Selection,
  piMemoryStage1UtcDay,
  type PiMemoryStage1Selection,
} from "./pi-memory-stage1-schedule.service";
import { createHash, randomUUID } from "node:crypto";

import {
  RESUME_SESSION_HISTORY_MAX_BYTES,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
} from "@okouai/api-contracts/contracts/runners";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { blobs } from "@okouai/db/schema/blob";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  lte,
  or,
} from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  downloadS3BufferWithMaxBytes,
  S3ObjectSizeLimitError,
} from "../external/s3";
import {
  safeJsonParse,
  safeSync,
  settle,
  settleIncludingAbort,
} from "../utils";
import { commitPiMemoryStage1Candidate } from "./pi-memory-stage1-candidate.service";
import { recordPiMemoryStage1Usage } from "./pi-memory-stage1-usage.service";
import {
  gunzipSessionHistoryBufferWithMaxBytes,
  unzstdSessionHistoryBufferWithMaxBytes,
} from "./session-history-decompression";
import {
  resumeSessionHistoryBlobKey,
  tryNormalizeSessionHistoryBlobEncoding,
  type SessionHistoryBlobEncoding,
} from "./session-history-blobs";

const log = logger("PiMemoryStage1Worker");

const PI_MEMORY_STAGE1_SCAN_LIMIT = 5000;
const PI_MEMORY_STAGE1_CLAIM_LIMIT = 8;
const PI_MEMORY_STAGE1_PROVIDER_CONCURRENCY = 8;
const PI_MEMORY_STAGE1_LEASE_MS = 60 * 60 * 1000;
const PI_MEMORY_STAGE1_MAX_ATTEMPTS = 5;
const PI_MEMORY_STAGE1_RETRY_DELAY_MS = 60 * 60 * 1000;

const RAW_MEMORY_MAX_BYTES = 64 * 1024;
const ROLLOUT_SUMMARY_MAX_BYTES = 16 * 1024;
const ROLLOUT_SLUG_MAX_BYTES = 255;
const SAFE_SLUG = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;

const stage1OutputSchema = z
  .object({
    raw_memory: z.string(),
    rollout_summary: z.string(),
    rollout_slug: z.string().nullable(),
  })
  .strict();

interface PiMemoryStage1Scope {
  readonly memoryStorageIds: readonly string[];
  readonly piSessionId?: string;
}

interface PiMemoryStage1WorkerInput {
  readonly scope: PiMemoryStage1Scope | undefined;
  readonly currentTime: Date;
}

interface ClaimedPiMemoryStage1Work {
  readonly memoryStorageId: string;
  readonly piSessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly sourceHistoryHash: string;
  readonly sourceCompletedAt: Date;
  readonly blobEncoding: string;
  readonly blobRawSize: number;
  readonly blobEncodedSize: number;
  readonly leaseToken: string;
  readonly attemptCount: number;
  readonly selection: PiMemoryStage1Selection;
}

interface ClaimResult {
  readonly scanned: number;
  readonly staleDiscarded: number;
  readonly sourceActive: number;
  readonly sourceExpired: number;
  readonly terminalFailure: number;
  readonly claimed: readonly ClaimedPiMemoryStage1Work[];
}

export interface PiMemoryStage1WorkerResult {
  readonly scanned: number;
  readonly claimed: number;
  readonly succeeded: number;
  readonly succeededNoOutput: number;
  readonly retryableFailure: number;
  readonly terminalFailure: number;
  readonly sourceExpired: number;
  readonly sourceActive: number;
  readonly staleDiscarded: number;
}

interface PreparedWork {
  readonly work: ClaimedPiMemoryStage1Work;
  readonly evidence: readonly PiMemoryStage1Evidence[];
}

interface RoutedWork extends PreparedWork {
  readonly credential: Extract<
    PiMemoryStage1CredentialResult,
    { status: "available" }
  >;
}

class StaleWorkError extends Error {}

interface WorkOutcome {
  readonly kind:
    | "succeeded"
    | "succeeded_no_output"
    | "retryable_failure"
    | "terminal_failure"
    | "stale_discarded";
}

class PermanentSourceError extends Error {
  readonly errorClass: string;

  constructor(errorClass: string) {
    super("Pi memory Stage 1 source is permanently invalid");
    this.name = "PermanentSourceError";
    this.errorClass = errorClass;
  }
}

class RetryableWorkError extends Error {
  readonly errorClass: string;

  constructor(errorClass: string) {
    super("Pi memory Stage 1 work must be retried");
    this.name = "RetryableWorkError";
    this.errorClass = errorClass;
  }
}

/** Terminal, non-retryable: the owner has PiMemory off, so the work is moot. */
class DisabledWorkError extends Error {
  readonly errorClass = "pi_memory_disabled";

  constructor() {
    super("Pi memory is disabled for the Stage 1 work owner");
    this.name = "DisabledWorkError";
  }
}

function scopeCondition(scope: PiMemoryStage1Scope | undefined) {
  return scope
    ? and(
        inArray(
          piMemoryStage1Candidates.memoryStorageId,
          scope.memoryStorageIds,
        ),
        scope.piSessionId
          ? eq(piMemoryStage1Candidates.piSessionId, scope.piSessionId)
          : undefined,
      )
    : undefined;
}

function dueCondition(currentTime: Date) {
  return or(
    and(
      eq(piMemoryStage1Candidates.status, "pending"),
      lte(piMemoryStage1Candidates.eligibleAt, currentTime),
    ),
    and(
      eq(piMemoryStage1Candidates.status, "retryable_failure"),
      lte(piMemoryStage1Candidates.retryAt, currentTime),
    ),
    and(
      eq(piMemoryStage1Candidates.status, "leased"),
      lte(piMemoryStage1Candidates.leaseExpiresAt, currentTime),
    ),
  );
}

async function markLockedTerminal(
  db: Db,
  row: Pick<
    ClaimedPiMemoryStage1Work,
    "memoryStorageId" | "piSessionId" | "sourceHistoryHash"
  >,
  currentTime: Date,
  errorClass: string,
): Promise<boolean> {
  const [updated] = await db
    .update(piMemoryStage1Candidates)
    .set({
      status: "terminal_failure",
      leaseToken: null,
      leaseExpiresAt: null,
      retryAt: null,
      lastErrorClass: errorClass,
      rawMemory: null,
      rolloutSummary: null,
      rolloutSlug: null,
      generatedAt: null,
      lastSelectedSourceHistoryHash: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, row.memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, row.piSessionId),
        eq(piMemoryStage1Candidates.sourceHistoryHash, row.sourceHistoryHash),
      ),
    )
    .returning({ memoryStorageId: piMemoryStage1Candidates.memoryStorageId });
  return updated !== undefined;
}

async function selectDueCandidateRows(
  db: Db,
  input: PiMemoryStage1WorkerInput,
) {
  return await db
    .select({
      selection: getTableColumns(piMemoryStage1Selections),
      memoryStorageId: piMemoryStage1Candidates.memoryStorageId,
      piSessionId: piMemoryStage1Candidates.piSessionId,
      orgId: piMemoryStage1Candidates.orgId,
      userId: piMemoryStage1Candidates.userId,
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
      sourceCompletedAt: piMemoryStage1Candidates.sourceCompletedAt,
      status: piMemoryStage1Candidates.status,
      retryCount: piMemoryStage1Candidates.retryCount,
      blobEncoding: blobs.encoding,
      blobRawSize: blobs.rawSize,
      blobEncodedSize: blobs.encodedSize,
    })
    .from(piMemoryStage1Candidates)
    .innerJoin(
      piMemoryStage1Selections,
      and(
        eq(
          piMemoryStage1Selections.memoryStorageId,
          piMemoryStage1Candidates.memoryStorageId,
        ),
        eq(
          piMemoryStage1Selections.piSessionId,
          piMemoryStage1Candidates.piSessionId,
        ),
        eq(piMemoryStage1Selections.orgId, piMemoryStage1Candidates.orgId),
        eq(piMemoryStage1Selections.userId, piMemoryStage1Candidates.userId),
        eq(
          piMemoryStage1Selections.sourceRunId,
          piMemoryStage1Candidates.sourceRunId,
        ),
        eq(
          piMemoryStage1Selections.sourceHistoryHash,
          piMemoryStage1Candidates.sourceHistoryHash,
        ),
        eq(
          piMemoryStage1Selections.sourceCompletedAt,
          piMemoryStage1Candidates.sourceCompletedAt,
        ),
        eq(
          piMemoryStage1Selections.day,
          piMemoryStage1UtcDay(input.currentTime),
        ),
      ),
    )
    .innerJoin(
      storages,
      and(
        eq(storages.id, piMemoryStage1Candidates.memoryStorageId),
        eq(storages.orgId, piMemoryStage1Candidates.orgId),
        eq(storages.userId, piMemoryStage1Candidates.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .innerJoin(
      blobs,
      eq(blobs.hash, piMemoryStage1Candidates.sourceHistoryHash),
    )
    .where(and(dueCondition(input.currentTime), scopeCondition(input.scope)))
    .orderBy(
      asc(piMemoryStage1Candidates.eligibleAt),
      asc(piMemoryStage1Candidates.memoryStorageId),
      asc(piMemoryStage1Candidates.piSessionId),
    )
    .limit(input.scope?.piSessionId ? 1 : PI_MEMORY_STAGE1_SCAN_LIMIT);
}

export async function claimPiMemoryStage1Work(
  db: Db,
  input: PiMemoryStage1WorkerInput,
): Promise<ClaimResult> {
  await consumePiMemoryStage1Days(
    db,
    input.currentTime,
    input.scope?.memoryStorageIds,
  );
  const rows = await selectDueCandidateRows(db, input);
  let staleDiscarded = 0;
  let terminalFailure = 0;
  const claimed: ClaimedPiMemoryStage1Work[] = [];
  for (const row of rows) {
    if (claimed.length >= PI_MEMORY_STAGE1_CLAIM_LIMIT) {
      break;
    }
    await db.transaction(async (tx) => {
      if (
        !(await validatePiMemoryStage1Selection(
          tx,
          row.selection,
          input.currentTime,
        ))
      ) {
        staleDiscarded += 1;
        log.debug("Pi memory Stage 1 claim skipped", {
          userId: row.userId,
          day: row.selection.day,
          chatThreadId: row.selection.chatThreadId,
          outcome: "stale_selection",
        });
        return;
      }
      const [current] = await tx
        .select()
        .from(piMemoryStage1Candidates)
        .where(
          and(
            eq(piMemoryStage1Candidates.memoryStorageId, row.memoryStorageId),
            eq(piMemoryStage1Candidates.piSessionId, row.piSessionId),
            eq(piMemoryStage1Candidates.sourceRunId, row.selection.sourceRunId),
            eq(
              piMemoryStage1Candidates.sourceHistoryHash,
              row.sourceHistoryHash,
            ),
            eq(
              piMemoryStage1Candidates.sourceCompletedAt,
              row.selection.sourceCompletedAt,
            ),
            dueCondition(input.currentTime),
          ),
        )
        .for("update", { skipLocked: true });
      if (!current) {
        return;
      }
      const reclaimedFailureCount =
        current.retryCount + (current.status === "leased" ? 1 : 0);
      if (reclaimedFailureCount >= PI_MEMORY_STAGE1_MAX_ATTEMPTS) {
        if (
          await markLockedTerminal(
            tx,
            row,
            input.currentTime,
            "attempts_exhausted",
          )
        ) {
          terminalFailure += 1;
        }
        return;
      }
      const leaseToken = randomUUID();
      await tx
        .update(piMemoryStage1Candidates)
        .set({
          status: "leased",
          leaseToken,
          leaseExpiresAt: new Date(
            input.currentTime.getTime() + PI_MEMORY_STAGE1_LEASE_MS,
          ),
          retryAt: null,
          retryCount: reclaimedFailureCount,
          lastErrorClass: null,
          updatedAt: input.currentTime,
        })
        .where(
          and(
            eq(piMemoryStage1Candidates.memoryStorageId, row.memoryStorageId),
            eq(piMemoryStage1Candidates.piSessionId, row.piSessionId),
          ),
        );
      claimed.push({
        ...row,
        leaseToken,
        attemptCount: reclaimedFailureCount + 1,
      });
    });
  }
  return {
    scanned: rows.length,
    sourceActive: 0,
    staleDiscarded,
    sourceExpired: 0,
    terminalFailure,
    claimed,
  };
}

function validatedBlobEncoding(
  work: ClaimedPiMemoryStage1Work,
): SessionHistoryBlobEncoding {
  if (
    !Number.isSafeInteger(work.blobRawSize) ||
    work.blobRawSize <= 0 ||
    work.blobRawSize > RESUME_SESSION_HISTORY_MAX_BYTES ||
    !Number.isSafeInteger(work.blobEncodedSize) ||
    work.blobEncodedSize <= 0 ||
    work.blobEncodedSize > RESUME_SESSION_HISTORY_MAX_BYTES
  ) {
    throw new PermanentSourceError("source_metadata_invalid");
  }
  const encoding = tryNormalizeSessionHistoryBlobEncoding(work.blobEncoding);
  if (encoding === undefined) {
    throw new PermanentSourceError("source_encoding_invalid");
  }
  if (
    encoding === SESSION_HISTORY_ENCODING_IDENTITY &&
    work.blobEncodedSize !== work.blobRawSize
  ) {
    throw new PermanentSourceError("source_metadata_invalid");
  }
  return encoding;
}

async function decodeHistory(
  work: ClaimedPiMemoryStage1Work,
  encoded: Buffer,
  encoding: SessionHistoryBlobEncoding,
  key: string,
): Promise<Buffer> {
  if (encoding === SESSION_HISTORY_ENCODING_IDENTITY) {
    return encoded;
  }
  const decoded = await settle(
    encoding === SESSION_HISTORY_ENCODING_GZIP
      ? gunzipSessionHistoryBufferWithMaxBytes(key, encoded, work.blobRawSize)
      : unzstdSessionHistoryBufferWithMaxBytes(key, encoded, work.blobRawSize),
  );
  if (!decoded.ok) {
    throw new PermanentSourceError("source_decompression_invalid");
  }
  return decoded.value;
}

const loadAndProjectHistory$ = command(
  async (
    { get },
    args: {
      readonly work: ClaimedPiMemoryStage1Work;
    },
    signal: AbortSignal,
  ): Promise<PreparedWork> => {
    const encoding = validatedBlobEncoding(args.work);
    const key = resumeSessionHistoryBlobKey(
      args.work.sourceHistoryHash,
      encoding,
    );
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          key,
          args.work.blobEncodedSize,
          signal,
        ),
      ),
      signal,
    );
    if (!downloaded.ok) {
      if (downloaded.error instanceof S3ObjectSizeLimitError) {
        throw new PermanentSourceError("source_encoded_size_invalid");
      }
      throw new RetryableWorkError("source_download_failed");
    }
    const encoded = downloaded.value;
    if (encoded.length !== args.work.blobEncodedSize) {
      throw new PermanentSourceError("source_encoded_size_invalid");
    }
    const raw = await decodeHistory(args.work, encoded, encoding, key);
    signal.throwIfAborted();
    if (
      raw.length !== args.work.blobRawSize ||
      createHash("sha256").update(raw).digest("hex") !==
        args.work.sourceHistoryHash
    ) {
      throw new PermanentSourceError("source_integrity_invalid");
    }
    const decodedJsonl = safeSync(() => {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    });
    if (!("ok" in decodedJsonl)) {
      throw new PermanentSourceError("source_utf8_invalid");
    }
    const projection = safeSync(() => {
      return projectPiMemoryStage1Evidence({
        jsonl: decodedJsonl.ok,
        expectedSessionId: args.work.piSessionId,
      });
    });
    if (!("ok" in projection)) {
      if (projection.error instanceof PiMemoryStage1BudgetError) {
        throw projection.error;
      }
      throw new PermanentSourceError("source_pi_session_invalid");
    }
    return { work: args.work, evidence: projection.ok };
  },
);

async function commitWorkResult(
  db: Db,
  work: ClaimedPiMemoryStage1Work,
  result:
    | {
        readonly kind: "succeeded";
        readonly rawMemory: string;
        readonly rolloutSummary: string;
        readonly rolloutSlug?: string;
      }
    | { readonly kind: "succeeded_no_output" }
    | { readonly kind: "retryable_failure"; readonly errorClass: string }
    | { readonly kind: "terminal_failure"; readonly errorClass: string },
  options?: { readonly revalidateSelection: boolean },
): Promise<boolean> {
  const committedAt = nowDate();
  const candidateResult =
    result.kind === "retryable_failure"
      ? work.attemptCount >= PI_MEMORY_STAGE1_MAX_ATTEMPTS
        ? {
            kind: "terminal_failure" as const,
            errorClass: "attempts_exhausted",
          }
        : {
            kind: result.kind,
            errorClass: result.errorClass,
            retryAt: new Date(
              committedAt.getTime() + PI_MEMORY_STAGE1_RETRY_DELAY_MS,
            ),
          }
      : result;
  return await db.transaction(async (tx) => {
    if (
      options?.revalidateSelection &&
      !(await validatePiMemoryStage1Selection(tx, work.selection, committedAt))
    ) {
      return false;
    }
    return await commitPiMemoryStage1Candidate(tx, {
      memoryStorageId: work.memoryStorageId,
      orgId: work.orgId,
      userId: work.userId,
      piSessionId: work.piSessionId,
      sourceHistoryHash: work.sourceHistoryHash,
      leaseToken: work.leaseToken,
      committedAt,
      result: candidateResult,
      selectedSource: work.selection,
    });
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function parseProviderOutput(responseText: string):
  | {
      readonly kind: "succeeded";
      readonly rawMemory: string;
      readonly rolloutSummary: string;
      readonly rolloutSlug?: string;
    }
  | { readonly kind: "succeeded_no_output" } {
  const parsed = stage1OutputSchema.safeParse(safeJsonParse(responseText));
  if (!parsed.success) {
    throw new RetryableWorkError("provider_output_invalid");
  }
  const rawMemory = redactPiMemoryStage1Secrets(parsed.data.raw_memory).trim();
  const rolloutSummary = redactPiMemoryStage1Secrets(
    parsed.data.rollout_summary,
  ).trim();
  const redactedSlug =
    parsed.data.rollout_slug === null
      ? null
      : redactPiMemoryStage1Secrets(parsed.data.rollout_slug).trim();
  if (!rawMemory || !rolloutSummary) {
    return { kind: "succeeded_no_output" };
  }
  if (
    byteLength(rawMemory) > RAW_MEMORY_MAX_BYTES ||
    byteLength(rolloutSummary) > ROLLOUT_SUMMARY_MAX_BYTES ||
    (redactedSlug !== null &&
      (redactedSlug.length === 0 ||
        byteLength(redactedSlug) > ROLLOUT_SLUG_MAX_BYTES ||
        !SAFE_SLUG.test(redactedSlug)))
  ) {
    throw new RetryableWorkError("provider_output_invalid");
  }
  return {
    kind: "succeeded",
    rawMemory,
    rolloutSummary,
    ...(redactedSlug === null ? {} : { rolloutSlug: redactedSlug }),
  };
}

function logOutcome(args: {
  readonly work: ClaimedPiMemoryStage1Work;
  readonly outcome: string;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly errorClass?: string;
}): void {
  log.info("Pi memory Stage 1 candidate processed", {
    orgId: args.work.orgId,
    userId: args.work.userId,
    memoryStorageId: args.work.memoryStorageId,
    piSessionId: args.work.piSessionId,
    sourceHistoryHash: args.work.sourceHistoryHash,
    attemptCount: args.work.attemptCount,
    day: args.work.selection.day,
    chatThreadId: args.work.selection.chatThreadId,
    sourceRunId: args.work.selection.sourceRunId,
    outcome: args.outcome,
    durationMs: Math.max(0, Math.round(args.durationMs)),
    inputTokens: args.inputTokens ?? 0,
    outputTokens: args.outputTokens ?? 0,
    ...(args.errorClass ? { errorClass: args.errorClass } : {}),
  });
}

function isCredentialFailure(
  error: unknown,
): error is
  | PiMemoryStage1CredentialError
  | PiMemoryStage1CredentialRefreshError {
  return (
    error instanceof PiMemoryStage1CredentialError ||
    error instanceof PiMemoryStage1CredentialRefreshError
  );
}

function workErrorClass(error: unknown): string {
  return error instanceof PermanentSourceError ||
    error instanceof RetryableWorkError ||
    error instanceof PiMemoryQuotaError ||
    isCredentialFailure(error) ||
    error instanceof PiMemoryStage1BudgetError ||
    error instanceof DisabledWorkError
    ? error.errorClass
    : error instanceof DOMException && error.name === "AbortError"
      ? "abort"
      : "worker_failure";
}

async function failWork(
  db: Db,
  work: ClaimedPiMemoryStage1Work,
  error: unknown,
  startedAt: number,
): Promise<WorkOutcome> {
  const permanent =
    error instanceof PermanentSourceError ||
    error instanceof DisabledWorkError ||
    error instanceof PiMemoryStage1CredentialError ||
    error instanceof PiMemoryStage1BudgetError;
  const errorClass = workErrorClass(error);
  const committedResult = await settleIncludingAbort(
    commitWorkResult(
      db,
      work,
      permanent
        ? { kind: "terminal_failure", errorClass }
        : { kind: "retryable_failure", errorClass },
      {
        revalidateSelection:
          isCredentialFailure(error) || error instanceof PiMemoryQuotaError,
      },
    ),
  );
  if (!committedResult.ok || !committedResult.value) {
    logOutcome({
      work,
      outcome: "stale_discarded",
      durationMs: performance.now() - startedAt,
      errorClass: committedResult.ok ? errorClass : "commit_failed",
    });
    return { kind: "stale_discarded" };
  }
  const terminal =
    permanent || work.attemptCount >= PI_MEMORY_STAGE1_MAX_ATTEMPTS;
  const kind = terminal ? "terminal_failure" : "retryable_failure";
  logOutcome({
    work,
    outcome: kind,
    durationMs: performance.now() - startedAt,
    errorClass: terminal && !permanent ? "attempts_exhausted" : errorClass,
  });
  return { kind };
}

async function retryOwnedWorkAfterAbort(
  db: Db,
  owned: ReadonlySet<ClaimedPiMemoryStage1Work>,
  reason: unknown,
): Promise<void> {
  await Promise.all(
    [...owned].map(async (work) => {
      await failWork(db, work, reason, performance.now());
    }),
  );
}

async function partitionWorkByPiMemorySwitch(
  db: Db,
  claimed: readonly ClaimedPiMemoryStage1Work[],
  signal: AbortSignal,
): Promise<{
  readonly enabled: readonly ClaimedPiMemoryStage1Work[];
  readonly disabled: readonly ClaimedPiMemoryStage1Work[];
}> {
  const enabled: ClaimedPiMemoryStage1Work[] = [];
  const disabled: ClaimedPiMemoryStage1Work[] = [];
  for (const work of claimed) {
    // Each candidate's own owner decides, never the cron caller.
    const context = await loadUserFeatureSwitchContext(
      db,
      work.orgId,
      work.userId,
    );
    signal.throwIfAborted();
    (isFeatureEnabled(FeatureSwitchKey.PiMemory, context)
      ? enabled
      : disabled
    ).push(work);
  }
  return { enabled, disabled };
}

const prepareSourceWork$ = command(
  async (
    { set },
    { work }: { readonly work: ClaimedPiMemoryStage1Work },
    signal: AbortSignal,
  ): Promise<RoutedWork> => {
    const history = await set(loadAndProjectHistory$, { work }, signal);
    signal.throwIfAborted();
    const credential = await resolvePiMemoryStage1Credential(
      set(writeDb$),
      {
        sourceRunId: work.selection.sourceRunId,
        orgId: work.orgId,
        userId: work.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (credential.status === "skip") {
      throw new PiMemoryStage1CredentialError(credential.reason);
    }
    return { ...history, credential };
  },
);

async function validatePreparedWork(
  db: Db,
  work: ClaimedPiMemoryStage1Work,
  signal: AbortSignal,
): Promise<void> {
  const currentTime = nowDate();
  const valid = await db.transaction(async (tx) => {
    if (
      !(await validatePiMemoryStage1Selection(tx, work.selection, currentTime))
    ) {
      return false;
    }
    const [fenced] = await tx
      .select({ token: piMemoryStage1Candidates.leaseToken })
      .from(piMemoryStage1Candidates)
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, work.memoryStorageId),
          eq(piMemoryStage1Candidates.piSessionId, work.piSessionId),
          eq(
            piMemoryStage1Candidates.sourceHistoryHash,
            work.sourceHistoryHash,
          ),
          eq(piMemoryStage1Candidates.sourceRunId, work.selection.sourceRunId),
          eq(piMemoryStage1Candidates.status, "leased"),
          eq(piMemoryStage1Candidates.leaseToken, work.leaseToken),
          gt(piMemoryStage1Candidates.leaseExpiresAt, nowDate()),
        ),
      );
    return !!fenced;
  });
  signal.throwIfAborted();
  if (!valid || work.selection.day !== piMemoryStage1UtcDay(nowDate())) {
    throw new StaleWorkError();
  }
}

function classifyProviderFailure(error: unknown): unknown {
  if (!(error instanceof PiMemoryStage1ProviderError)) {
    return error;
  }
  return error.status === 401 || error.status === 403
    ? new PiMemoryStage1CredentialError("credential_unavailable")
    : new RetryableWorkError("provider_failure");
}

async function recordObservedUsage(
  db: Db,
  prepared: RoutedWork,
  observedResult: PiMemoryStage1ProviderResult,
  requestId: string,
  pricingResolution: UsagePricingResolution,
) {
  const usageArgs = {
    memoryStorageId: prepared.work.memoryStorageId,
    piSessionId: prepared.work.piSessionId,
    sourceHistoryHash: prepared.work.sourceHistoryHash,
    billing: prepared.credential.billing,
    responseSourceId: observedResult.responseId ?? `request:${requestId}`,
    usage: observedResult.usage,
  };
  const recordedUsage = await settleIncludingAbort(
    recordPiMemoryStage1Usage(db, usageArgs),
  );
  await observePiMemoryStage1Cost(
    db,
    usageArgs,
    recordedUsage.ok ? recordedUsage.value : null,
    pricingResolution,
  );
  return recordedUsage;
}

interface ProcessPreparedWorkArgs {
  readonly db: Db;
  readonly prepared: RoutedWork;
  readonly pricingResolution: UsagePricingResolution;
}

async function processPreparedWork(
  args: ProcessPreparedWorkArgs,
  signal: AbortSignal,
): Promise<WorkOutcome> {
  const startedAt = performance.now();
  const requestId = randomUUID();
  let requestPrepared = false;
  const provider = await settleIncludingAbort(
    runPiMemoryStage1Extraction(
      {
        model: args.prepared.credential.model,
        evidence: args.prepared.evidence,
        requestId,
        beforeRequest: async (requestSignal) => {
          const admission = await checkOrgCreditsForRunAdmission({
            db: args.db,
            ...args.prepared.credential.billing,
            modelProviderType: args.prepared.credential.modelProviderType,
            selectedModel: PI_MEMORY_STAGE1_MODEL,
          });
          requestSignal.throwIfAborted();
          if (admission) {
            throw new RetryableWorkError("source_admission_denied");
          }
          await checkPiMemoryQuota(
            args.db,
            {
              ...args.prepared.credential.billing,
              stage: "stage1",
              source: args.prepared.credential.quota,
            },
            requestSignal,
          );
          await args.prepared.credential.validate(requestSignal);
          await validatePreparedWork(
            args.db,
            args.prepared.work,
            requestSignal,
          );
          requestPrepared = true;
        },
      },
      signal,
    ),
  );
  const observedResult = provider.ok
    ? provider.value
    : provider.error instanceof PiMemoryStage1ProviderError
      ? provider.error.result
      : undefined;
  if (observedResult) {
    const recordedUsage = await recordObservedUsage(
      args.db,
      args.prepared,
      observedResult,
      requestId,
      args.pricingResolution,
    );
    if (!recordedUsage.ok) {
      return await failWork(
        args.db,
        args.prepared.work,
        new RetryableWorkError(
          recordedUsage.error instanceof Error &&
            recordedUsage.error.message ===
              "Pi memory Stage 1 usage identity collision"
            ? "usage_identity_collision"
            : "usage_persistence_failure",
        ),
        startedAt,
      );
    }
  } else if (requestPrepared) {
    await observePiMemoryStage1MissingUsage(
      args.prepared.credential.billing.mode,
    );
  }
  if (!provider.ok) {
    if (provider.error instanceof StaleWorkError) {
      logOutcome({
        work: args.prepared.work,
        outcome: "stale_discarded",
        durationMs: performance.now() - startedAt,
        errorClass: "stale_selection",
      });
      return { kind: "stale_discarded" };
    }
    return await failWork(
      args.db,
      args.prepared.work,
      classifyProviderFailure(provider.error),
      startedAt,
    );
  }
  const providerResult = provider.value;

  const parsed = safeSync(() => {
    return parseProviderOutput(providerResult.responseText);
  });
  if (!("ok" in parsed)) {
    return await failWork(args.db, args.prepared.work, parsed.error, startedAt);
  }
  const result = parsed.ok;
  const committed = await settleIncludingAbort(
    commitWorkResult(args.db, args.prepared.work, result),
  );
  if (!committed.ok || !committed.value) {
    logOutcome({
      work: args.prepared.work,
      outcome: "stale_discarded",
      durationMs: performance.now() - startedAt,
      inputTokens: providerResult.usage.input,
      outputTokens: providerResult.usage.output,
      errorClass: committed.ok ? undefined : "commit_failed",
    });
    return { kind: "stale_discarded" };
  }
  logOutcome({
    work: args.prepared.work,
    outcome: result.kind,
    durationMs: performance.now() - startedAt,
    inputTokens: providerResult.usage.input,
    outputTokens: providerResult.usage.output,
  });
  return { kind: result.kind };
}

function countOutcomes(
  base: Omit<PiMemoryStage1WorkerResult, "claimed">,
  outcomes: readonly WorkOutcome[],
  claimed: number,
): PiMemoryStage1WorkerResult {
  const result = { ...base, claimed };
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case "succeeded": {
        result.succeeded += 1;
        break;
      }
      case "succeeded_no_output": {
        result.succeededNoOutput += 1;
        break;
      }
      case "retryable_failure": {
        result.retryableFailure += 1;
        break;
      }
      case "terminal_failure": {
        result.terminalFailure += 1;
        break;
      }
      case "stale_discarded": {
        result.staleDiscarded += 1;
        break;
      }
    }
  }
  return result;
}

function logBatchResult(
  result: PiMemoryStage1WorkerResult,
  startedAt: number,
): PiMemoryStage1WorkerResult {
  log.debug("Pi memory Stage 1 batch processed", {
    ...result,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  });
  return result;
}

export const executePiMemoryStage1Work$ = command(
  async (
    { get, set },
    input: PiMemoryStage1WorkerInput,
    signal: AbortSignal,
  ): Promise<PiMemoryStage1WorkerResult> => {
    const startedAt = performance.now();
    const db = set(writeDb$);
    const claim = await claimPiMemoryStage1Work(db, input);
    if (signal.aborted) {
      await retryOwnedWorkAfterAbort(db, new Set(claim.claimed), signal.reason);
      signal.throwIfAborted();
    }
    const owned = new Set(claim.claimed);
    const base = {
      scanned: claim.scanned,
      succeeded: 0,
      succeededNoOutput: 0,
      retryableFailure: 0,
      terminalFailure: claim.terminalFailure,
      sourceExpired: claim.sourceExpired,
      sourceActive: claim.sourceActive,
      staleDiscarded: claim.staleDiscarded,
    };
    if (claim.claimed.length === 0) {
      return logBatchResult({ ...base, claimed: 0 }, startedAt);
    }

    // Switch-off work settles terminal before any provider route, download,
    // or provider call, so it consumes no attempt and is never re-leased.
    const gated = await settleIncludingAbort(
      partitionWorkByPiMemorySwitch(db, claim.claimed, signal),
    );
    if (signal.aborted) {
      await retryOwnedWorkAfterAbort(db, owned, signal.reason);
      signal.throwIfAborted();
    }
    if (!gated.ok) {
      const outcomes = await Promise.all(
        claim.claimed.map(async (work) => {
          return await failWork(db, work, gated.error, performance.now());
        }),
      );
      signal.throwIfAborted();
      owned.clear();
      return logBatchResult(
        countOutcomes(base, outcomes, claim.claimed.length),
        startedAt,
      );
    }
    const outcomes: WorkOutcome[] = [];
    for (const work of gated.value.disabled) {
      outcomes.push(
        await failWork(db, work, new DisabledWorkError(), performance.now()),
      );
      owned.delete(work);
    }
    const enabledWork = gated.value.enabled;
    if (enabledWork.length === 0) {
      return logBatchResult(
        countOutcomes(base, outcomes, claim.claimed.length),
        startedAt,
      );
    }

    const prepared: RoutedWork[] = [];
    // Deliberately serial: at most one encoded + decoded 128 MiB history is
    // resident. Provider concurrency is independent and begins only after raw
    // buffers have fallen out of scope.
    for (const work of enabledWork) {
      const workStartedAt = performance.now();
      const loaded = await settleIncludingAbort(
        set(prepareSourceWork$, { work }, signal),
      );
      if (signal.aborted) {
        await retryOwnedWorkAfterAbort(db, owned, signal.reason);
        signal.throwIfAborted();
      }
      if (loaded.ok) {
        prepared.push(loaded.value);
      } else {
        outcomes.push(await failWork(db, work, loaded.error, workStartedAt));
        owned.delete(work);
      }
    }

    const providerOutcomes = await Promise.all(
      prepared
        .slice(0, PI_MEMORY_STAGE1_PROVIDER_CONCURRENCY)
        .map(async (item) => {
          return await processPreparedWork(
            {
              db,
              prepared: item,
              pricingResolution: get(usagePricingResolution$),
            },
            signal,
          );
        }),
    );
    signal.throwIfAborted();
    outcomes.push(...providerOutcomes);
    return logBatchResult(
      countOutcomes(base, outcomes, claim.claimed.length),
      startedAt,
    );
  },
);
