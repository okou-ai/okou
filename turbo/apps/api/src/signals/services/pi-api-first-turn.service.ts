import { createHash } from "node:crypto";

import {
  CANONICAL_WORKING_DIR,
  PI_AGENT_DIR,
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  type StoredResumeSession,
  type PiApiFirstTurnManifest,
  type PiApiFirstTurnOwnershipTransferMode,
  type PiResourceSnapshot,
  type SecretConnectorMetadata,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { modelProviderTypeSchema } from "@okouai/api-contracts/contracts/model-providers";
import { activeInputDeliveries } from "@okouai/db/schema/active-input-delivery";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import {
  materializePiExecutionRoute,
  normalizePiExecutionRoute,
  type PiExecutionRoute,
  type PiAgentCredentialReference,
  type PiAgentModelConfig,
} from "@okouai/pi-agent-runtime";
import {
  createPiApiFirstTurnOwnership,
  createPiSessionJsonl,
  PiApiModelRequestError,
  type PiApiModelFailureDiagnostic,
  inspectPiSessionJsonl,
  PiApiFirstTurnCompactionRequiredError,
  preparePiApiTurn,
  executePreparedPiApiTurn,
  type PreparedPiApiTurn,
  measurePiPreparation,
  measurePiPreparationSync,
  startPiPreparationObservation,
  type PiPreparationObserver,
  type PiApiFirstTurnOwnership,
  type PiApiFirstTurnResult,
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
} from "@okouai/pi-agent-runtime/api";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import {
  decideApiFirstTurnCommit,
  decideApiFirstTurnHistory,
  decideApiFirstTurnRecovery,
  decideApiFirstTurnTerminal,
  normalizedApiFirstTurnFailure,
  normalizedSandboxFallbackFailure,
  PiApiFirstTurnActiveInputBeforeProviderError,
  PiApiFirstTurnCanonicalCancellationError,
  PiApiFirstTurnCodexReconnectRequiredError,
  PiApiFirstTurnError,
  piApiFirstTurnError,
  PiApiFirstTurnModelFailureError,
  type PiSandboxFallbackReason,
  type PiSandboxFirstReason,
} from "../../lib/pi-api-first-turn-policy";
import {
  piApiFirstTurnAssistantEvents,
  piApiFirstTurnResultEvent,
} from "../../lib/pi-api-first-turn-events";
import type { Tx } from "../../lib/db-types";
import type { AgentEvent } from "../../lib/event-consumer/verify";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import { publishCancelToRunnerGroup } from "../external/realtime";
import {
  downloadS3BufferWithMaxBytes,
  generatePresignedGetUrl,
  putImmutableS3Object,
  putS3Object,
} from "../external/s3";
import {
  completeAgentRun$,
  type CompleteSideEffectsInput,
  type DispatchCompleteSideEffectsInput,
} from "./agent-webhook-complete.service";
import { createPiApiFirstTurnCheckpoint$ } from "./agent-webhook-checkpoints.service";
import {
  isTerminalChatgptRefreshErrorCode,
  readModelProviderRuntimeReconnectStateForApi,
  resolveCurrentModelProviderRuntimeSecretForApi,
  resolveModelProviderRuntimeSecretForApi,
} from "./agent-webhook-firewall-auth.service";
import {
  dispatchOptionalAgentEventConsumers$,
  receiveAgentEvents$,
} from "./agent-webhook-events.service";
import { decryptPersistentSecretsMap } from "./crypto.utils";
import {
  gunzipSessionHistoryBufferWithMaxBytes,
  unzstdSessionHistoryBufferWithMaxBytes,
} from "./session-history-decompression";
import {
  normalizeSessionHistoryBlobEncoding,
  resumeSessionHistoryBlobKey,
  resumeSessionHistoryRawBlobKey,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "./session-history-blobs";
import {
  PI_API_FIRST_TURN_API_OWNERSHIP_TIMEOUT_MS,
  PI_API_FIRST_TURN_URL_TTL_SECONDS,
  piApiFirstTurnObjectKey,
  type PiApiFirstTurnActivation,
} from "./pi-api-first-turn-config";
import { recordPiApiFirstTurnUsage } from "./pi-api-first-turn-usage.service";
import { piPreparationObserver } from "./pi-preparation-timing.service";
import {
  PiResourceSnapshotPreparationError,
  preparePiResourceSnapshot,
  UnsupportedPiResourceError,
} from "./pi-resource-snapshot.service";
import { lockPiApiFirstTurnLifecycle } from "./pi-api-first-turn-lifecycle.service";
import {
  awaitWithSignal,
  onRejection,
  safeSync,
  settle,
  settleIncludingAbort,
  tapError,
} from "../utils";

import type { CreatorAuthorizedPiPreparation } from "./agent-run-create.service";
import {
  PiApiFirstTurnPreparation,
  type PiApiFirstTurnPreparedInputs,
} from "./pi-api-first-turn-preparation";

const MODEL_COMMIT_BUDGET_MS = 2000;
const FAILURE_COMMIT_TIMEOUT_MS = 10_000;
const L = logger("pi-api-first-turn");

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function decodeSessionHistory(args: {
  readonly encoded: Buffer;
  readonly encoding: string;
  readonly key: string;
}): Promise<Buffer> {
  switch (args.encoding) {
    case SESSION_HISTORY_ENCODING_GZIP: {
      return await gunzipSessionHistoryBufferWithMaxBytes(
        args.key,
        args.encoded,
        PI_API_FIRST_TURN_SESSION_MAX_BYTES,
      );
    }
    case SESSION_HISTORY_ENCODING_ZSTD: {
      return await unzstdSessionHistoryBufferWithMaxBytes(
        args.key,
        args.encoded,
        PI_API_FIRST_TURN_SESSION_MAX_BYTES,
      );
    }
    case SESSION_HISTORY_ENCODING_IDENTITY: {
      return args.encoded;
    }
    default: {
      throw piApiFirstTurnError(
        "PI_H0_ENCODING_UNSUPPORTED",
        "Pi H0 uses an unsupported encoding",
      );
    }
  }
}

interface LoadedResumeSession {
  readonly jsonl: string | undefined;
  readonly sha256: string | null;
}

function loadInlineResumeSession(sessionHistory: string): LoadedResumeSession {
  const bytes = Buffer.from(sessionHistory, "utf8");
  if (
    bytes.length === 0 ||
    bytes.length > PI_API_FIRST_TURN_SESSION_MAX_BYTES
  ) {
    throw piApiFirstTurnError(
      "PI_H0_TOO_LARGE",
      "Pi H0 is empty or exceeds the API first-turn limit",
    );
  }
  return { jsonl: sessionHistory, sha256: sha256(bytes) };
}

async function readResumeSessionMetadata(
  db: Db,
  historyRef: Extract<
    StoredResumeSession,
    { historyRef: unknown }
  >["historyRef"],
  signal: AbortSignal,
) {
  const hash = historyRef.hash;
  const [metadata] = await db
    .select({
      rawSize: blobs.rawSize,
      encoding: blobs.encoding,
      encodedSize: blobs.encodedSize,
    })
    .from(blobs)
    .where(eq(blobs.hash, hash))
    .limit(1);
  signal.throwIfAborted();
  if (!metadata || metadata.rawSize <= 0 || metadata.encodedSize <= 0) {
    throw piApiFirstTurnError(
      "PI_H0_METADATA_INVALID",
      "Pi H0 metadata is unavailable or invalid",
    );
  }
  if (
    metadata.rawSize > RESUME_SESSION_HISTORY_MAX_BYTES ||
    metadata.encodedSize > RESUME_SESSION_HISTORY_MAX_BYTES
  ) {
    throw piApiFirstTurnError(
      "PI_H0_TOO_LARGE",
      "Pi H0 exceeds the native session size limit",
    );
  }
  const normalizedEncoding = safeSync(() => {
    return normalizeSessionHistoryBlobEncoding(metadata.encoding);
  });
  if ("error" in normalizedEncoding) {
    throw piApiFirstTurnError(
      "PI_H0_ENCODING_UNSUPPORTED",
      "Pi H0 uses an unsupported encoding",
      normalizedEncoding.error,
    );
  }
  const encoding = normalizedEncoding.ok;
  const referencedEncoding =
    historyRef.encoding ?? SESSION_HISTORY_ENCODING_IDENTITY;
  if (encoding !== referencedEncoding) {
    throw piApiFirstTurnError(
      "PI_H0_METADATA_INVALID",
      "Pi H0 encoding does not match the stored checkpoint reference",
    );
  }
  return { ...metadata, encoding };
}

const loadResumeSessionJsonl$ = command(async function loadResumeSessionJsonl(
  { get },
  args: {
    readonly db: Db;
    readonly resumeSession: StoredExecutionContext["resumeSession"];
  },
  signal: AbortSignal,
): Promise<LoadedResumeSession> {
  const resumeSession = args.resumeSession;
  if (!resumeSession) {
    return { jsonl: undefined, sha256: null };
  }
  if ("sessionHistory" in resumeSession) {
    return loadInlineResumeSession(resumeSession.sessionHistory);
  }

  const hash = resumeSession.historyRef.hash;
  const metadata = await readResumeSessionMetadata(
    args.db,
    resumeSession.historyRef,
    signal,
  );
  if (
    metadata.rawSize > PI_API_FIRST_TURN_SESSION_MAX_BYTES ||
    metadata.encodedSize > PI_API_FIRST_TURN_SESSION_MAX_BYTES
  ) {
    throw piApiFirstTurnError(
      "PI_H0_TOO_LARGE",
      "Pi H0 exceeds the API first-turn limit",
    );
  }
  const encoding = metadata.encoding;
  const key = resumeSessionHistoryBlobKey(hash, encoding);
  const downloaded = await settle(
    get(
      downloadS3BufferWithMaxBytes(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        key,
        metadata.encodedSize,
        signal,
      ),
    ),
    signal,
  );
  if (!downloaded.ok) {
    throw piApiFirstTurnError(
      "PI_H0_DOWNLOAD_FAILED",
      "Pi H0 download failed",
      downloaded.error,
    );
  }
  const encoded = downloaded.value;
  if (encoded.length !== metadata.encodedSize) {
    throw piApiFirstTurnError(
      "PI_H0_HASH_MISMATCH",
      "Pi H0 encoded size does not match its metadata",
    );
  }
  const decoded = await settle(
    decodeSessionHistory({ encoded, encoding, key }),
    signal,
  );
  if (!decoded.ok) {
    if (decoded.error instanceof PiApiFirstTurnError) {
      throw decoded.error;
    }
    throw piApiFirstTurnError(
      "PI_H0_DECOMPRESSION_FAILED",
      "Pi H0 decompression failed",
      decoded.error,
    );
  }
  const raw = decoded.value;
  if (raw.length !== metadata.rawSize || sha256(raw) !== hash) {
    throw piApiFirstTurnError(
      "PI_H0_HASH_MISMATCH",
      "Pi H0 failed its size or hash check",
    );
  }
  const decodedJsonl = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  });
  if ("error" in decodedJsonl) {
    throw piApiFirstTurnError(
      "PI_H0_JSONL_INVALID",
      "Pi H0 is not valid UTF-8 JSONL",
      decodedJsonl.error,
    );
  }
  return { jsonl: decodedJsonl.ok, sha256: hash };
});

function validateResumeSession(args: {
  readonly loaded: LoadedResumeSession;
  readonly expectedBaseSession: {
    readonly sessionId: string;
    readonly sha256: string | null;
  };
  readonly sessionId: string;
}): void {
  if (
    args.expectedBaseSession.sessionId !== args.sessionId ||
    args.expectedBaseSession.sha256 !== args.loaded.sha256
  ) {
    throw piApiFirstTurnError(
      "PI_H0_HASH_MISMATCH",
      "Pi H0 does not match the launch base checkpoint",
    );
  }
  if (args.loaded.jsonl === undefined) {
    return;
  }
  const parsed = safeSync(() => {
    return inspectPiSessionJsonl(args.loaded.jsonl ?? "");
  });
  if ("error" in parsed) {
    if (parsed.error instanceof UnsupportedPiSessionVersionError) {
      throw piApiFirstTurnError(
        "PI_H0_SESSION_UNSUPPORTED",
        "Pi H0 uses an unsupported session version",
        parsed.error,
      );
    }
    throw piApiFirstTurnError(
      "PI_H0_JSONL_INVALID",
      "Pi H0 is not a valid native Pi session",
      parsed.error,
    );
  }
  const session = parsed.ok;
  if (session.sessionId !== args.sessionId) {
    throw piApiFirstTurnError(
      "PI_H0_SESSION_MISMATCH",
      "Pi H0 session id does not match the launch session",
    );
  }
}

interface ApiFirstTurnLifecycleState {
  readonly triggerSource: string | null;
  readonly activeDeliveryId: string | null;
  readonly chatThreadId: string | null;
  readonly orgId: string;
  readonly status: string;
  readonly userId: string;
}

async function readApiFirstTurnLifecycleState(
  tx: Tx,
  runId: string,
): Promise<ApiFirstTurnLifecycleState | null> {
  const [[run], [activeInput]] = await Promise.all([
    tx
      .select({
        status: agentRuns.status,
        triggerSource: agentRuns.triggerSource,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        chatThreadId: agentRuns.chatThreadId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1),
    tx
      .select({ id: activeInputDeliveries.id })
      .from(activeInputDeliveries)
      .where(
        and(
          eq(activeInputDeliveries.runId, runId),
          eq(activeInputDeliveries.status, "open"),
        ),
      )
      .limit(1),
  ]);
  return run
    ? {
        ...run,
        activeDeliveryId: activeInput?.id ?? null,
      }
    : null;
}

const publishEvents$ = command(async function publishEvents(
  { set },
  args: {
    readonly auth: SandboxAuth;
    readonly events: readonly AgentEvent[];
  },
  signal: AbortSignal,
): Promise<void> {
  const result = await set(
    receiveAgentEvents$,
    {
      auth: args.auth,
      body: { runId: args.auth.runId, events: args.events },
    },
    signal,
  );
  if (result.response.status !== 200) {
    throw new Error("Pi API first-turn event projection was rejected");
  }
  if ("acceptedEvents" in result && result.acceptedEvents) {
    waitUntil(
      set(dispatchOptionalAgentEventConsumers$, result.acceptedEvents, signal),
    );
  }
});

const persistIdentitySessionBlob$ = command(
  async function persistIdentitySessionBlob(
    { get },
    args: {
      readonly db: Db;
      readonly hash: string;
      readonly bytes: Buffer;
    },
    signal: AbortSignal,
  ): Promise<void> {
    await args.db
      .insert(blobs)
      .values({
        hash: args.hash,
        rawSize: args.bytes.length,
        encoding: SESSION_HISTORY_ENCODING_IDENTITY,
        encodedSize: args.bytes.length,
        refCount: 0,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    await args.db
      .update(blobs)
      .set({
        rawSize: args.bytes.length,
        encoding: SESSION_HISTORY_ENCODING_IDENTITY,
        encodedSize: args.bytes.length,
      })
      .where(and(eq(blobs.hash, args.hash), eq(blobs.rawSize, 0)));
    signal.throwIfAborted();
    const [metadata] = await args.db
      .select({
        rawSize: blobs.rawSize,
        encoding: blobs.encoding,
        encodedSize: blobs.encodedSize,
      })
      .from(blobs)
      .where(eq(blobs.hash, args.hash))
      .limit(1);
    signal.throwIfAborted();
    if (
      metadata?.rawSize !== args.bytes.length ||
      metadata.encodedSize !== args.bytes.length ||
      metadata.encoding !== SESSION_HISTORY_ENCODING_IDENTITY
    ) {
      throw new Error("Pi API first-turn blob metadata is incompatible");
    }
    await get(
      putImmutableS3Object(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        resumeSessionHistoryRawBlobKey(args.hash),
        args.bytes,
        "application/octet-stream",
        signal,
      ),
    );
  },
);

const writeManifest$ = command(async function writeManifest(
  { get },
  args: {
    readonly runId: string;
    readonly manifest: PiApiFirstTurnManifest;
  },
  signal: AbortSignal,
): Promise<void> {
  await get(
    putS3Object(
      env("R2_USER_STORAGES_BUCKET_NAME"),
      piApiFirstTurnObjectKey(args.runId, "manifest"),
      JSON.stringify(args.manifest),
      "application/json",
      signal,
    ),
  );
});

interface ApiFirstTurnContext {
  readonly db: Db;
  readonly activation: PiApiFirstTurnActivation;
}

interface ApiFirstTurnModelContext extends ApiFirstTurnContext {
  readonly route: PiExecutionRoute;
}

interface PreparedApiFirstTurn {
  readonly apiStartTime: number;
  readonly auth: SandboxAuth;
  readonly baseSession: PiApiFirstTurnManifest["baseSession"];
  readonly commitIdentity: ApiFirstTurnCommitIdentity;
  readonly sessionBytes: Buffer;
  readonly sessionHash: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly turn: PiApiFirstTurnResult;
}

type ApiFirstTurnExecutionResult =
  | {
      readonly outcome: "completed";
      readonly sideEffects: CompleteSideEffectsInput | undefined;
    }
  | { readonly outcome: "transferred" };

interface ApiFirstTurnCommitProgress {
  started: boolean;
}

type ApiFirstTurnExecutionContext =
  PiApiFirstTurnActivation["executionContext"];
type ApiFirstTurnLaunchConfig =
  ApiFirstTurnExecutionContext["piLaunchConfig"]["apiFirstTurn"];

function piApiFirstTurnOutcomeTelemetry(
  executionContext: ApiFirstTurnExecutionContext,
) {
  const config = executionContext.piModelConfig;
  const dialect =
    "schemaVersion" in config ? config.dialect : "openai-responses";
  const providerTypes = new Set(
    ("schemaVersion" in config ? config.credentialBindings : [])
      .map((binding) => {
        const providerType =
          executionContext.secretConnectorMap?.[binding.secretName];
        const metadata =
          executionContext.secretConnectorMetadataMap?.[binding.secretName];
        const parsed = modelProviderTypeSchema.safeParse(providerType);
        return parsed.success &&
          metadata?.sourceType === "model-provider" &&
          metadata.metadataKey === parsed.data
          ? parsed.data
          : null;
      })
      .filter((providerType) => {
        return providerType !== null;
      }),
  );
  const [productProvider] = providerTypes;
  return {
    dialect,
    executionOwner: "api-first" as const,
    ...(providerTypes.size === 1 && productProvider ? { productProvider } : {}),
  };
}

interface ApiFirstTurnCommitIdentity {
  readonly baseSessionId: string;
  readonly baseSessionSha256: string | null;
  readonly deadlineAt: number;
  readonly resourceSnapshotDigest: string;
  readonly sandboxEventSequenceStart: number;
  readonly sessionId: string;
}

function apiFirstTurnCommitIdentity(
  args: ApiFirstTurnContext,
): ApiFirstTurnCommitIdentity {
  const { launchConfig, sessionId } = validateApiFirstTurnLaunch(args);
  return {
    baseSessionId: launchConfig.baseSession.sessionId,
    baseSessionSha256: launchConfig.baseSession.sha256,
    deadlineAt: launchConfig.deadlineAt,
    resourceSnapshotDigest: launchConfig.resourceSnapshotDigest,
    sandboxEventSequenceStart: launchConfig.sandboxEventSequenceStart,
    sessionId,
  };
}

function sameApiFirstTurnCommitIdentity(
  left: ApiFirstTurnCommitIdentity,
  right: ApiFirstTurnCommitIdentity,
): boolean {
  return (
    left.baseSessionId === right.baseSessionId &&
    left.baseSessionSha256 === right.baseSessionSha256 &&
    left.deadlineAt === right.deadlineAt &&
    left.resourceSnapshotDigest === right.resourceSnapshotDigest &&
    left.sandboxEventSequenceStart === right.sandboxEventSequenceStart &&
    left.sessionId === right.sessionId
  );
}

async function withApiFirstTurnLifecycle<T>(
  args: ApiFirstTurnContext,
  operation: (tx: Tx) => Promise<T>,
): Promise<T> {
  return await args.db.transaction(async (tx) => {
    await lockPiApiFirstTurnLifecycle(tx, args.activation.runId);
    return await operation(tx);
  });
}

function validateApiFirstTurnLaunch(args: ApiFirstTurnContext): {
  readonly executionContext: ApiFirstTurnExecutionContext;
  readonly launchConfig: ApiFirstTurnLaunchConfig;
  readonly sessionId: string;
} {
  const { executionContext } = args.activation;
  const launchConfig = executionContext.piLaunchConfig.apiFirstTurn;
  const sessionId = executionContext.piSessionId;
  if (launchConfig.baseSession.sessionId !== sessionId) {
    throw piApiFirstTurnError(
      "PI_LAUNCH_CONFIG_INVALID",
      "Pi launch base session id does not match the Pi session id",
    );
  }
  if (now() >= launchConfig.deadlineAt) {
    throw piApiFirstTurnError(
      "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
      "Pi API first-turn deadline elapsed before preparation",
    );
  }
  return { executionContext, launchConfig, sessionId };
}

function apiFirstTurnApiDeadlineAt(
  executionContext: ApiFirstTurnExecutionContext,
): number {
  return (
    executionContext.apiStartTime + PI_API_FIRST_TURN_API_OWNERSHIP_TIMEOUT_MS
  );
}

function validateApiFirstTurnLifecycle(
  args: ApiFirstTurnContext,
  state: ApiFirstTurnLifecycleState | null,
  expectedIdentity: ApiFirstTurnCommitIdentity,
  message: string,
): ApiFirstTurnLifecycleState {
  if (state?.status === "cancelled") {
    throw new PiApiFirstTurnCanonicalCancellationError();
  }
  if (
    !state ||
    state.triggerSource === "goal" ||
    (state.status !== "pending" && state.status !== "running") ||
    state.userId !== args.activation.userId ||
    state.orgId !== args.activation.orgId ||
    state.chatThreadId !== expectedIdentity.sessionId
  ) {
    throw piApiFirstTurnError("PI_API_FIRST_TURN_NOT_COMMITTABLE", message);
  }
  const currentIdentity = apiFirstTurnCommitIdentity(args);
  if (!sameApiFirstTurnCommitIdentity(currentIdentity, expectedIdentity)) {
    throw piApiFirstTurnError(
      "PI_LAUNCH_CONFIG_INVALID",
      "Pi API first-turn immutable launch identity changed before commit",
    );
  }
  return state;
}

function validateApiFirstTurnApiCommit(
  args: ApiFirstTurnContext,
  state: ApiFirstTurnLifecycleState | null,
  expectedIdentity: ApiFirstTurnCommitIdentity,
  message: string,
): ApiFirstTurnLifecycleState {
  const committable = validateApiFirstTurnLifecycle(
    args,
    state,
    expectedIdentity,
    message,
  );
  if (
    now() + MODEL_COMMIT_BUDGET_MS >=
    apiFirstTurnApiDeadlineAt(args.activation.executionContext)
  ) {
    throw piApiFirstTurnError(
      "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
      "Pi API first turn has no remaining commit budget",
    );
  }
  return committable;
}

function validateApiFirstTurnHandoffCommit(
  args: ApiFirstTurnContext,
  state: ApiFirstTurnLifecycleState | null,
  expectedIdentity: ApiFirstTurnCommitIdentity,
  message: string,
): ApiFirstTurnLifecycleState {
  const committable = validateApiFirstTurnLifecycle(
    args,
    state,
    expectedIdentity,
    message,
  );
  if (now() >= expectedIdentity.deadlineAt) {
    throw piApiFirstTurnError(
      "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
      "Pi API first-turn coordination deadline elapsed during handoff",
    );
  }
  return committable;
}

const loadApiFirstTurnResource$ = command(
  async function loadApiFirstTurnResource(
    { get },
    args: ApiFirstTurnContext,
    executionContext: ApiFirstTurnExecutionContext,
    expectedDigest: string,
    signal: AbortSignal,
  ): Promise<PiResourceSnapshot> {
    const prepared = await settle(
      get(
        preparePiResourceSnapshot(
          {
            db: args.db,
            mounts: executionContext.storageMounts,
            memoryRecall: executionContext.piLaunchConfig.memoryRecall,
            runId: args.activation.runId,
          },
          signal,
        ),
      ),
      signal,
    );
    if (!prepared.ok) {
      if (prepared.error instanceof UnsupportedPiResourceError) {
        throw piApiFirstTurnError(
          "PI_API_RESOURCE_UNSUPPORTED",
          prepared.error.message,
          prepared.error,
        );
      }
      if (prepared.error instanceof PiResourceSnapshotPreparationError) {
        throw piApiFirstTurnError(
          "PI_API_RESOURCE_PREPARATION_FAILED",
          prepared.error.message,
          prepared.error,
        );
      }
      throw piApiFirstTurnError(
        "PI_API_RESOURCE_INVALID",
        "Pi resource snapshot could not be loaded strictly",
        prepared.error,
      );
    }
    const preparedResource: {
      readonly digest: string;
      readonly snapshot: PiResourceSnapshot;
    } = prepared.value;
    if (preparedResource.digest !== expectedDigest) {
      throw piApiFirstTurnError(
        "PI_API_RESOURCE_INVALID",
        "Pi resource snapshot digest does not match the launch config",
      );
    }
    return preparedResource.snapshot;
  },
);

interface CodexSubscriptionCredentialReference {
  readonly binding: PiAgentCredentialReference;
  readonly providerKey: "codex-oauth-token";
  readonly metadata: SecretConnectorMetadata & {
    readonly sourceType: "model-provider";
    readonly sourceUserId: string;
    readonly sourceId: string;
    readonly metadataKey: "codex-oauth-token";
  };
}

function sameCredentialSource(
  left: SecretConnectorMetadata,
  right: SecretConnectorMetadata,
): boolean {
  return (
    left.sourceType === right.sourceType &&
    left.sourceUserId === right.sourceUserId &&
    left.sourceId === right.sourceId &&
    left.metadataKey === right.metadataKey
  );
}

function codexSubscriptionCredentialReferences(args: {
  readonly activation: PiApiFirstTurnActivation;
  readonly executionContext: ApiFirstTurnExecutionContext;
  readonly route: PiExecutionRoute;
}): {
  readonly accessToken: CodexSubscriptionCredentialReference;
  readonly accountId: CodexSubscriptionCredentialReference;
} | null {
  const config = args.route;
  if (config.dialect !== "openai-codex-responses") {
    return null;
  }
  const reference = (
    kind: PiAgentCredentialReference["kind"],
  ): CodexSubscriptionCredentialReference => {
    const binding = config.credentialBindings.find((candidate) => {
      return candidate.kind === kind;
    });
    if (!binding) {
      throw piApiFirstTurnError(
        "PI_API_MODEL_CREDENTIAL_INVALID",
        "Pi API first-turn subscription binding is missing",
      );
    }
    const providerKey =
      args.executionContext.secretConnectorMap?.[binding.secretName];
    const metadata =
      args.executionContext.secretConnectorMetadataMap?.[binding.secretName];
    if (
      providerKey !== "codex-oauth-token" ||
      metadata?.sourceType !== "model-provider" ||
      metadata.sourceUserId !== args.activation.userId ||
      !metadata.sourceId ||
      metadata.metadataKey !== "codex-oauth-token"
    ) {
      throw piApiFirstTurnError(
        "PI_API_MODEL_CREDENTIAL_INVALID",
        "Pi API first-turn subscription binding is not exact-account scoped",
      );
    }
    return {
      binding,
      providerKey,
      metadata: {
        ...metadata,
        sourceType: "model-provider",
        sourceUserId: metadata.sourceUserId,
        sourceId: metadata.sourceId,
        metadataKey: "codex-oauth-token",
      },
    };
  };
  const accessToken = reference("access-token");
  const accountId = reference("account-id");
  if (!sameCredentialSource(accessToken.metadata, accountId.metadata)) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription bindings do not share one account",
    );
  }
  return { accessToken, accountId };
}

function runtimeCredentialLookupArgs(
  args: ApiFirstTurnContext,
  reference: CodexSubscriptionCredentialReference,
) {
  return {
    db: args.db,
    orgId: args.activation.orgId,
    userId: args.activation.userId,
    key: reference.binding.secretName,
    providerKey: reference.providerKey,
    metadata: reference.metadata,
    featureSwitchContext: {
      userId: args.activation.userId,
      orgId: args.activation.orgId,
    },
  };
}

async function resolveCodexSubscriptionCredentials(
  args: ApiFirstTurnContext,
  references: NonNullable<
    ReturnType<typeof codexSubscriptionCredentialReferences>
  >,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const accessTokenResolution = await settle(
    resolveCurrentModelProviderRuntimeSecretForApi(
      runtimeCredentialLookupArgs(args, references.accessToken),
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!accessTokenResolution.ok) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription access token refresh failed",
      accessTokenResolution.error,
    );
  }
  const accessToken = accessTokenResolution.value;
  if (accessToken.status === "unavailable") {
    if (
      accessToken.reconnectState?.needsReconnect &&
      isTerminalChatgptRefreshErrorCode(
        accessToken.reconnectState.lastRefreshErrorCode,
      )
    ) {
      throw new PiApiFirstTurnCodexReconnectRequiredError();
    }
    const reconnectRequired =
      accessToken.reconnectState === null ||
      accessToken.reconnectState.needsReconnect;
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription access token is unavailable",
      undefined,
      reconnectRequired ? "reconnect_required" : undefined,
    );
  }

  // Deliberately read only after access-token refresh, using the already
  // validated immutable sourceId rather than resolving the active account.
  const accountIdResolution = await settle(
    resolveModelProviderRuntimeSecretForApi(
      runtimeCredentialLookupArgs(args, references.accountId),
    ),
  );
  signal.throwIfAborted();
  if (!accountIdResolution.ok) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription account lookup failed",
      accountIdResolution.error,
    );
  }
  const accountId = accountIdResolution.value;
  if (!accessToken.value.trim() || !accountId?.trim()) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription credential is unavailable",
      undefined,
      "reconnect_required",
    );
  }
  return new Map([
    [references.accessToken.binding.secretName, accessToken.value],
    [references.accountId.binding.secretName, accountId],
  ]);
}

async function apiFirstTurnModelConfig(
  args: ApiFirstTurnModelContext,
  executionContext: ApiFirstTurnExecutionContext,
  signal: AbortSignal,
): Promise<PiAgentModelConfig> {
  const modelConfig = args.route;
  const subscriptionReferences = codexSubscriptionCredentialReferences({
    activation: args.activation,
    executionContext,
    route: modelConfig,
  });
  const subscriptionCredentials = subscriptionReferences
    ? await resolveCodexSubscriptionCredentials(
        args,
        subscriptionReferences,
        signal,
      )
    : null;
  const decrypted = subscriptionReferences
    ? { ok: true as const, value: null }
    : await settle(
        decryptPersistentSecretsMap(executionContext.encryptedSecrets, {
          userId: args.activation.userId,
          orgId: args.activation.orgId,
        }),
      );
  if (!decrypted.ok) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn encrypted model credentials are invalid",
      decrypted.error,
    );
  }
  const secrets: Record<string, string> | null = decrypted.value;
  return await materializePiExecutionRoute({
    route: modelConfig,
    target: "direct",
    async resolveCredential(binding: PiAgentCredentialReference) {
      let value = subscriptionCredentials?.get(binding.secretName);
      if (subscriptionCredentials && !value) {
        throw piApiFirstTurnError(
          "PI_API_MODEL_CREDENTIAL_INVALID",
          "Pi API first-turn subscription credential binding is invalid",
        );
      }
      value ??= secrets?.[binding.secretName];
      const providerKey =
        executionContext.secretConnectorMap?.[binding.secretName];
      const metadata =
        executionContext.secretConnectorMetadataMap?.[binding.secretName];
      if (
        (modelConfig.dialect === "anthropic-messages" ||
          modelConfig.dialect === "bedrock-converse-stream") &&
        providerKey === "claude-code-oauth-token"
      ) {
        throw piApiFirstTurnError(
          "PI_API_MODEL_CREDENTIAL_INVALID",
          "Claude subscription credentials cannot be used by Pi",
        );
      }
      if (!value && providerKey && metadata) {
        const resolved = await settle(
          resolveModelProviderRuntimeSecretForApi({
            db: args.db,
            orgId: args.activation.orgId,
            userId: args.activation.userId,
            key: binding.secretName,
            providerKey,
            metadata,
            featureSwitchContext: {
              userId: args.activation.userId,
              orgId: args.activation.orgId,
            },
          }),
        );
        if (!resolved.ok) {
          throw piApiFirstTurnError(
            "PI_API_MODEL_CREDENTIAL_INVALID",
            "Pi API first-turn model credential lookup failed",
            resolved.error,
          );
        }
        value = resolved.value ?? undefined;
      }
      if (!value?.trim()) {
        throw piApiFirstTurnError(
          "PI_API_MODEL_CREDENTIAL_INVALID",
          "Pi API first-turn model credential is unavailable",
        );
      }
      return value;
    },
  });
}

async function recordApiFirstTurnUsage(
  context: ApiFirstTurnModelContext,
  turn: PiApiFirstTurnResult,
): Promise<void> {
  const { activation } = context;
  await recordPiApiFirstTurnUsage(context.db, {
    runId: activation.runId,
    orgId: activation.orgId,
    userId: activation.userId,
    billableFirewalls: activation.executionContext.billableFirewalls,
    modelUsageProvider: activation.executionContext.modelUsageProvider,
    piProvider: context.route.provider,
    // Adapt captured native meaning to the unchanged billing input contract.
    // This object is not persisted or forwarded as a launch/claim payload.
    nativeModelConfig:
      context.route.dialect === "anthropic-messages" ||
      context.route.dialect === "bedrock-converse-stream"
        ? { ...context.route, schemaVersion: 4 }
        : undefined,
    requestedServiceTier: context.route.serviceTier,
    turn,
  });
}

/** Early credential materialization does not retain a revoked provider grant. */
async function validateApiFirstTurnCredentialSources(
  args: ApiFirstTurnModelContext,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const executionContext = args.activation.executionContext;
  const subscriptionReferences = codexSubscriptionCredentialReferences({
    activation: args.activation,
    executionContext,
    route: args.route,
  });
  if (subscriptionReferences) {
    const state = await settle(
      readModelProviderRuntimeReconnectStateForApi(
        runtimeCredentialLookupArgs(args, subscriptionReferences.accessToken),
      ),
    );
    signal.throwIfAborted();
    if (!state.ok) {
      throw piApiFirstTurnError(
        "PI_API_MODEL_CREDENTIAL_INVALID",
        "Pi API first-turn subscription access token lookup failed",
        state.error,
      );
    }
    if (
      state.value?.needsReconnect &&
      isTerminalChatgptRefreshErrorCode(state.value.lastRefreshErrorCode)
    ) {
      throw new PiApiFirstTurnCodexReconnectRequiredError();
    }
    if (!state.value) {
      throw piApiFirstTurnError(
        "PI_API_MODEL_CREDENTIAL_INVALID",
        "Pi API first-turn subscription access token is unavailable",
        undefined,
        "reconnect_required",
      );
    }
  }
  for (const binding of args.route.credentialBindings) {
    const providerKey =
      executionContext.secretConnectorMap?.[binding.secretName];
    const metadata =
      executionContext.secretConnectorMetadataMap?.[binding.secretName];
    if (!providerKey || metadata?.sourceType !== "model-provider") {
      continue;
    }
    const resolved = await settle(
      resolveModelProviderRuntimeSecretForApi({
        db: args.db,
        orgId: args.activation.orgId,
        userId: args.activation.userId,
        key: binding.secretName,
        providerKey,
        metadata,
        featureSwitchContext: {
          userId: args.activation.userId,
          orgId: args.activation.orgId,
        },
      }),
    );
    signal.throwIfAborted();
    if (!resolved.ok) {
      throw piApiFirstTurnError(
        "PI_API_MODEL_CREDENTIAL_INVALID",
        "Pi API first-turn model credential lookup failed",
        resolved.error,
      );
    }
    if (!resolved.value?.trim()) {
      throw piApiFirstTurnError(
        "PI_API_MODEL_CREDENTIAL_INVALID",
        "Pi API first-turn model credential is unavailable",
        undefined,
        subscriptionReferences ? "reconnect_required" : undefined,
      );
    }
  }
}

async function observeDiscardedProviderResult(
  operation: Promise<PiApiFirstTurnResult>,
  args: ApiFirstTurnModelContext,
  ownership: PiApiFirstTurnOwnership,
  reason: "api_attempt_timed_out" | "aborted_execution",
): Promise<void> {
  const late = await settleIncludingAbort(operation);
  if (late.ok) {
    L.info("Pi API first-turn outcome", {
      runId: args.activation.runId,
      ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
      outcome: "discarded_late_provider_result",
      reason,
      ownershipStage: ownership.stage,
    });
    await recordApiFirstTurnUsage(args, late.value);
  }
}

async function discardCompletedProviderResult(
  turn: PiApiFirstTurnResult,
  args: ApiFirstTurnModelContext,
  ownership: PiApiFirstTurnOwnership,
): Promise<void> {
  L.info("Pi API first-turn outcome", {
    runId: args.activation.runId,
    ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
    outcome: "discarded_late_provider_result",
    reason: "api_attempt_timed_out",
    ownershipStage: ownership.stage,
  });
  await recordApiFirstTurnUsage(args, turn);
}

function validateApiModelTurnOutcome(turn: PiApiFirstTurnResult): void {
  if (turn.assistantMessage.stopReason === "length" && !turn.handoffRequired) {
    throw piApiFirstTurnError(
      "PI_API_MODEL_OUTPUT_INCOMPLETE",
      "Pi API first-turn model output is incomplete",
    );
  }
  if (
    turn.assistantMessage.stopReason === "error" ||
    turn.assistantMessage.stopReason === "aborted"
  ) {
    throw new PiApiFirstTurnModelFailureError(
      turn.assistantMessage.failureDiagnostic,
      turn.assistantMessage.failureReason,
    );
  }
}

interface ExecuteApiModelTurnArgs {
  readonly onPreparationTiming: PiPreparationObserver;
  readonly activation: PiApiFirstTurnActivation;
  readonly context: ApiFirstTurnModelContext;
  readonly commitIdentity: ApiFirstTurnCommitIdentity;
  readonly runtime: PreparedPiApiTurn;
  readonly startedAt: number;
  readonly ownership: PiApiFirstTurnOwnership;
}

async function acquireApiProviderOwnership(
  args: ExecuteApiModelTurnArgs,
  markProviderRequestMayHaveStarted: () => void,
  signal: AbortSignal,
): Promise<void> {
  const finish = startPiPreparationObservation(
    args.onPreparationTiming,
    "provider_boundary",
    signal,
  );
  await onRejection(
    withApiFirstTurnLifecycle(args.context, async (tx) => {
      signal.throwIfAborted();
      const state = validateApiFirstTurnApiCommit(
        args.context,
        await readApiFirstTurnLifecycleState(tx, args.activation.runId),
        args.commitIdentity,
        "Pi API first turn lost eligibility before provider ownership",
      );
      if (state.activeDeliveryId) {
        throw new PiApiFirstTurnActiveInputBeforeProviderError();
      }
      signal.throwIfAborted();
      markProviderRequestMayHaveStarted();
    }),
    (error) => {
      finish(
        error instanceof PiApiFirstTurnCanonicalCancellationError
          ? "cancelled"
          : "error",
      );
    },
  );
  finish("success");
}

async function executeApiModelTurn(
  args: ExecuteApiModelTurnArgs,
  signal: AbortSignal,
): Promise<{
  readonly startedAt: number;
  readonly turn: PiApiFirstTurnResult;
}> {
  // Use the captured source, never the active account. Revalidation neither
  // refreshes credentials nor changes the prepared runtime, and stays outside
  // the lifecycle lock that owns the final provider transition.
  await validateApiFirstTurnCredentialSources(args.context, signal);
  const modelDeadline =
    apiFirstTurnApiDeadlineAt(args.activation.executionContext) -
    MODEL_COMMIT_BUDGET_MS;
  if (now() >= modelDeadline) {
    throw piApiFirstTurnError(
      "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
      "Pi API first turn has no remaining model commit budget",
    );
  }
  const startedAt = args.startedAt;
  const modelDeadlineSignal = AbortSignal.timeout(
    Math.max(1, modelDeadline - now()),
  );
  const modelSignal = AbortSignal.any([signal, modelDeadlineSignal]);
  const operation = executePreparedPiApiTurn(
    args.runtime,
    {
      ownership: args.ownership,
      providerRequestBoundary: async (markProviderRequestMayHaveStarted) => {
        await acquireApiProviderOwnership(
          args,
          markProviderRequestMayHaveStarted,
          modelSignal,
        );
      },
    },
    modelSignal,
  );
  const executed = await settleIncludingAbort(
    awaitWithSignal(operation, modelSignal),
  );
  if (!executed.ok) {
    if (modelSignal.aborted) {
      waitUntil(
        observeDiscardedProviderResult(
          operation,
          args.context,
          args.ownership,
          modelDeadlineSignal.aborted
            ? "api_attempt_timed_out"
            : "aborted_execution",
        ),
      );
    }
    if (
      executed.error instanceof PiApiFirstTurnError ||
      executed.error instanceof PiApiFirstTurnActiveInputBeforeProviderError ||
      executed.error instanceof PiApiFirstTurnCanonicalCancellationError
    ) {
      throw executed.error;
    }
    if (
      !modelSignal.aborted &&
      executed.error instanceof PiApiModelRequestError
    ) {
      throw new PiApiFirstTurnModelFailureError(
        executed.error.diagnostic,
        executed.error.failureReason,
      );
    }
    throw piApiFirstTurnError(
      modelSignal.aborted
        ? "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
        : "PI_API_MODEL_FAILED",
      modelSignal.aborted
        ? "Pi API first-turn model deadline elapsed"
        : "Pi API first-turn model request failed",
      executed.error,
    );
  }
  const turn = executed.value;
  if (now() >= modelDeadline) {
    waitUntil(
      discardCompletedProviderResult(turn, args.context, args.ownership),
    );
    throw piApiFirstTurnError(
      "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
      "Pi API first-turn provider result arrived after its commit deadline",
    );
  }
  await recordApiFirstTurnUsage(args.context, turn);
  validateApiModelTurnOutcome(turn);
  return { startedAt, turn };
}

function validateApiFirstTurnH1(
  turn: PiApiFirstTurnResult,
  sessionId: string,
): { readonly sessionBytes: Buffer; readonly sessionHash: string } {
  const sessionBytes = Buffer.from(turn.sessionJsonl, "utf8");
  if (
    sessionBytes.length === 0 ||
    sessionBytes.length > PI_API_FIRST_TURN_SESSION_MAX_BYTES
  ) {
    throw piApiFirstTurnError(
      "PI_H1_TOO_LARGE",
      "Pi H1 is empty or exceeds the API first-turn limit",
    );
  }
  const parsed = safeSync(() => {
    return inspectPiSessionJsonl(turn.sessionJsonl);
  });
  if ("error" in parsed) {
    throw piApiFirstTurnError(
      "PI_H1_INVALID",
      "Pi API first turn produced an invalid H1 session",
      parsed.error,
    );
  }
  const committedSession = parsed.ok;
  if (committedSession.sessionId !== sessionId) {
    throw piApiFirstTurnError(
      "PI_H1_INVALID",
      "Pi H1 session id does not match the launch session",
    );
  }
  if (
    (turn.handoffRequired && !committedSession.hasPendingToolCalls) ||
    (!turn.handoffRequired && !committedSession.isSettledCheckpoint)
  ) {
    throw piApiFirstTurnError(
      "PI_H1_INVALID",
      "Pi H1 state does not match the API first-turn outcome",
    );
  }
  return { sessionBytes, sessionHash: sha256(sessionBytes) };
}

function ownershipTransferManifest(args: {
  readonly mode: PiApiFirstTurnOwnershipTransferMode;
  readonly baseSession: PiApiFirstTurnManifest["baseSession"];
  readonly session: {
    readonly sessionId: string;
    readonly sha256: string;
    readonly rawSize: number;
  };
  readonly sandboxEventSequenceStart: number;
}): PiApiFirstTurnManifest {
  return {
    schemaVersion: 3,
    outcome: "ownership-transfer",
    mode: args.mode,
    baseSession: args.baseSession,
    session: args.session,
    sandboxEventSequenceStart: args.sandboxEventSequenceStart,
  };
}

function validateSandboxFallbackSession(
  sessionJsonl: string,
  sessionId: string,
): { readonly bytes: Buffer; readonly hash: string } {
  const bytes = Buffer.from(sessionJsonl, "utf8");
  if (
    bytes.length === 0 ||
    bytes.length > PI_API_FIRST_TURN_SESSION_MAX_BYTES
  ) {
    throw piApiFirstTurnError(
      "PI_H0_TOO_LARGE",
      "Pi sandbox fallback H0 is empty or exceeds the API first-turn limit",
    );
  }
  const inspected = safeSync(() => {
    return inspectPiSessionJsonl(sessionJsonl);
  });
  if ("error" in inspected) {
    throw piApiFirstTurnError(
      "PI_H0_JSONL_INVALID",
      "Pi sandbox fallback H0 is not a valid native Pi session",
      inspected.error,
    );
  }
  if (inspected.ok.sessionId !== sessionId) {
    throw piApiFirstTurnError(
      "PI_H0_SESSION_MISMATCH",
      "Pi sandbox fallback H0 session id does not match the launch session",
    );
  }
  return { bytes, hash: sha256(bytes) };
}

function materializeApiFirstTurnH0(args: {
  readonly apiStartTime: number;
  readonly loadedSession: LoadedResumeSession;
  readonly sessionId: string;
}): string {
  return (
    args.loadedSession.jsonl ??
    createPiSessionJsonl({
      cwd: CANONICAL_WORKING_DIR,
      sessionId: args.sessionId,
      timestamp: new Date(args.apiStartTime).toISOString(),
    })
  );
}

/**
 * Runtime ownership recovery for pre-commit preparation, model or deadline
 * failure. Reconstruct validated H0; never publish a failed/partial API turn.
 */
const publishSandboxFallback$ = command(async function publishSandboxFallback(
  { get, set },
  args: ApiFirstTurnContext,
  reason: PiSandboxFirstReason,
  signal: AbortSignal,
): Promise<void> {
  const { executionContext, launchConfig, sessionId } =
    validateApiFirstTurnLaunch(args);
  const commitIdentity = apiFirstTurnCommitIdentity(args);
  signal.throwIfAborted();
  await withApiFirstTurnLifecycle(args, async (tx) => {
    signal.throwIfAborted();
    const state = validateApiFirstTurnHandoffCommit(
      args,
      await readApiFirstTurnLifecycleState(tx, args.activation.runId),
      commitIdentity,
      "Pi sandbox-first transfer lost commit eligibility",
    );
    if (reason === "active_input" && !state.activeDeliveryId) {
      throw piApiFirstTurnError(
        "PI_API_FIRST_TURN_NOT_COMMITTABLE",
        "Pi active-input sandbox-first transfer lost its durable delivery",
      );
    }
    const loadedSession = await set(
      loadResumeSessionJsonl$,
      {
        db: args.db,
        resumeSession: executionContext.resumeSession,
      },
      signal,
    );
    validateResumeSession({
      loaded: loadedSession,
      expectedBaseSession: launchConfig.baseSession,
      sessionId,
    });
    const sessionJsonl = materializeApiFirstTurnH0({
      apiStartTime: executionContext.apiStartTime,
      loadedSession,
      sessionId,
    });
    const session = validateSandboxFallbackSession(sessionJsonl, sessionId);
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const sessionKey = piApiFirstTurnObjectKey(
      args.activation.runId,
      "session",
    );
    await get(
      putS3Object(
        bucket,
        sessionKey,
        session.bytes,
        "application/x-ndjson",
        signal,
      ),
    );
    signal.throwIfAborted();
    const uploaded = await get(
      downloadS3BufferWithMaxBytes(
        bucket,
        sessionKey,
        session.bytes.length,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (
      uploaded.length !== session.bytes.length ||
      sha256(uploaded) !== session.hash
    ) {
      throw piApiFirstTurnError(
        "PI_API_SANDBOX_FALLBACK_FAILED",
        "Pi sandbox fallback H0 failed read-after-write validation",
      );
    }
    validateApiFirstTurnHandoffCommit(
      args,
      state,
      commitIdentity,
      "Pi sandbox-first transfer lost commit eligibility before publication",
    );
    const manifest = ownershipTransferManifest({
      mode: "sandbox-first",
      baseSession: launchConfig.baseSession,
      session: {
        sessionId,
        sha256: session.hash,
        rawSize: session.bytes.length,
      },
      sandboxEventSequenceStart: launchConfig.sandboxEventSequenceStart,
    });
    await set(
      writeManifest$,
      { runId: args.activation.runId, manifest },
      signal,
    );
  });
});

async function disposeLateApiFirstTurnRuntime(
  initialization: Promise<PreparedPiApiTurn>,
): Promise<void> {
  const late = await settleIncludingAbort(initialization);
  if (late.ok) {
    late.value.dispose();
  }
}

async function initializeApiFirstTurnRuntime(
  runtimeArgs: Parameters<typeof preparePiApiTurn>[0],
  apiDeadlineAt: number,
  signal: AbortSignal,
): Promise<PiApiFirstTurnPreparedInputs> {
  const modelDeadline = apiDeadlineAt - MODEL_COMMIT_BUDGET_MS;
  if (now() >= modelDeadline) {
    throw piApiFirstTurnError(
      "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
      "Pi API first turn has no remaining model commit budget",
    );
  }
  const modelSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, modelDeadline - now())),
  ]);
  const startedAt = now();
  const initialization = preparePiApiTurn(runtimeArgs, modelSignal);
  const initialized = await settleIncludingAbort(
    awaitWithSignal(initialization, modelSignal),
  );
  if (!initialized.ok) {
    if (modelSignal.aborted) {
      waitUntil(disposeLateApiFirstTurnRuntime(initialization));
      throw piApiFirstTurnError(
        "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
        "Pi API first-turn model deadline elapsed",
        initialized.error,
      );
    }
    if (initialized.error instanceof UnsupportedPiResourceSnapshotError) {
      throw piApiFirstTurnError(
        "PI_API_PREHEAT_FAILED",
        initialized.error.message,
        initialized.error,
      );
    }
    if (initialized.error instanceof PiApiFirstTurnCompactionRequiredError) {
      throw piApiFirstTurnError(
        "PI_API_COMPACTION_PREFLIGHT_REQUIRED",
        "Pi H0 requires official Sandbox compaction preflight",
        initialized.error,
      );
    }
    throw initialized.error;
  }
  return { kind: "api", runtime: initialized.value, startedAt };
}

async function resolveApiFirstTurnResourcesAndModel(
  resources: Promise<PiResourceSnapshot>,
  credentials: Promise<PiAgentModelConfig>,
  signal: AbortSignal,
): Promise<{
  readonly resourceSnapshot: PiResourceSnapshot;
  readonly model: PiAgentModelConfig;
}> {
  const credentialResult = settleIncludingAbort(credentials);
  const resourceResult = await settleIncludingAbort(resources);
  if (!resourceResult.ok) {
    // The sibling cannot replace the original resource failure or extend its
    // decision boundary. Its result remains observed and owned until settled.
    waitUntil(credentialResult);
    throw resourceResult.error;
  }
  signal.throwIfAborted();
  const resolvedCredential = await credentialResult;
  if (!resolvedCredential.ok) {
    throw resolvedCredential.error;
  }
  signal.throwIfAborted();
  const resourceSnapshot = resourceResult.value;
  const model = resolvedCredential.value;
  return { resourceSnapshot, model };
}

const prepareApiFirstTurnInputs$ = command(
  async function prepareApiFirstTurnInputs(
    { set },
    args: ApiFirstTurnContext,
    signal: AbortSignal,
  ): Promise<PiApiFirstTurnPreparedInputs> {
    const { executionContext, launchConfig, sessionId } =
      validateApiFirstTurnLaunch(args);
    signal.throwIfAborted();
    const resumeSession = executionContext.resumeSession;
    if (resumeSession && "historyRef" in resumeSession) {
      const metadata = await measurePiPreparation(
        piPreparationObserver(args.activation.runId),
        "h0_metadata_preflight",
        () => {
          return readResumeSessionMetadata(
            args.db,
            resumeSession.historyRef,
            signal,
          );
        },
        signal,
      );
      if (decideApiFirstTurnHistory(metadata) !== "api") {
        return { kind: "large-history" };
      }
    }
    // The direct API model turn cannot run native input/skill expansion. Choose
    // AgentSession before API-only preparation; handoff must keep the input intact.
    if (args.activation.prompt.trimStart().startsWith("/")) {
      throw piApiFirstTurnError(
        "PI_API_NATIVE_INPUT_REQUIRED",
        "Pi slash-prefixed input requires native AgentSession processing",
      );
    }
    const onPreparationTiming = piPreparationObserver(args.activation.runId);
    const resources = measurePiPreparation(
      onPreparationTiming,
      "resource_snapshot",
      () => {
        return set(
          loadApiFirstTurnResource$,
          args,
          executionContext,
          launchConfig.resourceSnapshotDigest,
          signal,
        );
      },
      signal,
    );
    const modelContext: ApiFirstTurnModelContext = {
      ...args,
      route: normalizePiExecutionRoute(executionContext.piModelConfig),
    };
    const credentials = measurePiPreparation(
      onPreparationTiming,
      "credentials_route",
      () => {
        return apiFirstTurnModelConfig(modelContext, executionContext, signal);
      },
      signal,
    );
    const { resourceSnapshot, model } =
      await resolveApiFirstTurnResourcesAndModel(
        resources,
        credentials,
        signal,
      );
    signal.throwIfAborted();
    const loadedSession = await measurePiPreparation(
      onPreparationTiming,
      "h0_load",
      () => {
        return set(
          loadResumeSessionJsonl$,
          {
            db: args.db,
            resumeSession: executionContext.resumeSession,
          },
          signal,
        );
      },
      signal,
    );
    const sessionJsonl = measurePiPreparationSync(
      onPreparationTiming,
      "h0_validate_materialize",
      () => {
        validateResumeSession({
          loaded: loadedSession,
          expectedBaseSession: launchConfig.baseSession,
          sessionId,
        });
        return materializeApiFirstTurnH0({
          apiStartTime: executionContext.apiStartTime,
          loadedSession,
          sessionId,
        });
      },
      signal,
    );
    return await initializeApiFirstTurnRuntime(
      {
        cwd: CANONICAL_WORKING_DIR,
        agentDir: PI_AGENT_DIR,
        sessionId,
        sessionJsonl,
        prompt: args.activation.prompt,
        appendSystemPrompt: args.activation.appendSystemPrompt,
        model,
        resourceSnapshot,
        onPreparationTiming,
        onMemoryRecallOutcome(outcome) {
          L.debug("Pi memory recall outcome", {
            runId: args.activation.runId,
            ...outcome,
          });
        },
      },
      apiFirstTurnApiDeadlineAt(executionContext),
      signal,
    );
  },
);

const startApiFirstTurnPreparation$ = command(
  (
    { set },
    activation: PiApiFirstTurnActivation,
    parentSignal?: AbortSignal,
  ): PiApiFirstTurnPreparation => {
    const startedAt = now();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(parentSignal ? [parentSignal] : []),
      AbortSignal.timeout(
        Math.max(
          1,
          apiFirstTurnApiDeadlineAt(activation.executionContext) - now(),
        ),
      ),
    ]);
    return new PiApiFirstTurnPreparation(
      activation,
      controller,
      set(
        prepareApiFirstTurnInputs$,
        { db: set(writeDb$), activation },
        signal,
      ),
      signal,
      startedAt,
    );
  },
);

/** Only the authorized creator calls this entry with complete captured inputs. */
export const prepareCreatedPiApiFirstTurn$ = command(
  (
    { set },
    input: CreatorAuthorizedPiPreparation,
  ): PiApiFirstTurnPreparation => {
    if (input.triggerSource === "goal") {
      throw new Error("Unsupported Pi preparation source");
    }
    return set(startApiFirstTurnPreparation$, input.activation);
  },
);

const executePreparedApiFirstTurn$ = command(
  async function executePreparedApiFirstTurn(
    _ctx,
    args: ApiFirstTurnContext,
    ownership: PiApiFirstTurnOwnership,
    inputs: Extract<PiApiFirstTurnPreparedInputs, { readonly kind: "api" }>,
    signal: AbortSignal,
  ): Promise<PreparedApiFirstTurn> {
    const { executionContext, launchConfig, sessionId } =
      validateApiFirstTurnLaunch(args);
    const commitIdentity = apiFirstTurnCommitIdentity(args);
    const modelContext: ApiFirstTurnModelContext = {
      ...args,
      route: normalizePiExecutionRoute(executionContext.piModelConfig),
    };
    const onPreparationTiming = piPreparationObserver(args.activation.runId);
    const { startedAt, turn } = await executeApiModelTurn(
      {
        activation: args.activation,
        context: modelContext,
        commitIdentity,
        runtime: inputs.runtime,
        startedAt: inputs.startedAt,
        ownership,
        onPreparationTiming,
      },
      signal,
    );
    signal.throwIfAborted();
    const { sessionBytes, sessionHash } = validateApiFirstTurnH1(
      turn,
      sessionId,
    );
    signal.throwIfAborted();
    const auth: SandboxAuth = {
      userId: args.activation.userId,
      orgId: args.activation.orgId,
      runId: args.activation.runId,
    };
    return {
      apiStartTime: executionContext.apiStartTime,
      auth,
      baseSession: launchConfig.baseSession,
      commitIdentity,
      sessionBytes,
      sessionHash,
      sessionId,
      startedAt,
      turn,
    };
  },
);

const persistCompleteTurnCheckpoint$ = command(
  async function persistCompleteTurnCheckpoint(
    { set },
    args: ApiFirstTurnContext,
    prepared: PreparedApiFirstTurn,
    signal: AbortSignal,
  ): Promise<void> {
    await set(
      persistIdentitySessionBlob$,
      {
        db: args.db,
        hash: prepared.sessionHash,
        bytes: prepared.sessionBytes,
      },
      signal,
    );
    const checkpoint = await set(
      createPiApiFirstTurnCheckpoint$,
      {
        auth: prepared.auth,
        body: {
          runId: args.activation.runId,
          cliAgentType: "pi",
          cliAgentSessionId: prepared.sessionId,
          cliAgentSessionHistoryHash: prepared.sessionHash,
        },
      },
      signal,
    );
    if (checkpoint.status !== 200) {
      throw new Error("Pi API first-turn checkpoint was rejected");
    }
  },
);

const finalizeCompleteTurn$ = command(async function finalizeCompleteTurn(
  { set },
  args: ApiFirstTurnContext,
  prepared: PreparedApiFirstTurn,
  lastEventSequence: number,
  signal: AbortSignal,
): Promise<CompleteSideEffectsInput | undefined> {
  const completion = await set(
    completeAgentRun$,
    {
      auth: prepared.auth,
      executionOwner: "api-first",
      body: {
        runId: args.activation.runId,
        exitCode: 0,
        lastEventSequence,
      },
    },
    signal,
  );
  if (completion.status !== 200) {
    throw new Error("Pi API first-turn completion was rejected");
  }
  return completion.sideEffects;
});

function stopPreparedSandbox(
  activation: PiApiFirstTurnActivation,
  terminalStatus: "completed" | "failed",
): void {
  waitUntil(
    tapError(
      publishCancelToRunnerGroup(
        activation.runnerGroup,
        activation.runId,
        "hard",
      ),
      (error) => {
        L.warn("Failed to stop the prepared Pi Sandbox after API terminal", {
          runId: activation.runId,
          terminalStatus,
          error,
        });
      },
    ),
  );
}

const commitApiFirstTurn$ = command(async function commitApiFirstTurn(
  { get, set },
  args: ApiFirstTurnContext,
  prepared: PreparedApiFirstTurn,
  commitProgress: ApiFirstTurnCommitProgress,
  signal: AbortSignal,
): Promise<ApiFirstTurnExecutionResult> {
  return await withApiFirstTurnLifecycle(args, async (tx) => {
    signal.throwIfAborted();
    const state = validateApiFirstTurnApiCommit(
      args,
      await readApiFirstTurnLifecycleState(tx, args.activation.runId),
      prepared.commitIdentity,
      "Pi API first turn lost commit eligibility after the provider request",
    );
    // Once any H1 commit side effect can begin, a later timeout must fail
    // terminally instead of replaying H0 over potentially published state.
    commitProgress.started = true;
    const transition = decideApiFirstTurnCommit({
      pendingTools: prepared.turn.handoffRequired,
      activeInput: state.activeDeliveryId !== null,
    });

    await get(
      putS3Object(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        piApiFirstTurnObjectKey(args.activation.runId, "session"),
        prepared.sessionBytes,
        "application/x-ndjson",
        signal,
      ),
    );
    signal.throwIfAborted();

    const blockEvents = piApiFirstTurnAssistantEvents(
      args.activation.runId,
      prepared.turn.assistantMessage,
    );
    const nextSequenceNumber = blockEvents.length;
    if (
      transition.outcome === "transfer" &&
      nextSequenceNumber < prepared.commitIdentity.sandboxEventSequenceStart
    ) {
      throw piApiFirstTurnError(
        "PI_LAUNCH_CONFIG_INVALID",
        "Pi API first-turn event boundary precedes the immutable Sandbox boundary",
      );
    }
    const events =
      transition.outcome === "transfer"
        ? blockEvents
        : [
            ...blockEvents,
            piApiFirstTurnResultEvent(
              prepared.turn.assistantMessage,
              prepared.startedAt,
              nextSequenceNumber,
              now(),
            ),
          ];
    await set(publishEvents$, { auth: prepared.auth, events }, signal);
    if (transition.outcome === "transfer") {
      const manifest = ownershipTransferManifest({
        mode: transition.mode,
        baseSession: prepared.baseSession,
        session: {
          sessionId: prepared.sessionId,
          sha256: prepared.sessionHash,
          rawSize: prepared.sessionBytes.length,
        },
        sandboxEventSequenceStart: nextSequenceNumber,
      });
      await set(
        writeManifest$,
        { runId: args.activation.runId, manifest },
        signal,
      );
      L.debug("Pi API first-turn outcome", {
        runId: args.activation.runId,
        ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
        handoffOwner: "sandbox",
        outcome: "ownership_transfer",
        reason: transition.reason,
        ownershipStage: "provider-may-have-started",
      });
      return { outcome: "transferred" };
    }

    await set(persistCompleteTurnCheckpoint$, args, prepared, signal);
    const sideEffects = await set(
      finalizeCompleteTurn$,
      args,
      prepared,
      nextSequenceNumber,
      signal,
    );
    stopPreparedSandbox(args.activation, "completed");
    L.debug("Pi API first-turn outcome", {
      runId: args.activation.runId,
      ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
      outcome: "api_completion",
      reason: "settled_session",
      ownershipStage: "provider-may-have-started",
    });
    return { outcome: "completed", sideEffects };
  });
});

// This is an execution-budget decision before API-first resource or history IO.
// The original checkpoint remains authoritative; the sandbox validates its bytes.
const publishLargeHistoryTransfer$ = command(
  async function publishLargeHistoryTransfer(
    { get, set },
    args: ApiFirstTurnContext,
    commitProgress: ApiFirstTurnCommitProgress,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { executionContext, launchConfig, sessionId } =
      validateApiFirstTurnLaunch(args);
    const resumeSession = executionContext.resumeSession;
    if (!resumeSession || !("historyRef" in resumeSession)) {
      return false;
    }
    const metadata = await measurePiPreparation(
      piPreparationObserver(args.activation.runId),
      "h0_metadata_preflight",
      () => {
        return readResumeSessionMetadata(
          args.db,
          resumeSession.historyRef,
          signal,
        );
      },
      signal,
    );
    if (decideApiFirstTurnHistory(metadata) === "api") {
      return false;
    }
    const hash = resumeSession.historyRef.hash;
    if (
      resumeSession.sessionId !== sessionId ||
      launchConfig.baseSession.sessionId !== sessionId ||
      launchConfig.baseSession.sha256 !== hash
    ) {
      throw piApiFirstTurnError(
        "PI_H0_HASH_MISMATCH",
        "Pi H0 does not match the launch base checkpoint",
      );
    }
    const commitIdentity = apiFirstTurnCommitIdentity(args);
    return await withApiFirstTurnLifecycle(args, async (tx) => {
      signal.throwIfAborted();
      const state = validateApiFirstTurnHandoffCommit(
        args,
        await readApiFirstTurnLifecycleState(tx, args.activation.runId),
        commitIdentity,
        "Pi large-history transfer lost commit eligibility",
      );
      const url = await get(
        generatePresignedGetUrl(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          resumeSessionHistoryBlobKey(hash, metadata.encoding),
          PI_API_FIRST_TURN_URL_TTL_SECONDS,
          undefined,
          true,
        ),
      );
      signal.throwIfAborted();
      validateApiFirstTurnHandoffCommit(
        args,
        state,
        commitIdentity,
        "Pi large-history transfer lost commit eligibility before publication",
      );
      // Publication may transfer ownership even if its response is lost.
      commitProgress.started = true;
      await set(
        writeManifest$,
        {
          runId: args.activation.runId,
          manifest: {
            schemaVersion: 4,
            outcome: "ownership-transfer",
            mode: "sandbox-first",
            baseSession: launchConfig.baseSession,
            session: { sessionId, sha256: hash, rawSize: metadata.rawSize },
            history: {
              url,
              encoding: metadata.encoding,
              encodedSize: metadata.encodedSize,
            },
            sandboxEventSequenceStart: launchConfig.sandboxEventSequenceStart,
          },
        },
        signal,
      );
      L.debug("Pi API first-turn outcome", {
        runId: args.activation.runId,
        ...piApiFirstTurnOutcomeTelemetry(executionContext),
        outcome: "ownership_transfer",
        reason: "history_exceeds_api_budget",
        handoffOwner: "sandbox",
        ownershipStage: "pre-provider",
        rawSize: metadata.rawSize,
        encodedSize: metadata.encodedSize,
      });
      return true;
    });
  },
);

const executeApiFirstTurn$ = command(async function executeApiFirstTurn(
  { set },
  args: ApiFirstTurnContext,
  attempt: {
    readonly ownership: PiApiFirstTurnOwnership;
    readonly commitProgress: ApiFirstTurnCommitProgress;
    readonly preparation: PiApiFirstTurnPreparation;
  },
  signal: AbortSignal,
): Promise<ApiFirstTurnExecutionResult> {
  const { ownership, commitProgress, preparation } = attempt;
  const inputs = await preparation.take(args.activation, signal);
  signal.throwIfAborted();
  if (inputs.kind === "large-history") {
    await set(publishLargeHistoryTransfer$, args, commitProgress, signal);
    return { outcome: "transferred" };
  }
  const prepared = await set(
    executePreparedApiFirstTurn$,
    args,
    ownership,
    inputs,
    signal,
  ).finally(() => {
    inputs.runtime.dispose();
  });
  signal.throwIfAborted();
  const committed = await settle(
    set(commitApiFirstTurn$, args, prepared, commitProgress, signal),
    signal,
  );
  if (!committed.ok) {
    if (
      committed.error instanceof PiApiFirstTurnError ||
      committed.error instanceof PiApiFirstTurnCanonicalCancellationError
    ) {
      throw committed.error;
    }
    throw piApiFirstTurnError(
      "PI_API_COMMIT_FAILED",
      "Pi API first-turn H1 commit failed",
      committed.error,
    );
  }
  return committed.value;
});

async function settleApiFirstTurnExecution<T>(
  execution: Promise<T>,
  executionSignal: AbortSignal,
  coordinationSignal: AbortSignal,
) {
  const executed = await settleIncludingAbort(execution);
  if (executed.ok || !executionSignal.aborted) {
    return executed;
  }
  return {
    ok: false as const,
    error:
      executionSignal.reason ?? coordinationSignal.reason ?? executed.error,
  };
}

function piApiFirstTurnHandoffSignal(
  activation: PiApiFirstTurnActivation,
  coordinationSignal: AbortSignal,
): AbortSignal {
  const coordinationDeadlineAt =
    activation.executionContext.piLaunchConfig.apiFirstTurn.deadlineAt;
  return AbortSignal.any([
    coordinationSignal,
    AbortSignal.timeout(Math.max(1, coordinationDeadlineAt - now())),
  ]);
}

async function canonicalApiFirstTurnCancellationWon(
  args: ApiFirstTurnContext,
): Promise<boolean> {
  return await withApiFirstTurnLifecycle(args, async (tx) => {
    const state = await readApiFirstTurnLifecycleState(
      tx,
      args.activation.runId,
    );
    return state?.status === "cancelled";
  });
}

function logCanonicalApiFirstTurnCancellation(
  args: ApiFirstTurnContext,
  ownership: PiApiFirstTurnOwnership,
  failure?: unknown,
): void {
  if (
    failure instanceof PiApiFirstTurnCanonicalCancellationError &&
    ownership.stage === "provider-may-have-started"
  ) {
    L.info("Pi API first-turn outcome", {
      runId: args.activation.runId,
      ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
      outcome: "discarded_late_provider_result",
      reason: "canonical_cancellation",
      ownershipStage: ownership.stage,
    });
  }
  L.debug("Pi API first-turn outcome", {
    runId: args.activation.runId,
    ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
    outcome: "canonical_cancellation",
    reason:
      ownership.stage === "pre-provider"
        ? "canonical_cancellation_before_provider_ownership"
        : "canonical_cancellation_after_provider_ownership",
    ownershipStage: ownership.stage,
  });
}

function logApiFirstTurnAttemptTimedOut(
  activation: PiApiFirstTurnActivation,
  ownership: PiApiFirstTurnOwnership,
  failure: PiApiFirstTurnError,
): void {
  L.info("Pi API first-turn outcome", {
    runId: activation.runId,
    ...piApiFirstTurnOutcomeTelemetry(activation.executionContext),
    outcome: "api_attempt_timed_out",
    reason: failure.code,
    ownershipStage: ownership.stage,
  });
}

function sandboxFirstPublicationOutcome(reason: PiSandboxFirstReason): {
  readonly outcome:
    | "ownership_transfer"
    | "sandbox_fallback"
    | "sandbox_retry_started";
  readonly reason: string;
} {
  switch (reason) {
    case "api_model_failed":
    case "api_attempt_timed_out": {
      return {
        outcome: "sandbox_retry_started",
        reason,
      };
    }
    case "active_input": {
      return {
        outcome: "ownership_transfer",
        reason: "active_input_sandbox_first",
      };
    }
    case "PI_API_COMPACTION_PREFLIGHT_REQUIRED": {
      return { outcome: "ownership_transfer", reason: "compaction_preflight" };
    }
    case "PI_API_NATIVE_INPUT_REQUIRED": {
      return {
        outcome: "ownership_transfer",
        reason: "native_input_sandbox_first",
      };
    }
    default: {
      return { outcome: "sandbox_fallback", reason };
    }
  }
}

/**
 * Recovery, late-result and attempt-timeout records are the only production
 * evidence that a run kept single execution and truthful usage after ownership
 * moved to Sandbox, so they stay at info. `L.debug` never reaches Axiom, and
 * warn would report a successful recovery as a failure. Ordinary API
 * completion stays at debug because it happens on every API-owned first turn.
 */
function logSandboxFirstPublication(
  activation: PiApiFirstTurnActivation,
  ownership: PiApiFirstTurnOwnership,
  reason: PiSandboxFirstReason,
  modelFailure: PiApiModelFailureDiagnostic | undefined,
): void {
  L.info("Pi API first-turn outcome", {
    runId: activation.runId,
    ...piApiFirstTurnOutcomeTelemetry(activation.executionContext),
    handoffOwner: "sandbox",
    ...sandboxFirstPublicationOutcome(reason),
    ownershipStage: ownership.stage,
    ...modelFailureTelemetry(modelFailure),
  });
}

function modelFailureTelemetry(
  diagnostic: PiApiModelFailureDiagnostic | undefined,
) {
  return diagnostic
    ? {
        modelFailureCategory: diagnostic.category,
        ...(diagnostic.httpStatus === undefined
          ? {}
          : { modelFailureHttpStatus: diagnostic.httpStatus }),
      }
    : {};
}

function logApiFirstTurnTerminalFailure(args: {
  readonly activation: PiApiFirstTurnActivation;
  readonly ownership: PiApiFirstTurnOwnership;
  readonly failure: PiApiFirstTurnError;
  readonly modelFailure: PiApiModelFailureDiagnostic | undefined;
  readonly resourceFallbackReason: PiSandboxFallbackReason | null;
  readonly sandboxFirstReason: PiSandboxFirstReason | null;
}): void {
  if (args.failure instanceof PiApiFirstTurnCodexReconnectRequiredError) {
    return;
  }
  const recoveryReason =
    args.sandboxFirstReason === "api_attempt_timed_out" ||
    args.sandboxFirstReason === "api_model_failed"
      ? args.sandboxFirstReason
      : undefined;
  L.warn("Pi API first-turn outcome", {
    runId: args.activation.runId,
    ...piApiFirstTurnOutcomeTelemetry(args.activation.executionContext),
    outcome: "terminal_failure",
    reason: args.failure.code,
    ownershipStage: args.ownership.stage,
    ...modelFailureTelemetry(args.modelFailure),
    ...(args.resourceFallbackReason
      ? { fallbackReason: args.resourceFallbackReason }
      : {}),
    ...(recoveryReason ? { recoveryReason } : {}),
  });
}

const failApiFirstTurn$ = command(async function failApiFirstTurn(
  { set },
  args: ApiFirstTurnContext,
  failure: PiApiFirstTurnError,
  ownership: PiApiFirstTurnOwnership,
  suppressCompletionFailureLog: boolean,
): Promise<DispatchCompleteSideEffectsInput | undefined> {
  const failureSignal = AbortSignal.timeout(FAILURE_COMMIT_TIMEOUT_MS);
  return await withApiFirstTurnLifecycle(args, async (tx) => {
    const state = await readApiFirstTurnLifecycleState(
      tx,
      args.activation.runId,
    );
    const transition = decideApiFirstTurnTerminal(state?.status);
    if (transition === "cancelled") {
      logCanonicalApiFirstTurnCancellation(args, ownership);
      return undefined;
    }
    if (transition === "already-terminal") {
      return undefined;
    }
    const completion = await set(
      completeAgentRun$,
      {
        auth: {
          userId: args.activation.userId,
          orgId: args.activation.orgId,
          runId: args.activation.runId,
        },
        executionOwner: "api-first",
        suppressFailureLog: suppressCompletionFailureLog,
        body: {
          runId: args.activation.runId,
          exitCode: 1,
          error: failure.message,
          ...(failure.failureReason
            ? { failureReason: failure.failureReason }
            : {}),
        },
      },
      failureSignal,
    );
    failureSignal.throwIfAborted();
    if (completion.status !== 200) {
      throw new Error("Pi API first-turn failure transition was rejected");
    }
    stopPreparedSandbox(args.activation, "failed");
    return completion.sideEffects
      ? {
          ...completion.sideEffects,
          apiStartTime: args.activation.executionContext.apiStartTime,
        }
      : undefined;
  });
});

const runPiApiFirstTurnCore$ = command(
  async (
    { set },
    activation: PiApiFirstTurnActivation,
    preparation: PiApiFirstTurnPreparation,
    signal: AbortSignal,
  ): Promise<DispatchCompleteSideEffectsInput | undefined> => {
    const context: ApiFirstTurnContext = { db: set(writeDb$), activation };
    const ownership = createPiApiFirstTurnOwnership();
    const commitProgress: ApiFirstTurnCommitProgress = { started: false };
    const apiAttemptController = new AbortController();
    const apiDeadlineAt = apiFirstTurnApiDeadlineAt(
      activation.executionContext,
    );
    const apiAttemptSignal = AbortSignal.any([
      signal,
      apiAttemptController.signal,
      AbortSignal.timeout(Math.max(1, apiDeadlineAt - now())),
    ]);
    const executionResult = await settleApiFirstTurnExecution(
      set(
        executeApiFirstTurn$,
        context,
        { ownership, commitProgress, preparation },
        apiAttemptSignal,
      ),
      apiAttemptSignal,
      signal,
    );
    // A preparation failure observed before admission finished retains its
    // classification even if admission outlives the API ownership budget.
    const executed =
      ownership.stage === "pre-provider" && !commitProgress.started
        ? (preparation.failure ?? executionResult)
        : executionResult;
    if (executed.ok) {
      const outcome = executed.value;
      return outcome.outcome === "completed" && outcome.sideEffects
        ? {
            ...outcome.sideEffects,
            apiStartTime: activation.executionContext.apiStartTime,
          }
        : undefined;
    }
    // Classify the original error before aborting the private attempt. Closing
    // it first would turn raw model failures into deadlines and permit H0 replay.
    let failure = normalizedApiFirstTurnFailure(
      executed.error,
      apiAttemptSignal.aborted,
    );
    const decision = decideApiFirstTurnRecovery({
      failure,
      activeInputBeforeProvider:
        executed.error instanceof PiApiFirstTurnActiveInputBeforeProviderError,
      ownershipStage: ownership.stage,
      commitStarted: commitProgress.started,
      coordinationAborted: signal.aborted,
      coordinationDeadlineAt:
        activation.executionContext.piLaunchConfig.apiFirstTurn.deadlineAt,
      observedAt: now(),
    });
    apiAttemptController.abort(executed.error);
    if (decision.outcome === "sandbox-first") {
      if (decision.logAttemptTimeout) {
        logApiFirstTurnAttemptTimedOut(activation, ownership, failure);
      }
      const handoffSignal = piApiFirstTurnHandoffSignal(activation, signal);
      const fallback = await settleApiFirstTurnExecution(
        set(publishSandboxFallback$, context, decision.reason, handoffSignal),
        handoffSignal,
        signal,
      );
      if (fallback.ok) {
        logSandboxFirstPublication(
          activation,
          ownership,
          decision.reason,
          decision.modelFailure,
        );
        return undefined;
      }
      failure = normalizedSandboxFallbackFailure(
        fallback.error,
        handoffSignal.aborted,
      );
    }
    if (await canonicalApiFirstTurnCancellationWon(context)) {
      logCanonicalApiFirstTurnCancellation(context, ownership, executed.error);
      return undefined;
    }
    logApiFirstTurnTerminalFailure({
      activation,
      ownership,
      failure,
      modelFailure: decision.modelFailure,
      resourceFallbackReason: decision.resourceFallbackReason,
      sandboxFirstReason:
        decision.outcome === "sandbox-first" ? decision.reason : null,
    });
    return set(
      failApiFirstTurn$,
      context,
      failure,
      ownership,
      decision.suppressCompletionFailureLog,
    );
  },
);

/** Validate captured source authority before any API-owned resource or model work. */
export const runPiApiFirstTurn$ = command(
  async (
    { set },
    activation: PiApiFirstTurnActivation,
    preparation: PiApiFirstTurnPreparation | undefined,
    signal: AbortSignal,
  ): Promise<DispatchCompleteSideEffectsInput | undefined> => {
    let ownedPreparation = preparation;
    return await (async () => {
      const [run] = await set(writeDb$)
        .select({ triggerSource: agentRuns.triggerSource })
        .from(agentRuns)
        .where(eq(agentRuns.id, activation.runId));
      signal.throwIfAborted();
      if (!run || run.triggerSource === "goal") {
        return undefined;
      }
      // Queue promotion prepares only after canonical authorization, with its
      // refreshed captured deadline. It owns late initialization just like the
      // creator path, without reusing a discarded speculative session.
      ownedPreparation ??= set(
        startApiFirstTurnPreparation$,
        activation,
        signal,
      );
      return await set(
        runPiApiFirstTurnCore$,
        activation,
        ownedPreparation,
        signal,
      );
    })().finally(() => {
      if (ownedPreparation) {
        waitUntil(ownedPreparation.dispose("activation-finished"));
      }
    });
  },
);
