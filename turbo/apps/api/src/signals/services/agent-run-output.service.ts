import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { z } from "zod";
import {
  runStatusSchema,
  type RunStatus,
  type RunResult,
  runResultSchema,
} from "@okouai/api-contracts/contracts/runs";
import { RESUME_SESSION_HISTORY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import {
  runCompletionMetadataSchema,
  webhookSessionHistoryPrepareContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  inspectPiSessionJsonl,
  UnsupportedPiSessionVersionError,
} from "@okouai/pi-agent-runtime/api";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { piMemoryPhase2MaintenanceCallbackPayloadSchema } from "./pi-memory-phase2-maintenance.service";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import {
  maintenancePublicationResultCondition,
  maintenancePublicationResultVersion,
  maintenancePublicationVersion,
} from "./pi-memory-phase2-result";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import type { PersistedStorageMount } from "@okouai/db/types";
import { command, computed } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
import type { SandboxAuth } from "../../types/auth";
import { db$, writeDb$, type Db } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  generatePresignedPutUrl,
  s3ObjectExists,
} from "../external/s3";
import {
  gunzipSessionHistoryBufferWithMaxBytes,
  unzstdSessionHistoryBufferWithMaxBytes,
} from "./session-history-decompression";
import {
  normalizeSessionHistoryBlobEncoding,
  resumeSessionHistoryBlobKey,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "./session-history-blobs";
import { safeSync, settle } from "../utils";
import { projectRunStorage } from "./storage-legacy-projection.service";

export type AgentRunOutputBody = z.infer<typeof runCompletionMetadataSchema> & {
  readonly runId: string;
};
type PrepareHistoryBody = z.infer<
  typeof webhookSessionHistoryPrepareContract.prepare.body
>;

export interface AgentRunOutputInput {
  readonly auth: SandboxAuth;
  readonly body: AgentRunOutputBody;
}

interface RunOutputAuthInput<TBody> {
  readonly auth: SandboxAuth;
  readonly body: TBody;
}

export interface PreparedAgentRunOutput {
  readonly piValidation?: {
    readonly chatThreadId: string | null;
    readonly runSessionId: string;
  };
}

export type AgentRunOutputErrorResponse =
  ReturnType<typeof badRequestMessage> | ReturnType<typeof notFound>;

type AgentRunOutputPreparation =
  | { readonly ok: true; readonly prepared: PreparedAgentRunOutput }
  | {
      readonly ok: false;
      readonly response: AgentRunOutputErrorResponse;
    };

interface RunOutputContext {
  readonly agentSessionConversationId: string | null;
  readonly chatThreadId: string | null;
  readonly launchSnapshot: typeof agentRuns.$inferSelect.launchSnapshot;
  readonly status: RunStatus;
  readonly storageMounts: typeof agentRuns.$inferSelect.storageMounts;
  readonly sessionId: string;
  readonly existingOutput: ExistingRunOutput | undefined;
}

interface SessionHistoryBlobMetadata {
  readonly rawSize: number;
  readonly encoding: string;
  readonly encodedSize: number;
}

interface PreparedSessionHistoryBlob {
  readonly blob: SessionHistoryBlobMetadata;
  readonly insertedNewBlob: boolean;
}

type SessionHistoryBlobReadDb = Pick<Db, "select">;

const L = logger("webhooks:agent:session-history");

class PiHistoryValidationError extends Error {}

function piHistoryError(code: string, message: string): never {
  throw new PiHistoryValidationError(`[${code}] ${message}`);
}

function resolvedOutputMounts(args: {
  readonly runStorageMounts: readonly PersistedStorageMount[] | null;
  readonly artifactSnapshots: AgentRunOutputBody["artifactSnapshots"];
}): PersistedStorageMount[] {
  if (args.runStorageMounts === null) {
    throw new Error("Agent run is missing canonical Storage mounts");
  }
  const snapshotsByIdentity = new Map(
    (args.artifactSnapshots ?? []).map((snapshot) => {
      return [
        JSON.stringify([snapshot.name, snapshot.mountPath]),
        snapshot,
      ] as const;
    }),
  );
  return args.runStorageMounts.map((mount) => {
    if (!mount.writeback) {
      return mount;
    }
    const snapshot = snapshotsByIdentity.get(
      JSON.stringify([mount.name, mount.mountPath]),
    );
    if (!snapshot) {
      return mount;
    }
    const {
      version: _runVersion,
      missingRootPolicy: _runMissingRootPolicy,
      ...mountBase
    } = mount;
    const missingRootPolicy =
      snapshot.missingRootPolicy ?? mount.missingRootPolicy;
    return {
      ...mountBase,
      version: snapshot.version,
      ...(missingRootPolicy === undefined ? {} : { missingRootPolicy }),
    };
  });
}

function createInitialRunOutputContext(runId: string, userId: string) {
  return computed(async (get): Promise<RunOutputContext | undefined> => {
    const db = get(db$);
    const [run] = await db
      .select({
        agentSessionConversationId: agentSessions.conversationId,
        chatThreadId: agentRuns.chatThreadId,
        launchSnapshot: agentRuns.launchSnapshot,
        status: agentRuns.status,
        storageMounts: agentRuns.storageMounts,
        sessionId: agentRuns.sessionId,
        result: agentRuns.result,
        conversation: {
          conversationId: conversations.id,
          historyHash: conversations.cliAgentSessionHistoryHash,
          sessionId: conversations.cliAgentSessionId,
          type: conversations.cliAgentType,
        },
      })
      .from(agentRuns)
      .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
      .leftJoin(conversations, eq(conversations.runId, agentRuns.id))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return undefined;
    }
    const { conversation, result, ...context } = run;
    return {
      ...context,
      status: runStatusSchema.parse(run.status),
      existingOutput:
        conversation &&
        run.status === "completed" &&
        run.chatThreadId === null &&
        run.launchSnapshot?.framework === "pi"
          ? parseExistingRunOutput({ ...conversation, result })
          : undefined,
    };
  });
}

async function lockRunOutputContext(
  tx: Tx,
  input: AgentRunOutputInput,
): Promise<RunOutputContext | undefined> {
  const [run] = await tx
    .select({
      agentSessionConversationId: agentSessions.conversationId,
      chatThreadId: agentRuns.chatThreadId,
      launchSnapshot: agentRuns.launchSnapshot,
      status: agentRuns.status,
      storageMounts: agentRuns.storageMounts,
      sessionId: agentRuns.sessionId,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(
      and(
        eq(agentRuns.id, input.body.runId),
        eq(agentRuns.userId, input.auth.userId),
      ),
    )
    .for("update", { of: agentRuns })
    .limit(1);

  if (!run) {
    return undefined;
  }
  return {
    ...run,
    status: runStatusSchema.parse(run.status),
    existingOutput: undefined,
  };
}

async function decodePiHistory(args: {
  readonly rawSize: number;
  readonly encoded: Buffer;
  readonly encoding: string;
  readonly key: string;
}): Promise<Buffer> {
  switch (args.encoding) {
    case SESSION_HISTORY_ENCODING_IDENTITY: {
      return args.encoded;
    }
    case SESSION_HISTORY_ENCODING_GZIP: {
      return await gunzipSessionHistoryBufferWithMaxBytes(
        args.key,
        args.encoded,
        args.rawSize,
      );
    }
    case SESSION_HISTORY_ENCODING_ZSTD: {
      return await unzstdSessionHistoryBufferWithMaxBytes(
        args.key,
        args.encoded,
        args.rawSize,
      );
    }
    default: {
      return piHistoryError(
        "PI_H2_METADATA_INVALID",
        "Pi H2 uses an unsupported history encoding",
      );
    }
  }
}

interface PiHistoryValidationArgs {
  readonly db: Db;
  readonly run: RunOutputContext;
  readonly historyHash: string | undefined;
  readonly sessionId: string | undefined;
}

function validatePiHistoryIdentity(args: PiHistoryValidationArgs): {
  readonly historyHash: string;
  readonly sessionId: string;
} {
  if (!args.historyHash) {
    return piHistoryError(
      "PI_H2_HISTORY_REQUIRED",
      "Pi H2 requires a native session history hash",
    );
  }
  if (
    !args.run.chatThreadId ||
    !args.sessionId ||
    args.sessionId !== args.run.chatThreadId
  ) {
    return piHistoryError(
      "PI_H2_SESSION_MISMATCH",
      "Pi H2 session id does not match the Chat Thread",
    );
  }
  return { historyHash: args.historyHash, sessionId: args.sessionId };
}

function validatePiHistoryMetadata(
  metadata: SessionHistoryBlobMetadata | undefined,
): ReturnType<typeof normalizeSessionHistoryBlobEncoding> {
  if (!metadata || metadata.rawSize <= 0 || metadata.encodedSize <= 0) {
    return piHistoryError(
      "PI_H2_METADATA_INVALID",
      "Pi H2 blob metadata is unavailable or invalid",
    );
  }
  if (
    metadata.rawSize > RESUME_SESSION_HISTORY_MAX_BYTES ||
    metadata.encodedSize > RESUME_SESSION_HISTORY_MAX_BYTES
  ) {
    return piHistoryError(
      "PI_H2_TOO_LARGE",
      "Pi H2 exceeds the native session size limit",
    );
  }
  const normalized = safeSync(() => {
    return normalizeSessionHistoryBlobEncoding(metadata.encoding);
  });
  if ("error" in normalized) {
    return piHistoryError(
      "PI_H2_METADATA_INVALID",
      "Pi H2 uses an unsupported history encoding",
    );
  }
  return normalized.ok;
}

const downloadAndDecodePiHistory$ = command(
  async function downloadAndDecodePiHistory(
    { get },
    args: {
      readonly historyHash: string;
      readonly metadata: SessionHistoryBlobMetadata;
    },
    signal: AbortSignal,
  ): Promise<Buffer> {
    const encoding = validatePiHistoryMetadata(args.metadata);
    const key = resumeSessionHistoryBlobKey(args.historyHash, encoding);
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          key,
          args.metadata.encodedSize,
          signal,
        ),
      ),
      signal,
    );
    if (!downloaded.ok) {
      return piHistoryError(
        "PI_H2_DOWNLOAD_FAILED",
        "Pi H2 could not be downloaded",
      );
    }
    const encoded = downloaded.value;
    if (encoded.length !== args.metadata.encodedSize) {
      return piHistoryError(
        "PI_H2_HASH_MISMATCH",
        "Pi H2 encoded size does not match its metadata",
      );
    }
    const decoded = await settle(
      decodePiHistory({
        encoded,
        encoding,
        key,
        rawSize: args.metadata.rawSize,
      }),
      signal,
    );
    if (!decoded.ok) {
      if (decoded.error instanceof PiHistoryValidationError) {
        throw decoded.error;
      }
      return piHistoryError(
        "PI_H2_DECOMPRESSION_FAILED",
        "Pi H2 could not be decompressed",
      );
    }
    return decoded.value;
  },
);

function validatePiHistorySession(
  raw: Buffer,
  historyHash: string,
  sessionId: string,
  metadata: SessionHistoryBlobMetadata,
): void {
  if (
    raw.length !== metadata.rawSize ||
    createHash("sha256").update(raw).digest("hex") !== historyHash
  ) {
    return piHistoryError(
      "PI_H2_HASH_MISMATCH",
      "Pi H2 failed its raw size or hash check",
    );
  }
  const parsed = safeSync(() => {
    const jsonl = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return inspectPiSessionJsonl(jsonl);
  });
  if ("error" in parsed) {
    return piHistoryError(
      parsed.error instanceof UnsupportedPiSessionVersionError
        ? "PI_H2_SESSION_UNSUPPORTED"
        : "PI_H2_JSONL_INVALID",
      parsed.error instanceof UnsupportedPiSessionVersionError
        ? "Pi H2 uses an unsupported native session version"
        : "Pi H2 is not a valid native Pi session",
    );
  }
  const session = parsed.ok;
  if (session.sessionId !== sessionId) {
    return piHistoryError(
      "PI_H2_SESSION_MISMATCH",
      "Pi H2 native session id does not match the launch session",
    );
  }
  if (!session.isSettledHistory) {
    return piHistoryError(
      "PI_H2_NOT_SETTLED",
      "Pi H2 is not a settled native session history",
    );
  }
}

const validatePiHistory$ = command(async function validatePiHistory(
  { set },
  args: PiHistoryValidationArgs,
  signal: AbortSignal,
): Promise<void> {
  const identity = validatePiHistoryIdentity(args);
  const metadata = await loadSessionHistoryBlobMetadata(
    args.db,
    identity.historyHash,
  );
  signal.throwIfAborted();
  if (!metadata) {
    return piHistoryError(
      "PI_H2_METADATA_INVALID",
      "Pi H2 blob metadata is unavailable or invalid",
    );
  }
  const raw = await set(
    downloadAndDecodePiHistory$,
    {
      historyHash: identity.historyHash,
      metadata,
    },
    signal,
  );
  validatePiHistorySession(
    raw,
    identity.historyHash,
    identity.sessionId,
    metadata,
  );
});

async function loadSessionHistoryBlobMetadata(
  db: SessionHistoryBlobReadDb,
  hash: string,
): Promise<SessionHistoryBlobMetadata | undefined> {
  const [blob] = await db
    .select({
      rawSize: blobs.rawSize,
      encoding: blobs.encoding,
      encodedSize: blobs.encodedSize,
    })
    .from(blobs)
    .where(eq(blobs.hash, hash))
    .limit(1);
  return blob;
}

const ensureSessionHistoryBlobMetadata$ = command(
  async (
    { set },
    args: {
      readonly input: RunOutputAuthInput<PrepareHistoryBody>;
      readonly requestedEncoding: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { input, requestedEncoding } = args;
    const { body, auth } = input;
    const run = db.$with("history_upload_run").as(
      db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(
          and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, auth.userId)),
        )
        .limit(1),
    );
    const inserted = db.$with("history_upload_blob").as(
      db
        .insert(blobs)
        .select(
          db
            .select({
              hash: sql`${body.hash}`.mapWith(blobs.hash).as("hash"),
              rawSize: sql`${body.rawSize}`
                .mapWith(blobs.rawSize)
                .as("raw_size"),
              encoding: sql`${requestedEncoding}`
                .mapWith(blobs.encoding)
                .as("encoding"),
              encodedSize: sql`${body.encodedSize}`
                .mapWith(blobs.encodedSize)
                .as("encoded_size"),
              refCount: sql`0`.mapWith(blobs.refCount).as("ref_count"),
              createdAt: sql`now()`.mapWith(blobs.createdAt).as("created_at"),
            })
            .from(run)
            .where(
              inArray(
                run.status,
                runStatusSchema.options.filter((status) => {
                  return status !== "timeout";
                }),
              ),
            ),
        )
        .onConflictDoNothing()
        .returning({
          rawSize: blobs.rawSize,
          encoding: blobs.encoding,
          encodedSize: blobs.encodedSize,
        }),
    );
    // Admission and the first metadata write share one statement snapshot.
    const [admission] = await db
      .with(run, inserted)
      .select({
        status: run.status,
        blob: {
          rawSize: inserted.rawSize,
          encoding: inserted.encoding,
          encodedSize: inserted.encodedSize,
        },
      })
      .from(run)
      .leftJoin(inserted, sql`true`);
    signal.throwIfAborted();
    if (!admission) {
      return { kind: "not-found" } as const;
    }
    const status = runStatusSchema.parse(admission.status);
    if (status === "timeout") {
      return { kind: "timeout", status } as const;
    }
    const insertedNewBlob = admission.blob !== null;
    let blob = admission.blob ?? undefined;
    if (!blob) {
      // A competing insert can be invisible to the admission statement's snapshot.
      [blob] = await db
        .select({
          rawSize: blobs.rawSize,
          encoding: blobs.encoding,
          encodedSize: blobs.encodedSize,
        })
        .from(blobs)
        .where(eq(blobs.hash, body.hash))
        .limit(1);
      signal.throwIfAborted();
    }
    if (!blob) {
      throw new Error("failed to load session history blob metadata");
    }
    if (blob.rawSize === 0) {
      const [updatedBlob] = await db
        .update(blobs)
        .set({
          rawSize: body.rawSize,
          encoding: requestedEncoding,
          encodedSize: body.encodedSize,
        })
        .where(and(eq(blobs.hash, body.hash), eq(blobs.rawSize, 0)))
        .returning({
          rawSize: blobs.rawSize,
          encoding: blobs.encoding,
          encodedSize: blobs.encodedSize,
        });
      signal.throwIfAborted();
      blob = updatedBlob;
      if (!blob) {
        [blob] = await db
          .select({
            rawSize: blobs.rawSize,
            encoding: blobs.encoding,
            encodedSize: blobs.encodedSize,
          })
          .from(blobs)
          .where(eq(blobs.hash, body.hash))
          .limit(1);
        signal.throwIfAborted();
      }
      if (!blob) {
        throw new Error("failed to load session history blob metadata");
      }
    }
    const prepared: PreparedSessionHistoryBlob = { blob, insertedNewBlob };
    return { kind: "admitted", prepared } as const;
  },
);

export const prepareSessionHistoryUpload$ = command(
  async (
    { get, set },
    input: RunOutputAuthInput<PrepareHistoryBody>,
    signal: AbortSignal,
  ) => {
    const requestedEncoding =
      input.body.encoding ?? SESSION_HISTORY_ENCODING_IDENTITY;
    if (
      requestedEncoding === SESSION_HISTORY_ENCODING_IDENTITY &&
      input.body.encodedSize !== input.body.rawSize
    ) {
      return badRequestMessage(
        "Identity session history encodedSize must match rawSize",
      );
    }

    const admission = await set(
      ensureSessionHistoryBlobMetadata$,
      { input, requestedEncoding },
      signal,
    );
    signal.throwIfAborted();

    if (admission.kind === "not-found") {
      return notFound("Agent run not found");
    }
    if (admission.kind === "timeout") {
      return badRequestMessage(runOutputStateError(admission.status));
    }
    const { blob, insertedNewBlob } = admission.prepared;

    if (blob.rawSize !== input.body.rawSize) {
      return badRequestMessage(
        "Session history raw size does not match the existing blob",
      );
    }

    const encoding = normalizeSessionHistoryBlobEncoding(blob.encoding);
    if (
      requestedEncoding === SESSION_HISTORY_ENCODING_IDENTITY &&
      encoding !== SESSION_HISTORY_ENCODING_IDENTITY
    ) {
      return badRequestMessage(
        "Identity session history upload cannot repair a compressed blob",
      );
    }
    const s3Key = resumeSessionHistoryBlobKey(input.body.hash, encoding);
    const bucketName = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!insertedNewBlob) {
      const exists = await get(s3ObjectExists(bucketName, s3Key));
      signal.throwIfAborted();

      if (exists) {
        return {
          status: 200 as const,
          body: { existing: true, encoding },
        };
      }
    }
    if (
      encoding !== SESSION_HISTORY_ENCODING_IDENTITY &&
      requestedEncoding !== encoding
    ) {
      return badRequestMessage(
        "Compressed session history upload encoding must match the existing blob",
      );
    }
    if (
      requestedEncoding === encoding &&
      blob.encodedSize !== input.body.encodedSize
    ) {
      return badRequestMessage(
        "Session history encoded size does not match the existing blob",
      );
    }

    const presignedUrl = await get(
      generatePresignedPutUrl(
        bucketName,
        s3Key,
        "application/octet-stream",
        { usePublicEndpoint: true },
        signal,
      ),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        presignedUrl,
        existing: false,
        encoding,
      },
    };
  },
);

const validatePiH2$ = command(async function validatePiH2(
  { set },
  db: Db,
  run: RunOutputContext,
  body: AgentRunOutputBody,
  signal: AbortSignal,
): Promise<string | null> {
  if (body.cliAgentType !== "pi") {
    return null;
  }
  const validated = await settle(
    set(
      validatePiHistory$,
      {
        db,
        run,
        historyHash: body.cliAgentSessionHistoryHash,
        sessionId: body.cliAgentSessionId,
      },
      signal,
    ),
    signal,
  );
  if (!validated.ok) {
    if (validated.error instanceof PiHistoryValidationError) {
      return validated.error.message;
    }
    throw validated.error;
  }
  return null;
});

function runOutputSuccessResponse(result: RunResult) {
  return { status: 200 as const, result };
}

type AgentRunOutputSuccessResponse = ReturnType<
  typeof runOutputSuccessResponse
>;

type AgentRunOutputResponse =
  AgentRunOutputSuccessResponse | AgentRunOutputErrorResponse;

function isActivePiHistoryStatus(status: RunStatus): boolean {
  return status === "pending" || status === "running";
}

function isPiHistoryRun(run: RunOutputContext): boolean {
  return run.launchSnapshot?.framework === "pi";
}

function piHistoryTypeError(
  run: RunOutputContext,
  body: AgentRunOutputBody,
): string | null {
  if (isPiHistoryRun(run) === (body.cliAgentType === "pi")) {
    return null;
  }
  return "[PI_H2_TYPE_MISMATCH] Native session type does not match the run launch framework";
}

function piHistoryRunStateError(status: RunStatus): string {
  const code =
    status === "queued" ? "PI_H2_RUN_NOT_ACTIVE" : "PI_H2_RUN_TERMINAL";
  return `[${code}] Pi H2 cannot become canonical while the run status is ${status}`;
}

function runOutputStateError(status: RunStatus): string {
  return `[RUN_HISTORY_TERMINAL] Native history cannot become canonical while the run status is ${status}`;
}

interface ExistingRunOutput {
  readonly conversationId: string;
  readonly historyHash: string | null;
  readonly sessionId: string | null;
  readonly result?: RunResult;
  readonly type: string | null;
}

function parseExistingRunOutput(
  existing:
    | (Omit<ExistingRunOutput, "result"> & {
        readonly result: typeof agentRuns.$inferSelect.result;
      })
    | undefined,
): ExistingRunOutput | undefined {
  if (!existing) {
    return undefined;
  }
  const parsed =
    existing.result === null
      ? undefined
      : runResultSchema.parse(existing.result);
  const result = parsed?.storageOutputs === undefined ? undefined : parsed;
  const { result: _persistedResult, ...identity } = existing;
  return { ...identity, ...(result === undefined ? {} : { result }) };
}

async function loadExistingRunOutput(
  tx: Tx,
  runId: string,
): Promise<ExistingRunOutput | undefined> {
  const [existing] = await tx
    .select({
      conversationId: conversations.id,
      historyHash: conversations.cliAgentSessionHistoryHash,
      sessionId: conversations.cliAgentSessionId,
      result: agentRuns.result,
      type: conversations.cliAgentType,
    })
    .from(conversations)
    .innerJoin(agentRuns, eq(agentRuns.id, conversations.runId))
    .where(eq(conversations.runId, runId))
    .limit(1);
  // Pre-transition terminal callbacks must drain before cutover. Historical
  // results remain readable, but cannot supply absent exact output evidence.
  if (!existing) {
    return undefined;
  }
  return parseExistingRunOutput(existing);
}

function storageOutputs(
  mounts: readonly PersistedStorageMount[],
): NonNullable<RunResult["storageOutputs"]> {
  return [...(projectRunStorage(mounts).artifactSnapshots ?? [])].map(
    (output) => {
      if (output.version === undefined) {
        throw new Error("Published Run output is missing its version");
      }
      return { ...output, version: output.version };
    },
  );
}

function buildRunResult(
  run: RunOutputContext,
  conversationId: string,
  mounts: readonly PersistedStorageMount[],
): RunResult {
  const projection = projectRunStorage(mounts);
  return {
    agentSessionId: run.sessionId,
    conversationId,
    storageOutputs: storageOutputs(mounts),
    ...(projection.artifactVersions
      ? { artifact: projection.artifactVersions }
      : {}),
    ...(projection.volumeVersionsSnapshot
      ? { volumes: projection.volumeVersionsSnapshot.versions }
      : {}),
  };
}

type PiHistoryAdmission =
  | { readonly kind: "write" }
  | {
      readonly kind: "response";
      readonly response: ReturnType<typeof runOutputSuccessResponse>;
    }
  | { readonly kind: "error"; readonly message: string };

async function admitPiHistory(
  tx: Tx,
  run: RunOutputContext,
  body: AgentRunOutputBody,
  storageMounts: readonly PersistedStorageMount[],
): Promise<PiHistoryAdmission> {
  const active = isActivePiHistoryStatus(run.status);
  if (!active && run.status !== "completed") {
    return { kind: "error", message: piHistoryRunStateError(run.status) };
  }

  const existing = await loadExistingRunOutput(tx, body.runId);
  if (!existing) {
    return active
      ? { kind: "write" }
      : { kind: "error", message: piHistoryRunStateError(run.status) };
  }

  if (existing.result === undefined) {
    return {
      kind: "error",
      message:
        "[RUN_OUTPUT_ALREADY_COMMITTED] Historical Run has no exact output evidence",
    };
  }
  const exactRetry =
    existing.type === "pi" &&
    existing.sessionId === body.cliAgentSessionId &&
    existing.historyHash === (body.cliAgentSessionHistoryHash ?? null) &&
    isDeepStrictEqual(
      existing.result.storageOutputs,
      storageOutputs(storageMounts),
    ) &&
    (active || run.agentSessionConversationId === existing.conversationId);
  if (!exactRetry) {
    return {
      kind: "error",
      message:
        "[PI_H2_ALREADY_COMMITTED] Pi H2 does not exactly match the existing Run output",
    };
  }

  return {
    kind: "response",
    response: runOutputSuccessResponse(existing.result),
  };
}

async function persistAgentRunOutput(
  tx: Tx,
  run: RunOutputContext,
  body: AgentRunOutputBody,
  options: {
    storageMounts: PersistedStorageMount[];
    deferSessionPromotion: boolean;
  },
  signal: AbortSignal,
) {
  const { deferSessionPromotion, storageMounts } = options;
  const historyHash = body.cliAgentSessionHistoryHash;
  const [existingConversation] = await tx
    .select({ historyHash: conversations.cliAgentSessionHistoryHash })
    .from(conversations)
    .where(eq(conversations.runId, body.runId))
    .limit(1);
  signal.throwIfAborted();
  const previousHistoryHash = existingConversation?.historyHash ?? null;
  const historyChanged = previousHistoryHash !== (historyHash ?? null);

  if (historyHash !== undefined && historyChanged) {
    await tx
      .insert(blobs)
      .values({
        hash: historyHash,
        rawSize: 0,
        encoding: SESSION_HISTORY_ENCODING_IDENTITY,
        encodedSize: 0,
        refCount: 1,
      })
      .onConflictDoUpdate({
        target: blobs.hash,
        set: { refCount: sql`${blobs.refCount} + 1` },
      });
    signal.throwIfAborted();
  }

  const historyFields =
    historyHash === undefined
      ? {
          cliAgentSessionHistory: null,
          cliAgentSessionHistoryHash: null,
        }
      : { cliAgentSessionHistoryHash: historyHash };

  const [conversation] = await tx
    .insert(conversations)
    .values({
      runId: body.runId,
      cliAgentType: body.cliAgentType,
      cliAgentSessionId: body.cliAgentSessionId,
      ...historyFields,
    })
    .onConflictDoUpdate({
      target: conversations.runId,
      set: {
        cliAgentType: body.cliAgentType,
        cliAgentSessionId: body.cliAgentSessionId,
        ...historyFields,
      },
    })
    .returning({ id: conversations.id });
  signal.throwIfAborted();

  if (!conversation) {
    throw new Error("Failed to upsert conversation record");
  }

  if (previousHistoryHash !== null && historyChanged) {
    await tx
      .update(blobs)
      .set({ refCount: sql`greatest(${blobs.refCount} - 1, 0)` })
      .where(eq(blobs.hash, previousHistoryHash));
    signal.throwIfAborted();
  }

  const result = buildRunResult(run, conversation.id, storageMounts);

  if (!deferSessionPromotion) {
    const [agentSession] = await tx
      .update(agentSessions)
      .set({
        conversationId: conversation.id,
        updatedAt: nowDate(),
      })
      .where(eq(agentSessions.id, run.sessionId))
      .returning({ id: agentSessions.id });
    signal.throwIfAborted();

    if (!agentSession) {
      return notFound("AgentSession not found");
    }
  }

  L.debug("Native history and Run outputs saved", {
    runId: body.runId,
    conversationId: conversation.id,
  });
  return runOutputSuccessResponse(result);
}

async function exactRunOutputRetryResponse(
  tx: Tx,
  run: RunOutputContext,
  body: AgentRunOutputBody,
  storageMounts: readonly PersistedStorageMount[],
  signal: AbortSignal,
): Promise<AgentRunOutputSuccessResponse | undefined> {
  const existing = await loadExistingRunOutput(tx, body.runId);
  signal.throwIfAborted();
  if (existing?.result === undefined) {
    return undefined;
  }
  const exactRetry =
    existing?.type === body.cliAgentType &&
    existing.sessionId === body.cliAgentSessionId &&
    existing.historyHash === (body.cliAgentSessionHistoryHash ?? null) &&
    isDeepStrictEqual(
      existing.result.storageOutputs,
      storageOutputs(storageMounts),
    );
  if (!exactRetry) {
    return undefined;
  }
  return runOutputSuccessResponse(existing.result);
}

function completedMaintenanceOutput(
  binding: {
    readonly memoryStorageId: string;
    readonly claimedBaseVersionId: string;
  },
  run: RunOutputContext,
  body: AgentRunOutputBody,
): { memoryStorageId: string; versionId: string } | string {
  const outputError = runStorageOutputError(
    run.storageMounts,
    body.artifactSnapshots,
  );
  if (outputError) {
    return outputError;
  }
  const existing = run.existingOutput;
  const mount = run.storageMounts?.find((entry) => {
    return entry.storageId === binding.memoryStorageId && entry.writeback;
  });
  const snapshot = body.artifactSnapshots?.find((entry) => {
    return entry.name === mount?.name && entry.mountPath === mount.mountPath;
  });
  const committed = existing?.result?.storageOutputs?.find((entry) => {
    return entry.name === mount?.name && entry.mountPath === mount.mountPath;
  });
  if (
    !mount ||
    !snapshot ||
    !committed ||
    (snapshot.version !== binding.claimedBaseVersionId &&
      snapshot.version !== committed.version) ||
    existing?.result === undefined ||
    existing.type !== body.cliAgentType ||
    existing.sessionId !== body.cliAgentSessionId ||
    existing.historyHash !== null ||
    existing.conversationId !== run.agentSessionConversationId ||
    existing.result.agentSessionId !== run.sessionId ||
    !isDeepStrictEqual(
      existing.result.storageOutputs,
      storageOutputs(
        resolvedOutputMounts({
          runStorageMounts: run.storageMounts,
          artifactSnapshots: body.artifactSnapshots,
        }).map((entry) => {
          // Fresh completion already normalizes the launch base recovery output
          // to the publication result. Retain that same normalization on replay.
          return entry.storageId === binding.memoryStorageId
            ? { ...entry, version: committed.version }
            : entry;
        }),
      ),
    )
  ) {
    return "[RUN_OUTPUT_ALREADY_COMMITTED] Final output does not exactly match the committed Run output";
  }
  return {
    memoryStorageId: binding.memoryStorageId,
    versionId: committed.version,
  };
}

// Private maintenance has no public Pi history. The Job proves fresh publication;
// a completed Run's immutable output proves only that Run's exact replay.
async function privateMaintenanceOutput(
  db: Db | Tx,
  input: AgentRunOutputInput,
  run: RunOutputContext,
): Promise<
  { memoryStorageId: string; versionId: string } | string | undefined
> {
  if (!isPiHistoryRun(run)) {
    return undefined;
  }
  const [callback] = await db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, input.body.runId),
        eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
      ),
    )
    .limit(1);
  if (!callback) {
    return undefined;
  }
  const parsed = piMemoryPhase2MaintenanceCallbackPayloadSchema.safeParse(
    callback.payload,
  );
  if (
    !parsed.success ||
    parsed.data.orgId !== input.auth.orgId ||
    parsed.data.userId !== input.auth.userId ||
    run.chatThreadId !== null ||
    !isPiHistoryRun(run) ||
    input.body.cliAgentSessionId !== input.body.runId ||
    input.body.cliAgentSessionHistoryHash !== undefined ||
    input.body.cliAgentSessionHistoryDisposition !== "unavailable"
  ) {
    return "[PI_MAINTENANCE_IDENTITY_INVALID] Private output identity does not match its launch";
  }
  const binding = parsed.data;
  if (run.status === "completed") {
    return completedMaintenanceOutput(binding, run, input.body);
  }
  const [result] = await db
    .select({ versionId: maintenancePublicationResultVersion() })
    .from(piMemoryPhase2Jobs)
    .where(
      maintenancePublicationResultCondition({
        ...binding,
        runId: input.body.runId,
      }),
    )
    .limit(1);
  const publicationVersionId = maintenancePublicationVersion(result);
  const mount = run.storageMounts?.find((entry) => {
    return entry.storageId === binding.memoryStorageId && entry.writeback;
  });
  const snapshot = input.body.artifactSnapshots?.find((entry) => {
    return entry.name === mount?.name && entry.mountPath === mount.mountPath;
  });
  if (
    !mount ||
    !snapshot ||
    (snapshot.version !== binding.claimedBaseVersionId &&
      snapshot.version !== publicationVersionId)
  ) {
    return "[PI_MAINTENANCE_OUTPUT_INVALID] Private output lacks exact publication or recovery evidence";
  }
  return {
    memoryStorageId: binding.memoryStorageId,
    versionId: publicationVersionId ?? binding.claimedBaseVersionId,
  };
}

function piValidationMatchesRun(
  prepared: PreparedAgentRunOutput,
  run: RunOutputContext,
): boolean {
  return (
    prepared.piValidation !== undefined &&
    prepared.piValidation.chatThreadId === run.chatThreadId &&
    prepared.piValidation.runSessionId === run.sessionId
  );
}

function runStorageOutputError(
  mounts: readonly PersistedStorageMount[] | null,
  outputs: AgentRunOutputBody["artifactSnapshots"],
): string | null {
  const identities = new Set<string>();
  for (const output of outputs ?? []) {
    const identity = JSON.stringify([output.name, output.mountPath]);
    if (
      identities.has(identity) ||
      !mounts?.some((mount) => {
        return (
          mount.writeback &&
          mount.name === output.name &&
          mount.mountPath === output.mountPath
        );
      })
    ) {
      return "Run output does not identify a unique authorized writeback mount";
    }
    identities.add(identity);
  }
  return null;
}

function isCompletedPrivatePiRun(run: RunOutputContext): boolean {
  return (
    run.status === "completed" &&
    run.chatThreadId === null &&
    isPiHistoryRun(run)
  );
}

export async function persistAgentRunOutputsInTransaction(
  tx: Tx,
  input: AgentRunOutputInput,
  prepared: PreparedAgentRunOutput,
  signal: AbortSignal,
): Promise<AgentRunOutputResponse> {
  let run = await lockRunOutputContext(tx, input);
  signal.throwIfAborted();
  if (!run) {
    return notFound("Agent run not found");
  }

  if (isCompletedPrivatePiRun(run)) {
    // Read completion evidence after acquiring the existing Run lock. Its
    // locking statement may have waited for a concurrent completion whose
    // conversation was still invisible to that statement's initial snapshot.
    const [existing] = await tx
      .select({
        conversationId: conversations.id,
        historyHash: conversations.cliAgentSessionHistoryHash,
        sessionId: conversations.cliAgentSessionId,
        result: agentRuns.result,
        type: conversations.cliAgentType,
      })
      .from(conversations)
      .innerJoin(agentRuns, eq(agentRuns.id, conversations.runId))
      .where(eq(conversations.runId, input.body.runId))
      .limit(1);
    signal.throwIfAborted();
    run = {
      ...run,
      existingOutput: parseExistingRunOutput(existing),
    };
  }

  const maintenance = await privateMaintenanceOutput(tx, input, run);
  signal.throwIfAborted();
  if (typeof maintenance === "string") {
    return badRequestMessage(maintenance);
  }
  const outputError = runStorageOutputError(
    run.storageMounts,
    input.body.artifactSnapshots,
  );
  if (outputError) {
    return badRequestMessage(outputError);
  }
  const storageMounts = resolvedOutputMounts({
    runStorageMounts: run.storageMounts,
    artifactSnapshots: input.body.artifactSnapshots,
  }).map((mount) => {
    return maintenance?.memoryStorageId === mount.storageId
      ? { ...mount, version: maintenance.versionId }
      : mount;
  });
  const typeError = piHistoryTypeError(run, input.body);
  if (typeError) {
    return badRequestMessage(typeError);
  }
  const piRun = isPiHistoryRun(run);
  if (!piRun && run.status === "timeout") {
    return badRequestMessage(runOutputStateError(run.status));
  }
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  ) {
    const exactRetry = await exactRunOutputRetryResponse(
      tx,
      run,
      input.body,
      storageMounts,
      signal,
    );
    if (exactRetry) {
      return exactRetry;
    }
    if (
      run.status === "completed" ||
      (await loadExistingRunOutput(tx, input.body.runId))
    ) {
      return badRequestMessage(
        "[RUN_OUTPUT_ALREADY_COMMITTED] Final output does not exactly match the committed Run output",
      );
    }
  }
  if (piRun && !maintenance) {
    const admission = await admitPiHistory(tx, run, input.body, storageMounts);
    signal.throwIfAborted();
    if (admission.kind === "error") {
      return badRequestMessage(admission.message);
    }
    if (admission.kind === "response") {
      return admission.response;
    }
    if (!piValidationMatchesRun(prepared, run)) {
      return badRequestMessage(
        "[PI_H2_RUN_STATE_CHANGED] Pi H2 must be retried after the run became active",
      );
    }
  }

  return await persistAgentRunOutput(
    tx,
    run,
    input.body,
    {
      storageMounts,
      deferSessionPromotion: piRun && !maintenance,
    },
    signal,
  );
}

/** One verified Run identity owns its lazy initial context and operations. */
export function createAgentRunOutputOperations(runId: string, userId: string) {
  const initialRun$ = createInitialRunOutputContext(runId, userId);
  const prepare$ = command(
    async (
      { get, set },
      input: AgentRunOutputInput,
      signal: AbortSignal,
    ): Promise<AgentRunOutputPreparation> => {
      const db = set(writeDb$);
      const run = await get(initialRun$);
      signal.throwIfAborted();

      if (!run) {
        return { ok: false, response: notFound("Agent run not found") };
      }

      const typeError = piHistoryTypeError(run, input.body);
      if (typeError) {
        return { ok: false, response: badRequestMessage(typeError) };
      }
      const maintenance = await privateMaintenanceOutput(db, input, run);
      signal.throwIfAborted();
      if (typeof maintenance === "string") {
        return { ok: false, response: badRequestMessage(maintenance) };
      }
      const piNeedsValidation =
        isPiHistoryRun(run) &&
        !maintenance &&
        isActivePiHistoryStatus(run.status);
      if (piNeedsValidation) {
        const piError = await set(validatePiH2$, db, run, input.body, signal);
        if (piError) {
          return { ok: false, response: badRequestMessage(piError) };
        }
      }

      return {
        ok: true,
        prepared: piNeedsValidation
          ? {
              piValidation: {
                chatThreadId: run.chatThreadId,
                runSessionId: run.sessionId,
              },
            }
          : {},
      };
    },
  );

  return { prepare$ };
}
