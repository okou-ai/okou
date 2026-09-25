import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { z } from "zod";
import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { RESUME_SESSION_HISTORY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  inspectPiSessionJsonl,
  UnsupportedPiSessionVersionError,
} from "@okouai/pi-agent-runtime/api";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { piMemoryPhase2MaintenanceCallbackPayloadSchema } from "./pi-memory-phase2-maintenance.service";
import { findPiMemoryPhase2Checkpoint } from "./pi-memory-phase2-checkpoint.service";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { conversations } from "@okouai/db/schema/conversation";
import type { PersistedStorageMount } from "@okouai/db/types";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
import type { SandboxAuth } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
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
import { lockAgentRunCheckpointLifecycle } from "./agent-run-checkpoint-lifecycle-lock.service";
import { safeSync, settle } from "../utils";

export type AgentCheckpointBody = z.infer<
  typeof webhookCheckpointsContract.create.body
>;
type PrepareHistoryBody = z.infer<
  typeof webhookCheckpointsPrepareHistoryContract.prepare.body
>;

export interface AgentCheckpointInput {
  readonly auth: SandboxAuth;
  readonly body: AgentCheckpointBody;
}

interface CheckpointAuthInput<TBody> {
  readonly auth: SandboxAuth;
  readonly body: TBody;
}

export interface PreparedAgentCheckpoint {
  readonly piValidation?: {
    readonly chatThreadId: string | null;
    readonly runSessionId: string;
  };
}

export type AgentCheckpointErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>;

type AgentCheckpointPreparation =
  | { readonly ok: true; readonly prepared: PreparedAgentCheckpoint }
  | {
      readonly ok: false;
      readonly response: AgentCheckpointErrorResponse;
    };

type AgentCheckpointPersistenceSource =
  | "standalone-webhook"
  | "combined-completion"
  | "pi-api-first-turn";

interface CheckpointRunContext {
  readonly agentSessionConversationId: string | null;
  readonly chatThreadId: string | null;
  readonly launchSnapshot: typeof agentRuns.$inferSelect.launchSnapshot;
  readonly status: RunStatus;
  readonly storageMounts: typeof agentRuns.$inferSelect.storageMounts;
  readonly sessionId: string;
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
type SessionHistoryBlobWriteDb = Pick<Db, "insert" | "select" | "update">;

const L = logger("webhooks:agent:checkpoints");

class PiCheckpointValidationError extends Error {}

function piCheckpointError(code: string, message: string): never {
  throw new PiCheckpointValidationError(`[${code}] ${message}`);
}

function responseArtifacts(
  snapshots: AgentCheckpointBody["artifactSnapshots"],
): AgentCheckpointBody["artifactSnapshots"] | undefined {
  return snapshots && snapshots.length > 0 ? snapshots : undefined;
}

function checkpointStorageMounts(args: {
  readonly runStorageMounts: readonly PersistedStorageMount[] | null;
  readonly artifactSnapshots: AgentCheckpointBody["artifactSnapshots"];
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

async function loadCheckpointRunContext(
  db: Db,
  input: AgentCheckpointInput,
): Promise<CheckpointRunContext | undefined> {
  const [run] = await db
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
    .limit(1);

  return run
    ? { ...run, status: runStatusSchema.parse(run.status) }
    : undefined;
}

async function lockCheckpointRunContext(
  tx: Tx,
  input: AgentCheckpointInput,
): Promise<CheckpointRunContext | undefined> {
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

  return run
    ? { ...run, status: runStatusSchema.parse(run.status) }
    : undefined;
}

async function decodePiCheckpointHistory(args: {
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
      return piCheckpointError(
        "PI_H2_METADATA_INVALID",
        "Pi H2 uses an unsupported history encoding",
      );
    }
  }
}

interface PiCheckpointValidationArgs {
  readonly db: Db;
  readonly run: CheckpointRunContext;
  readonly historyHash: string | undefined;
  readonly sessionId: string | undefined;
}

function validatePiCheckpointIdentity(args: PiCheckpointValidationArgs): {
  readonly historyHash: string;
  readonly sessionId: string;
} {
  if (!args.historyHash) {
    return piCheckpointError(
      "PI_H2_HISTORY_REQUIRED",
      "Pi H2 requires a native session history hash",
    );
  }
  if (
    !args.run.chatThreadId ||
    !args.sessionId ||
    args.sessionId !== args.run.chatThreadId
  ) {
    return piCheckpointError(
      "PI_H2_SESSION_MISMATCH",
      "Pi H2 session id does not match the Chat Thread",
    );
  }
  return { historyHash: args.historyHash, sessionId: args.sessionId };
}

function validatePiCheckpointMetadata(
  metadata: SessionHistoryBlobMetadata | undefined,
): ReturnType<typeof normalizeSessionHistoryBlobEncoding> {
  if (!metadata || metadata.rawSize <= 0 || metadata.encodedSize <= 0) {
    return piCheckpointError(
      "PI_H2_METADATA_INVALID",
      "Pi H2 blob metadata is unavailable or invalid",
    );
  }
  if (
    metadata.rawSize > RESUME_SESSION_HISTORY_MAX_BYTES ||
    metadata.encodedSize > RESUME_SESSION_HISTORY_MAX_BYTES
  ) {
    return piCheckpointError(
      "PI_H2_TOO_LARGE",
      "Pi H2 exceeds the native session size limit",
    );
  }
  const normalized = safeSync(() => {
    return normalizeSessionHistoryBlobEncoding(metadata.encoding);
  });
  if ("error" in normalized) {
    return piCheckpointError(
      "PI_H2_METADATA_INVALID",
      "Pi H2 uses an unsupported history encoding",
    );
  }
  return normalized.ok;
}

const downloadAndDecodePiCheckpoint$ = command(
  async function downloadAndDecodePiCheckpoint(
    { get },
    args: {
      readonly historyHash: string;
      readonly metadata: SessionHistoryBlobMetadata;
    },
    signal: AbortSignal,
  ): Promise<Buffer> {
    const encoding = validatePiCheckpointMetadata(args.metadata);
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
      return piCheckpointError(
        "PI_H2_DOWNLOAD_FAILED",
        "Pi H2 could not be downloaded",
      );
    }
    const encoded = downloaded.value;
    if (encoded.length !== args.metadata.encodedSize) {
      return piCheckpointError(
        "PI_H2_HASH_MISMATCH",
        "Pi H2 encoded size does not match its metadata",
      );
    }
    const decoded = await settle(
      decodePiCheckpointHistory({
        encoded,
        encoding,
        key,
        rawSize: args.metadata.rawSize,
      }),
      signal,
    );
    if (!decoded.ok) {
      if (decoded.error instanceof PiCheckpointValidationError) {
        throw decoded.error;
      }
      return piCheckpointError(
        "PI_H2_DECOMPRESSION_FAILED",
        "Pi H2 could not be decompressed",
      );
    }
    return decoded.value;
  },
);

function validatePiCheckpointSession(
  raw: Buffer,
  historyHash: string,
  sessionId: string,
  metadata: SessionHistoryBlobMetadata,
): void {
  if (
    raw.length !== metadata.rawSize ||
    createHash("sha256").update(raw).digest("hex") !== historyHash
  ) {
    return piCheckpointError(
      "PI_H2_HASH_MISMATCH",
      "Pi H2 failed its raw size or hash check",
    );
  }
  const parsed = safeSync(() => {
    const jsonl = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return inspectPiSessionJsonl(jsonl);
  });
  if ("error" in parsed) {
    return piCheckpointError(
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
    return piCheckpointError(
      "PI_H2_SESSION_MISMATCH",
      "Pi H2 native session id does not match the launch session",
    );
  }
  if (!session.isSettledCheckpoint) {
    return piCheckpointError(
      "PI_H2_NOT_SETTLED",
      "Pi H2 is not a settled native session checkpoint",
    );
  }
}

const validatePiCheckpoint$ = command(async function validatePiCheckpoint(
  { set },
  args: PiCheckpointValidationArgs,
  signal: AbortSignal,
): Promise<void> {
  const identity = validatePiCheckpointIdentity(args);
  const metadata = await loadSessionHistoryBlobMetadata(
    args.db,
    identity.historyHash,
  );
  signal.throwIfAborted();
  if (!metadata) {
    return piCheckpointError(
      "PI_H2_METADATA_INVALID",
      "Pi H2 blob metadata is unavailable or invalid",
    );
  }
  const raw = await set(
    downloadAndDecodePiCheckpoint$,
    {
      historyHash: identity.historyHash,
      metadata,
    },
    signal,
  );
  validatePiCheckpointSession(
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

async function ensureSessionHistoryBlobMetadata(
  args: {
    readonly db: SessionHistoryBlobWriteDb;
    readonly body: PrepareHistoryBody;
    readonly requestedEncoding: string;
  },
  signal: AbortSignal,
): Promise<PreparedSessionHistoryBlob> {
  const { db, body, requestedEncoding } = args;
  const [insertedBlob] = await db
    .insert(blobs)
    .values({
      hash: body.hash,
      rawSize: body.rawSize,
      encoding: requestedEncoding,
      encodedSize: body.encodedSize,
      refCount: 0,
    })
    .onConflictDoNothing()
    .returning({
      rawSize: blobs.rawSize,
      encoding: blobs.encoding,
      encodedSize: blobs.encodedSize,
    });
  signal.throwIfAborted();

  const insertedNewBlob = insertedBlob !== undefined;
  let blob =
    insertedBlob ?? (await loadSessionHistoryBlobMetadata(db, body.hash));
  signal.throwIfAborted();

  if (!blob) {
    throw new Error("failed to load session history blob metadata");
  }

  if (blob.rawSize !== 0) {
    return { blob, insertedNewBlob };
  }

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

  blob = updatedBlob ?? (await loadSessionHistoryBlobMetadata(db, body.hash));
  signal.throwIfAborted();

  if (!blob) {
    throw new Error("failed to load session history blob metadata");
  }

  return { blob, insertedNewBlob };
}

export const prepareCheckpointHistoryUpload$ = command(
  async (
    { get, set },
    input: CheckpointAuthInput<PrepareHistoryBody>,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
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

    const admission = await db.transaction(async (tx) => {
      await lockAgentRunCheckpointLifecycle(tx, input.body.runId);
      signal.throwIfAborted();
      const [run] = await tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, input.body.runId),
            eq(agentRuns.userId, input.auth.userId),
          ),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!run) {
        return { kind: "not-found" } as const;
      }
      const status = runStatusSchema.parse(run.status);
      if (status === "timeout") {
        return { kind: "timeout", status } as const;
      }
      return {
        kind: "admitted",
        prepared: await ensureSessionHistoryBlobMetadata(
          {
            db: tx,
            body: input.body,
            requestedEncoding,
          },
          signal,
        ),
      } as const;
    });
    signal.throwIfAborted();

    if (admission.kind === "not-found") {
      return notFound("Agent run not found");
    }
    if (admission.kind === "timeout") {
      return badRequestMessage(checkpointRunStateError(admission.status));
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
  run: CheckpointRunContext,
  body: AgentCheckpointBody,
  signal: AbortSignal,
): Promise<string | null> {
  if (body.cliAgentType !== "pi") {
    return null;
  }
  const validated = await settle(
    set(
      validatePiCheckpoint$,
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
    if (validated.error instanceof PiCheckpointValidationError) {
      return validated.error.message;
    }
    throw validated.error;
  }
  return null;
});

interface CheckpointSuccessIdentity {
  readonly agentSessionId: string;
  readonly checkpointId: string;
  readonly conversationId: string;
}

function checkpointSuccessResponse(
  identity: CheckpointSuccessIdentity,
  body: AgentCheckpointBody,
) {
  return {
    status: 200 as const,
    body: {
      checkpointId: identity.checkpointId,
      agentSessionId: identity.agentSessionId,
      conversationId: identity.conversationId,
      artifacts: responseArtifacts(body.artifactSnapshots),
      volumes: body.volumeVersionsSnapshot?.versions,
    },
  };
}

type AgentCheckpointSuccessResponse = ReturnType<
  typeof checkpointSuccessResponse
>;

type AgentCheckpointResponse =
  | AgentCheckpointSuccessResponse
  | AgentCheckpointErrorResponse;

function isActivePiCheckpointStatus(status: RunStatus): boolean {
  return status === "pending" || status === "running";
}

function isPiCheckpointRun(run: CheckpointRunContext): boolean {
  return run.launchSnapshot?.framework === "pi";
}

function piCheckpointTypeError(
  run: CheckpointRunContext,
  body: AgentCheckpointBody,
): string | null {
  if (isPiCheckpointRun(run) === (body.cliAgentType === "pi")) {
    return null;
  }
  return "[PI_H2_TYPE_MISMATCH] Checkpoint type does not match the run launch framework";
}

function piCheckpointRunStateError(status: RunStatus): string {
  const code =
    status === "queued" ? "PI_H2_RUN_NOT_ACTIVE" : "PI_H2_RUN_TERMINAL";
  return `[${code}] Pi H2 cannot become canonical while the run status is ${status}`;
}

function checkpointRunStateError(status: RunStatus): string {
  return `[CHECKPOINT_RUN_TERMINAL] Checkpoint cannot become canonical while the run status is ${status}`;
}

function standaloneCheckpointRunStateError(status: RunStatus): string {
  return `[CHECKPOINT_RUN_NOT_SETTLED] Standalone checkpoint cannot persist while the run status is ${status}`;
}

interface ExistingCheckpoint {
  readonly checkpointId: string;
  readonly conversationId: string;
  readonly historyHash: string | null;
  readonly sessionId: string | null;
  readonly storageMounts: typeof checkpoints.$inferSelect.storageMounts;
  readonly type: string | null;
}

async function loadExistingCheckpoint(
  tx: Tx,
  runId: string,
): Promise<ExistingCheckpoint | undefined> {
  const [existing] = await tx
    .select({
      checkpointId: checkpoints.id,
      conversationId: conversations.id,
      historyHash: conversations.cliAgentSessionHistoryHash,
      sessionId: conversations.cliAgentSessionId,
      storageMounts: checkpoints.storageMounts,
      type: conversations.cliAgentType,
    })
    .from(conversations)
    .innerJoin(
      checkpoints,
      and(
        eq(checkpoints.runId, runId),
        eq(checkpoints.conversationId, conversations.id),
      ),
    )
    .where(eq(conversations.runId, runId))
    .limit(1);
  return existing;
}

type PiCheckpointAdmission =
  | { readonly kind: "write" }
  | {
      readonly kind: "response";
      readonly response: ReturnType<typeof checkpointSuccessResponse>;
    }
  | { readonly kind: "error"; readonly message: string };

async function admitPiCheckpoint(
  tx: Tx,
  run: CheckpointRunContext,
  body: AgentCheckpointBody,
  storageMounts: readonly PersistedStorageMount[],
): Promise<PiCheckpointAdmission> {
  const active = isActivePiCheckpointStatus(run.status);
  if (!active && run.status !== "completed") {
    return { kind: "error", message: piCheckpointRunStateError(run.status) };
  }

  const existing = await loadExistingCheckpoint(tx, body.runId);
  if (!existing) {
    return active
      ? { kind: "write" }
      : { kind: "error", message: piCheckpointRunStateError(run.status) };
  }

  const exactRetry =
    existing.type === "pi" &&
    existing.sessionId === body.cliAgentSessionId &&
    existing.historyHash === body.cliAgentSessionHistoryHash &&
    isDeepStrictEqual(existing.storageMounts, storageMounts) &&
    (active || run.agentSessionConversationId === existing.conversationId);
  if (!exactRetry) {
    return {
      kind: "error",
      message:
        "[PI_H2_ALREADY_COMMITTED] Pi H2 does not exactly match the existing checkpoint",
    };
  }

  return {
    kind: "response",
    response: checkpointSuccessResponse(
      {
        agentSessionId: run.sessionId,
        checkpointId: existing.checkpointId,
        conversationId: existing.conversationId,
      },
      body,
    ),
  };
}

async function persistAgentCheckpoint(
  tx: Tx,
  run: CheckpointRunContext,
  body: AgentCheckpointBody,
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

  const checkpointFields = {
    conversationId: conversation.id,
    storageMounts,
  };
  const [checkpoint] = await tx
    .insert(checkpoints)
    .values({
      runId: body.runId,
      ...checkpointFields,
    })
    .onConflictDoUpdate({
      target: checkpoints.runId,
      set: checkpointFields,
    })
    .returning({ id: checkpoints.id });
  signal.throwIfAborted();

  if (!checkpoint) {
    throw new Error("Failed to upsert checkpoint record");
  }

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

  L.debug("Checkpoint created", {
    runId: body.runId,
    checkpointId: checkpoint.id,
    conversationId: conversation.id,
  });

  return checkpointSuccessResponse(
    {
      agentSessionId: run.sessionId,
      checkpointId: checkpoint.id,
      conversationId: conversation.id,
    },
    body,
  );
}

async function exactCheckpointRetryResponse(
  tx: Tx,
  run: CheckpointRunContext,
  body: AgentCheckpointBody,
  storageMounts: readonly PersistedStorageMount[],
  signal: AbortSignal,
): Promise<AgentCheckpointSuccessResponse | undefined> {
  const existing = await loadExistingCheckpoint(tx, body.runId);
  signal.throwIfAborted();
  const exactRetry =
    existing?.type === body.cliAgentType &&
    existing.sessionId === body.cliAgentSessionId &&
    existing.historyHash === (body.cliAgentSessionHistoryHash ?? null) &&
    isDeepStrictEqual(existing.storageMounts, storageMounts);
  if (!exactRetry) {
    return undefined;
  }
  return checkpointSuccessResponse(
    {
      agentSessionId: run.sessionId,
      checkpointId: existing.checkpointId,
      conversationId: existing.conversationId,
    },
    body,
  );
}

function isUnsettledCheckpointStatus(status: RunStatus): boolean {
  return status === "queued" || status === "pending" || status === "running";
}

async function standaloneCheckpointAdmissionResponse(
  tx: Tx,
  run: CheckpointRunContext,
  body: AgentCheckpointBody,
  storageMounts: readonly PersistedStorageMount[],
  signal: AbortSignal,
): Promise<AgentCheckpointResponse | undefined> {
  if (isUnsettledCheckpointStatus(run.status)) {
    return badRequestMessage(standaloneCheckpointRunStateError(run.status));
  }
  if (isPiCheckpointRun(run) || run.status !== "completed") {
    return undefined;
  }

  const exactRetry = await exactCheckpointRetryResponse(
    tx,
    run,
    body,
    storageMounts,
    signal,
  );
  return (
    exactRetry ??
    badRequestMessage(
      "[CHECKPOINT_ALREADY_COMMITTED] Final checkpoint does not exactly match the completed run",
    )
  );
}

// Private maintenance has no public Pi history. Its session is the authenticated
// run itself, and only an exact generic commit receipt can advance its snapshot.
async function privateMaintenanceCheckpoint(
  db: Db | Tx,
  input: AgentCheckpointInput,
  run: CheckpointRunContext,
): Promise<
  { memoryStorageId: string; versionId: string } | string | undefined
> {
  if (!isPiCheckpointRun(run)) {
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
    !isPiCheckpointRun(run) ||
    input.body.cliAgentSessionId !== input.body.runId ||
    input.body.cliAgentSessionHistoryHash !== undefined ||
    input.body.cliAgentSessionHistoryDisposition !== "unavailable"
  ) {
    return "[PI_MAINTENANCE_IDENTITY_INVALID] Private checkpoint identity does not match its launch";
  }
  const binding = parsed.data;
  const receipt = await findPiMemoryPhase2Checkpoint(db, {
    ...binding,
    runId: input.body.runId,
  });
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
      snapshot.version !== receipt?.versionId)
  ) {
    return "[PI_MAINTENANCE_CHECKPOINT_INVALID] Private checkpoint lacks exact publication or recovery evidence";
  }
  return {
    memoryStorageId: binding.memoryStorageId,
    versionId: receipt?.versionId ?? binding.claimedBaseVersionId,
  };
}

function piValidationMatchesRun(
  prepared: PreparedAgentCheckpoint,
  run: CheckpointRunContext,
): boolean {
  return (
    prepared.piValidation !== undefined &&
    prepared.piValidation.chatThreadId === run.chatThreadId &&
    prepared.piValidation.runSessionId === run.sessionId
  );
}

export async function persistAgentCheckpointInTransaction(
  tx: Tx,
  input: AgentCheckpointInput,
  prepared: PreparedAgentCheckpoint,
  signal: AbortSignal,
  options: {
    readonly source: AgentCheckpointPersistenceSource;
  },
): Promise<AgentCheckpointResponse> {
  const run = await lockCheckpointRunContext(tx, input);
  signal.throwIfAborted();
  if (!run) {
    return notFound("Agent run not found");
  }

  const maintenance = await privateMaintenanceCheckpoint(tx, input, run);
  signal.throwIfAborted();
  if (typeof maintenance === "string") {
    return badRequestMessage(maintenance);
  }
  const storageMounts = checkpointStorageMounts({
    runStorageMounts: run.storageMounts,
    artifactSnapshots: input.body.artifactSnapshots,
  }).map((mount) => {
    return maintenance?.memoryStorageId === mount.storageId
      ? { ...mount, version: maintenance.versionId }
      : mount;
  });
  const typeError = piCheckpointTypeError(run, input.body);
  if (typeError) {
    return badRequestMessage(typeError);
  }
  const piRun = isPiCheckpointRun(run);
  if (!piRun && run.status === "timeout") {
    return badRequestMessage(checkpointRunStateError(run.status));
  }
  if (options.source === "standalone-webhook") {
    const response = await standaloneCheckpointAdmissionResponse(
      tx,
      run,
      input.body,
      storageMounts,
      signal,
    );
    if (response) {
      return response;
    }
  }
  if (
    options.source === "combined-completion" &&
    (run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled")
  ) {
    const exactRetry = await exactCheckpointRetryResponse(
      tx,
      run,
      input.body,
      storageMounts,
      signal,
    );
    if (exactRetry) {
      return exactRetry;
    }
    if (run.status === "completed") {
      return badRequestMessage(
        "[CHECKPOINT_ALREADY_COMMITTED] Final checkpoint does not exactly match the completed run",
      );
    }
  }
  if (piRun && !maintenance) {
    const admission = await admitPiCheckpoint(
      tx,
      run,
      input.body,
      storageMounts,
    );
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

  return await persistAgentCheckpoint(
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

export const prepareAgentCheckpointPersistence$ = command(
  async (
    { set },
    input: AgentCheckpointInput,
    options: {
      readonly source: AgentCheckpointPersistenceSource;
    },
    signal: AbortSignal,
  ): Promise<AgentCheckpointPreparation> => {
    const db = set(writeDb$);
    const run = await loadCheckpointRunContext(db, input);
    signal.throwIfAborted();

    if (!run) {
      return { ok: false, response: notFound("Agent run not found") };
    }

    const typeError = piCheckpointTypeError(run, input.body);
    if (typeError) {
      return { ok: false, response: badRequestMessage(typeError) };
    }
    if (
      options.source === "standalone-webhook" &&
      isUnsettledCheckpointStatus(run.status)
    ) {
      return {
        ok: false,
        response: badRequestMessage(
          standaloneCheckpointRunStateError(run.status),
        ),
      };
    }
    const maintenance = await privateMaintenanceCheckpoint(db, input, run);
    signal.throwIfAborted();
    if (typeof maintenance === "string") {
      return { ok: false, response: badRequestMessage(maintenance) };
    }
    const piNeedsValidation =
      isPiCheckpointRun(run) &&
      !maintenance &&
      isActivePiCheckpointStatus(run.status);
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

async function commitAgentCheckpoint(
  db: Db,
  input: AgentCheckpointInput,
  prepared: PreparedAgentCheckpoint,
  signal: AbortSignal,
  source: AgentCheckpointPersistenceSource,
): Promise<AgentCheckpointResponse> {
  return await db.transaction(async (tx) => {
    await lockAgentRunCheckpointLifecycle(tx, input.body.runId);
    signal.throwIfAborted();
    return await persistAgentCheckpointInTransaction(
      tx,
      input,
      prepared,
      signal,
      { source },
    );
  });
}

export const createAgentCheckpoint$ = command(
  async ({ set }, input: AgentCheckpointInput, signal: AbortSignal) => {
    const db = set(writeDb$);
    const preparation = await set(
      prepareAgentCheckpointPersistence$,
      input,
      { source: "standalone-webhook" },
      signal,
    );
    if (!preparation.ok) {
      return preparation.response;
    }

    return await commitAgentCheckpoint(
      db,
      input,
      preparation.prepared,
      signal,
      "standalone-webhook",
    );
  },
);

export const createPiApiFirstTurnCheckpoint$ = command(
  async ({ set }, input: AgentCheckpointInput, signal: AbortSignal) => {
    const db = set(writeDb$);
    const preparation = await set(
      prepareAgentCheckpointPersistence$,
      input,
      { source: "pi-api-first-turn" },
      signal,
    );
    if (!preparation.ok) {
      return preparation.response;
    }

    return await commitAgentCheckpoint(
      db,
      input,
      preparation.prepared,
      signal,
      "pi-api-first-turn",
    );
  },
);
