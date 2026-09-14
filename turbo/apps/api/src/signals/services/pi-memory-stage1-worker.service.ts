import { createHash, randomUUID } from "node:crypto";

import {
  RESUME_SESSION_HISTORY_MAX_BYTES,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
} from "@okouai/api-contracts/contracts/runners";
import { getModelProviderPiEndpoint } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import { getOpenRouterBaseUrl } from "@okouai/api-contracts/contracts/openrouter-routing";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";
import {
  PiMemoryStage1ProviderError,
  projectPiMemoryStage1History,
  redactPiMemoryStage1Secrets,
  resolvePiMemoryStage1ContextWindow,
  runPiMemoryStage1Extraction,
  truncatePiMemoryStage1History,
  type PiMemoryStage1ProviderResult,
} from "@okouai/pi-agent-runtime/api";
import { command } from "ccstate";
import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
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
import { resolveBuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
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

const PI_MEMORY_STAGE1_MODEL = "gpt-5.6-terra";
const PI_MEMORY_STAGE1_SCAN_LIMIT = 5000;
const PI_MEMORY_STAGE1_CLAIM_LIMIT = 8;
const PI_MEMORY_STAGE1_PROVIDER_CONCURRENCY = 8;
const PI_MEMORY_STAGE1_LEASE_MS = 60 * 60 * 1000;
const PI_MEMORY_STAGE1_MAX_SOURCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PI_MEMORY_STAGE1_MAX_ATTEMPTS = 5;
const PI_MEMORY_STAGE1_MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const PI_MEMORY_STAGE1_FALLBACK_TOKEN_LIMIT = 150_000;
const PI_MEMORY_STAGE1_PROJECTED_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

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
}

interface ClaimResult {
  readonly scanned: number;
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
  readonly projectedHistory: string;
  readonly inputTokens: number;
}

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

async function sourceSessionIsActive(
  db: Db,
  source: Pick<ClaimedPiMemoryStage1Work, "orgId" | "piSessionId" | "userId">,
): Promise<boolean> {
  const [active] = await db
    .select({ runId: agentRuns.id })
    .from(conversations)
    .innerJoin(agentRuns, eq(agentRuns.id, conversations.runId))
    .where(
      and(
        eq(conversations.cliAgentType, "pi"),
        eq(conversations.cliAgentSessionId, source.piSessionId),
        eq(agentRuns.orgId, source.orgId),
        eq(agentRuns.userId, source.userId),
        inArray(agentRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return active !== undefined;
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
    .limit(input.scope?.piSessionId ? 1 : PI_MEMORY_STAGE1_SCAN_LIMIT)
    .for("update", {
      of: piMemoryStage1Candidates,
      skipLocked: true,
    });
}

async function claimPiMemoryStage1Work(
  db: Db,
  input: PiMemoryStage1WorkerInput,
): Promise<ClaimResult> {
  return await db.transaction(async (tx) => {
    const rows = await selectDueCandidateRows(tx, input);

    let sourceActive = 0;
    let sourceExpired = 0;
    let terminalFailure = 0;
    const claimed: ClaimedPiMemoryStage1Work[] = [];
    const oldestAllowed = new Date(
      input.currentTime.getTime() - PI_MEMORY_STAGE1_MAX_SOURCE_AGE_MS,
    );
    for (const row of rows) {
      if (claimed.length >= PI_MEMORY_STAGE1_CLAIM_LIMIT) {
        break;
      }
      if (row.sourceCompletedAt < oldestAllowed) {
        if (
          await markLockedTerminal(tx, row, input.currentTime, "source_expired")
        ) {
          sourceExpired += 1;
          terminalFailure += 1;
        }
        continue;
      }
      const reclaimedFailureCount =
        row.status === "leased" ? row.retryCount + 1 : row.retryCount;
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
        continue;
      }
      if (await sourceSessionIsActive(tx, row)) {
        sourceActive += 1;
        continue;
      }

      const leaseToken = randomUUID();
      const [updated] = await tx
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
            eq(
              piMemoryStage1Candidates.sourceHistoryHash,
              row.sourceHistoryHash,
            ),
          ),
        )
        .returning({
          memoryStorageId: piMemoryStage1Candidates.memoryStorageId,
        });
      if (updated) {
        claimed.push({
          memoryStorageId: row.memoryStorageId,
          piSessionId: row.piSessionId,
          orgId: row.orgId,
          userId: row.userId,
          sourceHistoryHash: row.sourceHistoryHash,
          sourceCompletedAt: row.sourceCompletedAt,
          blobEncoding: row.blobEncoding,
          blobRawSize: row.blobRawSize,
          blobEncodedSize: row.blobEncodedSize,
          leaseToken,
          attemptCount: reclaimedFailureCount + 1,
        });
      }
    }
    return {
      scanned: rows.length,
      sourceActive,
      sourceExpired,
      terminalFailure,
      claimed,
    };
  });
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
      readonly contextWindow: number | null;
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
      return projectPiMemoryStage1History({
        jsonl: decodedJsonl.ok,
        expectedSessionId: args.work.piSessionId,
      });
    });
    if (!("ok" in projection)) {
      throw new PermanentSourceError("source_pi_session_invalid");
    }
    const redacted = redactPiMemoryStage1Secrets(projection.ok);
    const truncated = truncatePiMemoryStage1History({
      projectedHistory: redacted,
      contextWindow: args.contextWindow,
      fallbackTokenLimit: PI_MEMORY_STAGE1_FALLBACK_TOKEN_LIMIT,
      maxBytes: PI_MEMORY_STAGE1_PROJECTED_HISTORY_MAX_BYTES,
    });
    return {
      work: args.work,
      projectedHistory: truncated.content,
      inputTokens: truncated.tokenCount,
    };
  },
);

function retryDelay(attemptCount: number): number {
  return Math.min(
    PI_MEMORY_STAGE1_MAX_RETRY_DELAY_MS,
    1000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 12),
  );
}

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
              committedAt.getTime() + retryDelay(work.attemptCount),
            ),
          }
      : result;
  return await db.transaction(async (tx) => {
    return await commitPiMemoryStage1Candidate(tx, {
      memoryStorageId: work.memoryStorageId,
      orgId: work.orgId,
      userId: work.userId,
      piSessionId: work.piSessionId,
      sourceHistoryHash: work.sourceHistoryHash,
      leaseToken: work.leaseToken,
      committedAt,
      result: candidateResult,
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
    outcome: args.outcome,
    durationMs: Math.max(0, Math.round(args.durationMs)),
    inputTokens: args.inputTokens ?? 0,
    outputTokens: args.outputTokens ?? 0,
    ...(args.errorClass ? { errorClass: args.errorClass } : {}),
  });
}

async function failWork(
  db: Db,
  work: ClaimedPiMemoryStage1Work,
  error: unknown,
  startedAt: number,
): Promise<WorkOutcome> {
  const permanent = error instanceof PermanentSourceError;
  const errorClass =
    error instanceof PermanentSourceError || error instanceof RetryableWorkError
      ? error.errorClass
      : error instanceof DOMException && error.name === "AbortError"
        ? "abort"
        : "worker_failure";
  const committedResult = await settleIncludingAbort(
    commitWorkResult(
      db,
      work,
      permanent
        ? { kind: "terminal_failure", errorClass }
        : { kind: "retryable_failure", errorClass },
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

function providerConfig(args: {
  readonly route: NonNullable<
    Awaited<ReturnType<typeof resolveBuiltInModelRuntimeRoute>>
  >;
  readonly apiKey: string;
}) {
  const endpoint = getModelProviderPiEndpoint(
    args.route.providerType,
    "openai-responses",
  );
  const provider =
    args.route.providerType === "openai-api-key"
      ? "openai"
      : args.route.providerType === "openrouter-codex"
        ? "openrouter"
        : null;
  if (!endpoint || provider === null) {
    throw new RetryableWorkError("model_route_unavailable");
  }
  return {
    provider,
    baseUrl: endpoint.baseUrl,
    apiKey: args.apiKey,
    model: args.route.upstreamModel,
    dialect: "openai-responses" as const,
    transport: "sse" as const,
    thinkingLevel: "max" as const,
  };
}

async function resolveStage1ProviderConfig(
  db: Db,
  signal: AbortSignal,
): Promise<ReturnType<typeof providerConfig>> {
  const route = await resolveBuiltInModelRuntimeRoute(
    db,
    PI_MEMORY_STAGE1_MODEL,
  );
  signal.throwIfAborted();
  if (!route) {
    throw new RetryableWorkError("model_route_unavailable");
  }
  const [key] = await db
    .select({ apiKey: builtInModelKeys.apiKey })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.id, route.modelKeyId))
    .limit(1);
  signal.throwIfAborted();
  if (!key) {
    throw new RetryableWorkError("model_route_unavailable");
  }
  return providerConfig({ route, apiKey: key.apiKey });
}

async function extractPreparedWork(
  args: {
    readonly db: Db;
    readonly prepared: PreparedWork;
    readonly model: ReturnType<typeof providerConfig>;
  },
  requestId: string,
  signal: AbortSignal,
): Promise<PiMemoryStage1ProviderResult> {
  let model = args.model;
  if (model.provider === "openrouter") {
    const { orgId, userId } = args.prepared.work;
    const context = await loadUserFeatureSwitchContext(args.db, orgId, userId);
    signal.throwIfAborted();
    model = {
      ...model,
      baseUrl: getOpenRouterBaseUrl("responses", {
        credentialOwner: "builtin",
        model: model.model,
        usRoutingEnabled: isFeatureEnabled(
          FeatureSwitchKey.OpenRouterUsRouting,
          context,
        ),
      }),
    };
  }
  return await runPiMemoryStage1Extraction(
    { model, projectedHistory: args.prepared.projectedHistory, requestId },
    signal,
  );
}

async function processPreparedWork(
  args: {
    readonly db: Db;
    readonly prepared: PreparedWork;
    readonly model: ReturnType<typeof providerConfig>;
  },
  signal: AbortSignal,
): Promise<WorkOutcome> {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const provider = await settleIncludingAbort(
    extractPreparedWork(args, requestId, signal),
  );
  if (!provider.ok) {
    return await failWork(
      args.db,
      args.prepared.work,
      provider.error instanceof PiMemoryStage1ProviderError
        ? new RetryableWorkError("provider_failure")
        : provider.error,
      startedAt,
    );
  }
  const providerResult: PiMemoryStage1ProviderResult = provider.value;

  const recordedUsage = await settleIncludingAbort(
    recordPiMemoryStage1Usage(args.db, {
      memoryStorageId: args.prepared.work.memoryStorageId,
      piSessionId: args.prepared.work.piSessionId,
      sourceHistoryHash: args.prepared.work.sourceHistoryHash,
      orgId: args.prepared.work.orgId,
      userId: args.prepared.work.userId,
      responseSourceId: providerResult.responseId ?? `request:${requestId}`,
      usage: providerResult.usage,
    }),
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
    { set },
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
      staleDiscarded: 0,
    };
    if (claim.claimed.length === 0) {
      return logBatchResult({ ...base, claimed: 0 }, startedAt);
    }

    const resolvedModel = await settleIncludingAbort(
      resolveStage1ProviderConfig(db, signal),
    );
    if (signal.aborted) {
      await retryOwnedWorkAfterAbort(db, owned, signal.reason);
      signal.throwIfAborted();
    }
    if (!resolvedModel.ok) {
      const outcomes = await Promise.all(
        claim.claimed.map(async (work) => {
          return await failWork(
            db,
            work,
            resolvedModel.error,
            performance.now(),
          );
        }),
      );
      signal.throwIfAborted();
      owned.clear();
      return logBatchResult(
        countOutcomes(base, outcomes, claim.claimed.length),
        startedAt,
      );
    }
    const model = resolvedModel.value;

    const contextWindow = resolvePiMemoryStage1ContextWindow(model);
    const prepared: PreparedWork[] = [];
    const outcomes: WorkOutcome[] = [];
    // Deliberately serial: at most one encoded + decoded 128 MiB history is
    // resident. Provider concurrency is independent and begins only after raw
    // buffers have fallen out of scope.
    for (const work of claim.claimed) {
      const workStartedAt = performance.now();
      const loaded = await settleIncludingAbort(
        set(loadAndProjectHistory$, { work, contextWindow }, signal),
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
              model,
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
