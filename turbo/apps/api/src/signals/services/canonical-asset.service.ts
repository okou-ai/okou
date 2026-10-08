import { createHash, randomUUID } from "node:crypto";
import { command } from "ccstate";
import {
  linkLayoutFromSegment,
  linkLayoutSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import type {
  CanonicalAssetDeliveryDestination,
  CanonicalAssetDiscordDeliveryDestination,
  CanonicalAssetProvenance,
  CanonicalAssetSlackDeliveryDestination,
  RunUploadedFileMetadata,
} from "@okouai/db/jsonb-contracts/run-uploaded-file";
import {
  CANONICAL_ASSET_VERSION,
  canonicalAssetDeliveries,
  runUploadedFiles,
  type CanonicalAssetMaterializationStatus,
  type RunUploadedFileSource,
} from "@okouai/db/schema/run-uploaded-file";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { ChatEventAttachFileMetadata } from "@okouai/db/schema/chat-event";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { SlackFile } from "../../lib/slack-webhook-context";
import { buildFileUrlFromKey, isArtifactKeyV2 } from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { db$, writeDb$ } from "../external/db";
import { DiscordFileFetchError } from "../external/discord-file-fetcher";
import { FeishuApiError } from "../external/feishu-client";
import { isTelegramApiError } from "../external/telegram-client";
import {
  fetchSlackFile,
  isSlackFileFetchError,
  MAX_SLACK_FILE_SIZE_BYTES,
} from "../external/slack-file-fetcher";
import {
  generatePresignedPutUrl,
  putS3Object,
  s3MetadataHeaders,
  s3ObjectHead,
} from "../external/s3";
import { settle, settleIncludingAbort } from "../utils";
import {
  allocateArtifactObject$,
  artifactObjectMetadata,
  type ArtifactObjectLocation,
} from "./artifact-storage.service";
import {
  queueArtifactCatalogFileSql,
  syncArtifactCatalogForFile$,
} from "./artifact-catalog.service";
import { publishArtifactsChangedForRun$ } from "./artifact-realtime.service";
import { sourceForRun$ } from "./run-uploaded-files.service";
import {
  artifactStorageBucket,
  privateArtifactCreationEnabled$,
  allocatePrivateArtifactLocation$,
  privateArtifactUrl,
} from "./private-artifact-storage.service";

const INPUT_IMPORT_TIMEOUT_MS = 10_000;
const MAX_INPUT_FILE_SIZE_BYTES = 100 * 1024 * 1024;

type CanonicalArtifactLocation = ArtifactObjectLocation & {
  readonly storageMetadata: RunUploadedFileMetadata;
};

const allocateCanonicalArtifact$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly filename: string;
    },
    signal: AbortSignal,
  ): Promise<CanonicalArtifactLocation> => {
    const enabled = await set(
      privateArtifactCreationEnabled$,
      args.orgId,
      args.userId,
      signal,
    );
    signal.throwIfAborted();
    if (enabled) {
      return await set(
        allocatePrivateArtifactLocation$,
        {
          id: randomUUID(),
          filename: args.filename,
        },
        signal,
      );
    }
    const location = await set(allocateArtifactObject$, args, signal);
    // Persisted link-layout marker; stored assets without it are legacy.
    return {
      ...location,
      storageMetadata: { publicBrand: linkLayoutSegment(location.layout) },
    };
  },
);

function canonicalAssetUrl(asset: CanonicalAssetRow): string {
  if (!asset.storageKey || !asset.filename) {
    throw new Error("Canonical asset storage identity is missing");
  }
  artifactStorageBucket(asset.metadata);
  return asset.metadata.storage === undefined
    ? buildFileUrlFromKey(
        asset.storageKey,
        canonicalAssetLinkLayout(asset.metadata),
      )
    : privateArtifactUrl(asset.id, asset.filename, asset.metadata);
}

export class InputFileImportError extends Error {
  constructor(
    readonly code:
      | "download-failed"
      | "too-large"
      | "unsupported-type"
      | "html-response"
      | "invalid-url",
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "InputFileImportError";
  }
}

export interface CanonicalInputAsset {
  readonly assetId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly status: CanonicalAssetMaterializationStatus;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface CanonicalSlackInputAsset extends CanonicalInputAsset {
  readonly slackFileId: string;
}

export function canonicalInputMessageFiles(
  assets: readonly CanonicalInputAsset[],
) {
  return assets.map((asset) => {
    return {
      id: asset.assetId,
      filename: asset.filename,
      contentType: asset.contentType,
    };
  });
}

interface CanonicalInputFileArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly source: RunUploadedFileSource;
  readonly scope: string;
  readonly key: string;
  readonly externalId: string;
  readonly provenance: CanonicalAssetProvenance;
  readonly filename: string;
  readonly contentType: string;
  readonly size?: number;
}

interface CanonicalSlackInputFileArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly botToken?: string;
  readonly file: SlackFile;
}

interface CanonicalAssetRow {
  readonly id: string;
  readonly runId: string | null;
  readonly orgId: string | null;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly materializationStatus: CanonicalAssetMaterializationStatus | null;
  readonly materializationError: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  readonly checksumSha256: string | null;
  readonly storageKey: string | null;
  readonly url: string | null;
  readonly metadata: RunUploadedFileMetadata;
}

function canonicalAssetLinkLayout(
  metadata: RunUploadedFileMetadata,
): LinkLayout {
  const segment: unknown = metadata.publicBrand;
  // Public assets stored before the layout marker keep their legacy links for
  // the persisted row's lifetime; tracked by #28449.
  if (segment === undefined) {
    return "legacy";
  }
  if (typeof segment !== "string") {
    throw new Error("Invalid canonical asset link layout");
  }
  return linkLayoutFromSegment(segment);
}

function slackFileFilename(file: SlackFile): string {
  return file.name || file.title || file.id || "Untitled";
}

export function canonicalInputContentType(
  filename: string,
  contentType?: string,
): string {
  return (
    contentType?.split(";")[0]?.trim().toLowerCase() ?? inferMimetype(filename)
  );
}

function inputMaterializationError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error instanceof DiscordFileFetchError) {
    return {
      code: error.code,
      message: error.message,
      retryable:
        error.code === "download-failed" &&
        (error.statusCode === undefined ||
          error.statusCode === 429 ||
          error.statusCode >= 500),
    };
  }
  if (
    error instanceof FeishuApiError &&
    error.upstreamStatusCode !== undefined
  ) {
    return inputMaterializationError(
      new InputFileImportError(
        "download-failed",
        error.message,
        error.upstreamStatusCode,
      ),
    );
  }
  if (isTelegramApiError(error)) {
    return inputMaterializationError(
      new InputFileImportError("download-failed", error.message, error.status),
    );
  }
  if (error instanceof InputFileImportError || isSlackFileFetchError(error)) {
    const retryable =
      error.code === "download-failed" &&
      (error.statusCode === 429 || (error.statusCode ?? 0) >= 500);
    return { code: error.code, message: error.message, retryable };
  }
  if (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "TimeoutError"
  ) {
    return {
      code: "timeout",
      message: "File import timed out",
      retryable: true,
    };
  }
  return {
    code: "import-failed",
    message: error instanceof Error ? error.message : "File import failed",
    retryable: true,
  };
}

async function readInputFileChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      throw new InputFileImportError("too-large", "File exceeds maximum size");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, size);
}

async function readInputFileBuffer(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const result = await settleIncludingAbort(
    readInputFileChunks(reader, maxBytes),
  );
  reader.releaseLock();
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function canonicalAssetSelection() {
  return {
    id: runUploadedFiles.id,
    runId: runUploadedFiles.runId,
    orgId: runUploadedFiles.orgId,
    filename: runUploadedFiles.filename,
    contentType: runUploadedFiles.contentType,
    sizeBytes: runUploadedFiles.sizeBytes,
    materializationStatus: runUploadedFiles.materializationStatus,
    materializationError: runUploadedFiles.materializationError,
    checksumSha256: runUploadedFiles.checksumSha256,
    storageKey: runUploadedFiles.storageKey,
    url: runUploadedFiles.url,
    metadata: runUploadedFiles.metadata,
  } as const;
}

const canonicalAssetByIdentity$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly scope: string;
      readonly key: string;
    },
    signal: AbortSignal,
  ): Promise<CanonicalAssetRow | undefined> => {
    const db = get(db$);
    const [asset] = await db
      .select(canonicalAssetSelection())
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.userId, args.userId),
          eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
          eq(runUploadedFiles.idempotencyScope, args.scope),
          eq(runUploadedFiles.idempotencyKey, args.key),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return asset;
  },
);

function canonicalInputAssetIdentityCondition(assetId: string, userId: string) {
  return and(
    eq(runUploadedFiles.id, assetId),
    eq(runUploadedFiles.userId, userId),
    eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
    eq(runUploadedFiles.classification, "input"),
  );
}

function canonicalInputObservedStateCondition(asset: CanonicalAssetRow) {
  return asset.materializationStatus === null
    ? isNull(runUploadedFiles.materializationStatus)
    : eq(runUploadedFiles.materializationStatus, asset.materializationStatus);
}

function canonicalInputTransitionCondition(
  asset: CanonicalAssetRow,
  userId: string,
) {
  return and(
    canonicalInputAssetIdentityCondition(asset.id, userId),
    canonicalInputObservedStateCondition(asset),
    asset.materializationStatus === "ready" ? sql`false` : undefined,
  );
}

const canonicalInputAssetAfterTransitionConflict$ = command(
  async (
    { get },
    asset: CanonicalAssetRow,
    userId: string,
    signal: AbortSignal,
  ): Promise<CanonicalAssetRow> => {
    const db = get(db$);
    const [current] = await db
      .select(canonicalAssetSelection())
      .from(runUploadedFiles)
      .where(canonicalInputAssetIdentityCondition(asset.id, userId))
      .limit(1);
    signal.throwIfAborted();
    if (!current) {
      throw new Error("Canonical Slack input asset no longer exists");
    }
    return current;
  },
);

const ensureCanonicalInputAsset$ = command(
  async (
    { set },
    args: CanonicalInputFileArgs & {
      readonly artifact: CanonicalArtifactLocation;
    },
    signal: AbortSignal,
  ): Promise<CanonicalAssetRow> => {
    const db = set(writeDb$);
    const scope = args.scope;
    const [inserted] = await db
      .insert(runUploadedFiles)
      .values({
        id: args.artifact.id,
        runId: null,
        chatThreadId: args.chatThreadId,
        source: args.source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.size ?? null,
        url: null,
        metadata: args.artifact.storageMetadata,
        assetVersion: CANONICAL_ASSET_VERSION,
        classification: "input",
        accessLevel: "private",
        materializationStatus: "pending",
        checksumSha256: null,
        storageKey: args.artifact.key,
        provenance: args.provenance,
        materializationError: null,
        idempotencyScope: scope,
        idempotencyKey: args.key,
      })
      .onConflictDoNothing({
        target: [
          runUploadedFiles.userId,
          runUploadedFiles.idempotencyScope,
          runUploadedFiles.idempotencyKey,
        ],
        where: eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
      })
      .returning(canonicalAssetSelection());
    signal.throwIfAborted();
    if (inserted) {
      return inserted;
    }
    const existing = await set(
      canonicalAssetByIdentity$,
      {
        userId: args.userId,
        scope,
        key: args.key,
      },
      signal,
    );
    if (!existing) {
      throw new Error("Canonical input asset conflict is missing");
    }
    return existing;
  },
);

function canonicalSlackInputResult(
  asset: CanonicalAssetRow,
  slackFileId: string,
): CanonicalSlackInputAsset {
  return { ...canonicalInputResult(asset), slackFileId };
}

function canonicalInputResult(asset: CanonicalAssetRow): CanonicalInputAsset {
  if (
    asset.filename === null ||
    asset.contentType === null ||
    asset.materializationStatus === null
  ) {
    throw new Error("Canonical Slack input asset is missing required metadata");
  }
  const status = asset.materializationStatus;
  return {
    assetId: asset.id,
    filename: asset.filename,
    contentType: asset.contentType,
    size: asset.sizeBytes ?? 0,
    status,
    ...(status === "failed" && asset.materializationError
      ? { error: asset.materializationError }
      : {}),
  };
}

type CanonicalMaterializationError = NonNullable<
  CanonicalAssetRow["materializationError"]
>;

function immediateInputError(
  contentType: string,
  size: number | undefined,
  maxBytes: number,
): CanonicalMaterializationError | undefined {
  if (size !== undefined && size > maxBytes) {
    return {
      code: "too-large",
      message: "File exceeds maximum size",
      retryable: false,
    };
  }
  if (
    contentType !== "application/octet-stream" &&
    !isAllowedUploadType(contentType)
  ) {
    return {
      code: "unsupported-type",
      message: `Unsupported file type: ${contentType}`,
      retryable: false,
    };
  }
  return undefined;
}

function immediateSlackInputError(
  file: SlackFile,
  contentType: string,
): CanonicalMaterializationError | undefined {
  const immediateError = immediateInputError(
    contentType,
    file.size,
    MAX_SLACK_FILE_SIZE_BYTES,
  );
  if (immediateError) {
    return immediateError;
  }
  if (!file.url_private_download) {
    return {
      code: "missing-download-url",
      message: "Slack did not provide a private download URL",
      retryable: true,
    };
  }
  return undefined;
}

const markCanonicalInputFailed$ = command(
  async (
    { set },
    args: {
      readonly asset: CanonicalAssetRow;
      readonly userId: string;
      readonly error: CanonicalMaterializationError;
    },
    signal: AbortSignal,
  ): Promise<CanonicalAssetRow> => {
    const db = set(writeDb$);
    if (args.asset.materializationStatus === "ready") {
      return args.asset;
    }
    const [failed] = await db
      .update(runUploadedFiles)
      .set({
        materializationStatus: "failed",
        materializationError: args.error,
        updatedAt: sql`now()`,
      })
      .where(canonicalInputTransitionCondition(args.asset, args.userId))
      .returning(canonicalAssetSelection());
    signal.throwIfAborted();
    return (
      failed ??
      (await set(
        canonicalInputAssetAfterTransitionConflict$,
        args.asset,
        args.userId,
        signal,
      ))
    );
  },
);

const markCanonicalInputReady$ = command(
  async (
    { set },
    args: {
      readonly asset: CanonicalAssetRow;
      readonly userId: string;
      readonly sizeBytes: number;
      readonly checksumSha256: string;
      readonly contentType: string;
    },
    signal: AbortSignal,
  ): Promise<CanonicalAssetRow> => {
    const db = set(writeDb$);
    let observed = args.asset;
    while (observed.materializationStatus !== "ready") {
      const [ready] = await db
        .update(runUploadedFiles)
        .set({
          ...(args.asset.metadata.storage === undefined
            ? {}
            : { url: canonicalAssetUrl(args.asset) }),
          sizeBytes: args.sizeBytes,
          checksumSha256: args.checksumSha256,
          contentType: args.contentType,
          materializationStatus: "ready",
          materializationError: null,
          updatedAt: sql`now()`,
        })
        .where(canonicalInputTransitionCondition(observed, args.userId))
        .returning(canonicalAssetSelection());
      signal.throwIfAborted();
      if (ready) {
        return ready;
      }
      observed = await set(
        canonicalInputAssetAfterTransitionConflict$,
        observed,
        args.userId,
        signal,
      );
    }
    return observed;
  },
);

const resetCanonicalInputPending$ = command(
  async (
    { set },
    args: {
      readonly asset: CanonicalAssetRow;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<CanonicalAssetRow> => {
    const db = set(writeDb$);
    let observed = args.asset;
    while (
      observed.materializationStatus !== "ready" &&
      observed.materializationStatus !== "pending" &&
      !(
        observed.materializationStatus === "failed" &&
        observed.materializationError?.retryable === false
      )
    ) {
      const [pending] = await db
        .update(runUploadedFiles)
        .set({
          materializationStatus: "pending",
          materializationError: null,
          updatedAt: sql`now()`,
        })
        .where(canonicalInputTransitionCondition(observed, args.userId))
        .returning(canonicalAssetSelection());
      signal.throwIfAborted();
      if (pending) {
        return pending;
      }
      observed = await set(
        canonicalInputAssetAfterTransitionConflict$,
        observed,
        args.userId,
        signal,
      );
    }
    return observed;
  },
);

function canonicalInputResponseContentType(
  response: Response,
  declaredContentType: string,
): string {
  if (!response.ok) {
    throw new InputFileImportError(
      "download-failed",
      "File cannot be imported",
      response.status,
    );
  }
  const responseContentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (responseContentType === "text/html") {
    throw new InputFileImportError(
      "html-response",
      "File download returned an unexpected HTML response",
    );
  }
  const contentType =
    declaredContentType === "application/octet-stream"
      ? (responseContentType ?? declaredContentType)
      : declaredContentType;
  if (!isAllowedUploadType(contentType)) {
    throw new InputFileImportError(
      "unsupported-type",
      `Unsupported file type: ${contentType}`,
    );
  }
  return contentType;
}

export interface CanonicalInputImportPlan {
  readonly asset: CanonicalAssetRow;
  readonly userId: string;
  readonly contentType: string;
  readonly maxBytes: number;
}
export interface CanonicalInputImportReady {
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly contentType: string;
}
type CanonicalInputImportOutcome =
  | { readonly ok: true; readonly value: CanonicalInputImportReady }
  | { readonly ok: false; readonly error: CanonicalMaterializationError };
type PreparedCanonicalInputFile =
  | { readonly kind: "complete"; readonly asset: CanonicalInputAsset }
  | { readonly kind: "import"; readonly plan: CanonicalInputImportPlan };

/** One deadline covers provider download, bounded reading and object upload. */
export function canonicalInputImportSignals(signal: AbortSignal) {
  const importController = new AbortController();
  const importSignal = AbortSignal.any([
    signal,
    importController.signal,
    AbortSignal.timeout(INPUT_IMPORT_TIMEOUT_MS),
  ]);
  return { importController, importSignal };
}

export function canonicalInputImportOutcome(
  imported:
    | { readonly ok: true; readonly value: CanonicalInputImportReady }
    | { readonly ok: false; readonly error: unknown },
  importSignal: AbortSignal,
): CanonicalInputImportOutcome {
  return imported.ok
    ? imported
    : {
        ok: false,
        error: inputMaterializationError(
          importSignal.aborted ? importSignal.reason : imported.error,
        ),
      };
}

/** Read and upload the provider response; no database mutation occurs here. */
export const storeCanonicalInputFile$ = command(
  async (
    { get },
    plan: CanonicalInputImportPlan,
    response: Response,
    signal: AbortSignal,
  ): Promise<CanonicalInputImportReady> => {
    const contentType = canonicalInputResponseContentType(
      response,
      plan.contentType,
    );
    if (Number(response.headers.get("content-length")) > plan.maxBytes) {
      throw new InputFileImportError("too-large", "File exceeds maximum size");
    }
    const buffer = await readInputFileBuffer(response, plan.maxBytes);
    signal.throwIfAborted();
    if (buffer.length === 0) {
      throw new InputFileImportError("download-failed", "File is empty");
    }
    const checksumSha256 = createHash("sha256").update(buffer).digest("hex");
    if (!plan.asset.storageKey) {
      throw new Error("Canonical input asset storage key is missing");
    }
    await get(
      putS3Object(
        artifactStorageBucket(plan.asset.metadata),
        plan.asset.storageKey,
        buffer,
        contentType,
        {
          signal: signal,
          metadata:
            plan.asset.metadata.storage !== undefined
              ? { "artifact-id": plan.asset.id }
              : artifactObjectMetadata(
                  plan.userId,
                  plan.asset.id,
                  plan.asset.filename ?? plan.asset.id,
                  canonicalAssetLinkLayout(plan.asset.metadata),
                ),
        },
      ),
    );
    signal.throwIfAborted();
    return { sizeBytes: buffer.length, checksumSha256, contentType };
  },
);

/** Persist the settled import using the caller's still-live cancellation scope. */
export const completeCanonicalInputFile$ = command(
  async (
    { set },
    plan: CanonicalInputImportPlan,
    outcome: CanonicalInputImportOutcome,
    signal: AbortSignal,
  ): Promise<CanonicalInputAsset> => {
    const asset = outcome.ok
      ? await set(
          markCanonicalInputReady$,
          { asset: plan.asset, userId: plan.userId, ...outcome.value },
          signal,
        )
      : await set(
          markCanonicalInputFailed$,
          { asset: plan.asset, userId: plan.userId, error: outcome.error },
          signal,
        );
    signal.throwIfAborted();
    return canonicalInputResult(asset);
  },
);

const resolveCanonicalInputIdentity$ = command(
  async (
    { set },
    args: CanonicalInputFileArgs,
    signal: AbortSignal,
  ): Promise<CanonicalAssetRow> => {
    let asset = await set(canonicalAssetByIdentity$, args, signal);
    signal.throwIfAborted();
    if (!asset) {
      const artifact = await set(allocateCanonicalArtifact$, args, signal);
      asset = await set(
        ensureCanonicalInputAsset$,
        { ...args, artifact },
        signal,
      );
      signal.throwIfAborted();
    }
    return asset;
  },
);

/** Resolve durable identity before the provider starts any external work. */
export const prepareCanonicalInputFile$ = command(
  async (
    { set },
    args: CanonicalInputFileArgs & { readonly maxBytes?: number },
    signal: AbortSignal,
  ): Promise<PreparedCanonicalInputFile> => {
    let asset = await set(resolveCanonicalInputIdentity$, args, signal);
    if (
      asset.materializationStatus === "ready" ||
      (asset.materializationStatus === "failed" &&
        asset.materializationError?.retryable === false)
    ) {
      return { kind: "complete", asset: canonicalInputResult(asset) };
    }
    const maxBytes = args.maxBytes ?? MAX_INPUT_FILE_SIZE_BYTES;
    const immediateError = immediateInputError(
      args.contentType,
      args.size,
      maxBytes,
    );
    if (immediateError) {
      const failed = await set(
        markCanonicalInputFailed$,
        {
          asset,
          userId: args.userId,
          error: immediateError,
        },
        signal,
      );
      signal.throwIfAborted();
      return { kind: "complete", asset: canonicalInputResult(failed) };
    }
    asset = await set(
      resetCanonicalInputPending$,
      {
        asset,
        userId: args.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      asset.materializationStatus === "ready" ||
      (asset.materializationStatus === "failed" &&
        asset.materializationError?.retryable === false)
    ) {
      return { kind: "complete", asset: canonicalInputResult(asset) };
    }
    return {
      kind: "import",
      plan: {
        asset,
        userId: args.userId,
        contentType: args.contentType,
        maxBytes,
      },
    };
  },
);

type PreparedSlackInput =
  | { readonly kind: "complete"; readonly asset: CanonicalSlackInputAsset }
  | {
      readonly kind: "import";
      readonly slackFileId: string;
      readonly plan: CanonicalInputImportPlan;
      readonly download: { readonly url: string; readonly botToken: string };
    };
const prepareCanonicalSlackInputFile$ = command(
  async (
    { set },
    args: CanonicalSlackInputFileArgs,
    signal: AbortSignal,
  ): Promise<PreparedSlackInput | null> => {
    const fileId = args.file.id;
    if (!fileId) {
      return null;
    }
    const filename = slackFileFilename(args.file);
    const contentType = canonicalInputContentType(filename, args.file.mimetype);
    let asset = await set(
      resolveCanonicalInputIdentity$,
      {
        ...args,
        source: "slack",
        scope: "slack-input",
        key: fileId,
        externalId: fileId,
        size: args.file.size,
        provenance: {
          provider: "slack",
          workspaceId: args.workspaceId,
          channelId: args.channelId,
          messageTs: args.messageTs,
          externalFileId: fileId,
        },
        filename,
        contentType,
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      asset.materializationStatus === "ready" ||
      (asset.materializationStatus === "failed" &&
        asset.materializationError?.retryable === false)
    ) {
      return {
        kind: "complete",
        asset: canonicalSlackInputResult(asset, fileId),
      };
    }

    const immediateError = immediateSlackInputError(args.file, contentType);
    if (immediateError) {
      asset = await set(
        markCanonicalInputFailed$,
        {
          asset,
          userId: args.userId,
          error: immediateError,
        },
        signal,
      );
      return {
        kind: "complete",
        asset: canonicalSlackInputResult(asset, fileId),
      };
    }
    if (!args.botToken) {
      asset = await set(
        markCanonicalInputFailed$,
        {
          asset,
          userId: args.userId,
          error: {
            code: "slack-auth-unavailable",
            message: "Slack is not connected, so this file cannot be imported",
            retryable: true,
          },
        },
        signal,
      );
      return {
        kind: "complete",
        asset: canonicalSlackInputResult(asset, fileId),
      };
    }
    const downloadUrl = args.file.url_private_download;
    if (!downloadUrl) {
      throw new Error("Canonical Slack input download URL is missing");
    }

    asset = await set(
      resetCanonicalInputPending$,
      {
        asset,
        userId: args.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      asset.materializationStatus === "ready" ||
      (asset.materializationStatus === "failed" &&
        asset.materializationError?.retryable === false)
    ) {
      return {
        kind: "complete",
        asset: canonicalSlackInputResult(asset, fileId),
      };
    }

    return {
      kind: "import",
      slackFileId: fileId,
      plan: {
        asset,
        userId: args.userId,
        contentType,
        maxBytes: MAX_SLACK_FILE_SIZE_BYTES,
      },
      download: { url: downloadUrl, botToken: args.botToken },
    };
  },
);
const importCanonicalSlackInputFile$ = command(
  async (
    { set },
    prepared: Extract<PreparedSlackInput, { kind: "import" }>,
    signal: AbortSignal,
  ): Promise<CanonicalInputImportReady> => {
    const response = await fetchSlackFile(
      prepared.download.url,
      prepared.download.botToken,
      signal,
    );
    signal.throwIfAborted();
    return await set(storeCanonicalInputFile$, prepared.plan, response, signal);
  },
);
const materializeCanonicalSlackInputFile$ = command(
  async (
    { set },
    args: CanonicalSlackInputFileArgs,
    signal: AbortSignal,
  ): Promise<CanonicalSlackInputAsset | null> => {
    const prepared = await set(prepareCanonicalSlackInputFile$, args, signal);
    signal.throwIfAborted();
    if (!prepared) {
      return null;
    }
    if (prepared.kind === "complete") {
      return prepared.asset;
    }
    const { importController, importSignal } =
      canonicalInputImportSignals(signal);
    const imported = await settleIncludingAbort(
      set(importCanonicalSlackInputFile$, prepared, importSignal),
    );
    signal.throwIfAborted();
    const outcome = canonicalInputImportOutcome(imported, importSignal);
    if (!imported.ok) {
      // Abort the fetch without awaiting cancellation of a tee'd response stream.
      importController.abort();
    }
    const asset = await set(
      completeCanonicalInputFile$,
      prepared.plan,
      outcome,
      signal,
    );
    signal.throwIfAborted();
    return { ...asset, slackFileId: prepared.slackFileId };
  },
);

export const materializeCanonicalSlackInputAssets$ = command(
  async (
    { set },
    args: Omit<CanonicalSlackInputFileArgs, "file"> & {
      readonly files: readonly SlackFile[];
    },
    signal: AbortSignal,
  ): Promise<readonly CanonicalSlackInputAsset[]> => {
    const assets: CanonicalSlackInputAsset[] = [];
    for (const file of args.files) {
      const asset = await set(
        materializeCanonicalSlackInputFile$,
        { ...args, file },
        signal,
      );
      signal.throwIfAborted();
      if (asset) {
        assets.push(asset);
      }
    }
    return assets;
  },
);

/**
 * Registers web chat input files as canonical assets.
 *
 * Web input events carry their own ordered attachment list in
 * `chat_events.payload.userMessage` (`type: "file"` parts with fileId,
 * filename, and content type), so this path only needs the canonical asset
 * rows.
 */
interface CanonicalWebInputOwner {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
}

/** Validate the existing private ownership record without changing its identity. */
export function canonicalPrivateWebInputPlan(
  args: CanonicalWebInputOwner & {
    readonly file: ChatEventAttachFileMetadata;
    readonly owned:
      | Pick<
          typeof runUploadedFiles.$inferSelect,
          "userId" | "orgId" | "storageKey" | "metadata"
        >
      | undefined;
  },
) {
  const { file, owned } = args;
  if (!owned || owned.metadata.storage === undefined) {
    throw new Error("Private attachment storage record is missing");
  }
  artifactStorageBucket(owned.metadata);
  if (
    owned.userId !== args.userId ||
    owned.orgId !== args.orgId ||
    owned.storageKey !== file.objectKey
  ) {
    throw new Error("Private attachment belongs to another owner");
  }
  return {
    values: {
      chatThreadId: args.chatThreadId,
      assetVersion: CANONICAL_ASSET_VERSION,
      classification: "input",
      materializationStatus: "ready",
      contentType: file.contentType,
      sizeBytes: file.size,
      url: privateArtifactUrl(file.id, file.filename, owned.metadata),
      idempotencyScope: "web-input",
      idempotencyKey: file.id,
    } satisfies Partial<typeof runUploadedFiles.$inferInsert>,
    where: and(
      eq(runUploadedFiles.id, file.id),
      isNull(runUploadedFiles.assetVersion),
      isNull(runUploadedFiles.runId),
      isNull(runUploadedFiles.chatThreadId),
    ),
  };
}

/** Canonical registration values and conflict lookup for an ordered web input. */
export function canonicalWebInputPlan(
  args: CanonicalWebInputOwner & { readonly file: ChatEventAttachFileMetadata },
) {
  const { file } = args;
  return {
    values: {
      runId: null,
      chatThreadId: args.chatThreadId,
      source: "web",
      externalId: file.id,
      userId: args.userId,
      orgId: args.orgId,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.size,
      url: buildFileUrlFromKey(
        file.objectKey,
        linkLayoutFromSegment(file.publicBrand),
      ),
      metadata: { publicBrand: file.publicBrand },
      assetVersion: CANONICAL_ASSET_VERSION,
      classification: "input",
      accessLevel: "private",
      materializationStatus: "ready",
      storageKey: file.objectKey,
      idempotencyScope: "web-input",
      idempotencyKey: file.id,
    } satisfies typeof runUploadedFiles.$inferInsert,
    identity: and(
      eq(runUploadedFiles.userId, args.userId),
      eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
      eq(runUploadedFiles.idempotencyScope, "web-input"),
      eq(runUploadedFiles.idempotencyKey, file.id),
    ),
  };
}

interface CanonicalPublicationFileArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly operationId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly checksumSha256: string;
}

type PrepareCanonicalPublishedAssetArgs = CanonicalPublicationFileArgs &
  (
    | {
        readonly provider: "slack";
        readonly runId: string;
        readonly destination: CanonicalAssetSlackDeliveryDestination;
      }
    | {
        readonly provider: "discord";
        readonly runId: string | null;
        readonly destination: CanonicalAssetDiscordDeliveryDestination;
      }
  );

interface PreparedCanonicalPublishedAsset {
  readonly assetId: string;
  readonly operationId: string;
  readonly uploadUrl?: string;
  readonly uploadHeaders?: Readonly<Record<string, string>>;
  readonly url: string;
}

export class CanonicalPublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalPublicationConflictError";
  }
}

const ensureCanonicalPublishedAsset$ = command(
  async (
    { set },
    args: PrepareCanonicalPublishedAssetArgs,
    artifact: CanonicalArtifactLocation,
    context: {
      readonly scope: string;
      readonly source: RunUploadedFileSource;
      readonly chatThreadId: string | null;
    },
    signal: AbortSignal,
  ): Promise<CanonicalAssetRow> => {
    const db = set(writeDb$);
    const [inserted] = await db
      .insert(runUploadedFiles)
      .values({
        id: artifact.id,
        runId: args.runId,
        chatThreadId: context.chatThreadId,
        source: context.source,
        externalId: args.operationId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.size,
        url: null,
        metadata:
          args.runId === null
            ? { ...artifact.storageMetadata, purpose: "artifact" }
            : artifact.storageMetadata,
        assetVersion: CANONICAL_ASSET_VERSION,
        classification: "published-output",
        accessLevel: "published",
        materializationStatus: "pending",
        checksumSha256: args.checksumSha256,
        storageKey: artifact.key,
        provenance: { provider: "agent" },
        materializationError: null,
        idempotencyScope: context.scope,
        idempotencyKey: args.operationId,
      })
      .onConflictDoNothing({
        target: [
          runUploadedFiles.userId,
          runUploadedFiles.idempotencyScope,
          runUploadedFiles.idempotencyKey,
        ],
        where: eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
      })
      .returning(canonicalAssetSelection());
    signal.throwIfAborted();
    const asset =
      inserted ??
      (await set(
        canonicalAssetByIdentity$,
        {
          userId: args.userId,
          scope: context.scope,
          key: args.operationId,
        },
        signal,
      ));
    if (!asset) {
      throw new Error("Canonical publication asset conflict is missing");
    }
    return asset;
  },
);

function sameCanonicalDeliveryDestination(
  stored: CanonicalAssetDeliveryDestination,
  requested: CanonicalAssetDeliveryDestination,
): boolean {
  if (stored.provider === "discord" || requested.provider === "discord") {
    return (
      stored.provider === "discord" &&
      requested.provider === "discord" &&
      stored.connectionId === requested.connectionId &&
      stored.guildId === requested.guildId &&
      stored.channelId === requested.channelId &&
      stored.comment === requested.comment
    );
  }
  return (
    stored.channelId === requested.channelId &&
    stored.threadTs === requested.threadTs &&
    stored.title === requested.title &&
    stored.initialComment === requested.initialComment
  );
}

const ensureCanonicalDelivery$ = command(
  async (
    { set },
    assetId: string,
    args: PrepareCanonicalPublishedAssetArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      const [asset] = await tx
        .select({ id: runUploadedFiles.id })
        .from(runUploadedFiles)
        .where(eq(runUploadedFiles.id, assetId))
        .for("update");
      signal.throwIfAborted();
      if (!asset) {
        return false;
      }
      const [delivery] = await tx
        .select({
          provider: canonicalAssetDeliveries.provider,
          destination: canonicalAssetDeliveries.destination,
        })
        .from(canonicalAssetDeliveries)
        .where(
          and(
            eq(canonicalAssetDeliveries.assetId, assetId),
            eq(canonicalAssetDeliveries.operationId, args.operationId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (delivery) {
        if (
          delivery.provider !== args.provider ||
          !sameCanonicalDeliveryDestination(
            delivery.destination,
            args.destination,
          )
        ) {
          throw new CanonicalPublicationConflictError(
            "Upload operation identity was reused for another delivery destination",
          );
        }
        return true;
      }
      await tx.insert(canonicalAssetDeliveries).values({
        assetId,
        provider: args.provider,
        operationId: args.operationId,
        status: "pending",
        destination: args.destination,
        ...(args.provider === "discord"
          ? {
              providerState: { provider: "discord" as const, attempt: null },
            }
          : {}),
      });
      signal.throwIfAborted();
      return true;
    });
  },
);

function canonicalPublicationScope(args: PrepareCanonicalPublishedAssetArgs) {
  return args.provider === "discord" && args.runId === null
    ? `discord:${args.destination.connectionId}`
    : `run:${args.runId}`;
}

const prepareCanonicalUpload$ = command(
  async (
    { get, set },
    asset: CanonicalAssetRow,
    args: PrepareCanonicalPublishedAssetArgs,
    signal: AbortSignal,
  ): Promise<PreparedCanonicalPublishedAsset | null> => {
    const db = set(writeDb$);
    const storageKey = asset.storageKey;
    if (!storageKey) {
      throw new Error("Canonical publication storage key is missing");
    }
    const metadata =
      asset.metadata.storage !== undefined
        ? { "artifact-id": asset.id }
        : isArtifactKeyV2(storageKey)
          ? artifactObjectMetadata(
              args.userId,
              asset.id,
              args.filename,
              canonicalAssetLinkLayout(asset.metadata),
            )
          : undefined;
    const uploadHeaders = metadata ? s3MetadataHeaders(metadata) : undefined;

    const url = canonicalAssetUrl(asset);
    if (asset.materializationStatus === "ready") {
      return {
        assetId: asset.id,
        operationId: args.operationId,
        url,
      };
    }

    const [pending] = await db
      .update(runUploadedFiles)
      .set({
        materializationStatus: "pending",
        materializationError: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(runUploadedFiles.id, asset.id),
          ne(runUploadedFiles.materializationStatus, "ready"),
        ),
      )
      .returning({ id: runUploadedFiles.id });
    signal.throwIfAborted();
    if (!pending) {
      const current = await set(
        canonicalAssetByIdentity$,
        {
          userId: args.userId,
          scope: canonicalPublicationScope(args),
          key: args.operationId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!current) {
        return null;
      }
      if (current.materializationStatus !== "ready") {
        throw new Error("Canonical publication lost its materialization state");
      }
      return { assetId: current.id, operationId: args.operationId, url };
    }
    const uploadUrl = await get(
      generatePresignedPutUrl(
        artifactStorageBucket(asset.metadata),
        storageKey,
        args.contentType,
        {
          usePublicEndpoint: true,
          metadata,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    return {
      assetId: asset.id,
      operationId: args.operationId,
      uploadUrl,
      ...(uploadHeaders ? { uploadHeaders } : {}),
      url,
    };
  },
);

export const prepareCanonicalPublishedAsset$ = command(
  async (
    { set },
    args: PrepareCanonicalPublishedAssetArgs,
    signal: AbortSignal,
  ): Promise<PreparedCanonicalPublishedAsset | null> => {
    const db = set(writeDb$);
    const scope = canonicalPublicationScope(args);
    const source =
      args.runId === null
        ? "discord"
        : await set(sourceForRun$, args.runId, args.provider, signal);
    let chatThreadId: string | null = null;
    if (args.runId !== null) {
      const [run] = await db
        .select({ chatThreadId: agentRuns.chatThreadId })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, args.runId),
            eq(agentRuns.userId, args.userId),
            eq(agentRuns.orgId, args.orgId),
            isNotNull(agentRuns.triggerSource),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!run) {
        return null;
      }
      chatThreadId = run.chatThreadId;
    }

    let asset = await set(
      canonicalAssetByIdentity$,
      {
        userId: args.userId,
        scope,
        key: args.operationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!asset) {
      const artifact = await set(
        allocateCanonicalArtifact$,
        {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
        },
        signal,
      );
      const assetResult = await settle(
        set(
          ensureCanonicalPublishedAsset$,
          args,
          artifact,
          {
            scope,
            source,
            chatThreadId,
          },
          signal,
        ),
        signal,
      );
      if (!assetResult.ok) {
        if (isForeignKeyViolation(assetResult.error)) {
          return null;
        }
        throw assetResult.error;
      }
      asset = assetResult.value;
    }
    signal.throwIfAborted();
    if (asset.runId !== args.runId || asset.orgId !== args.orgId) {
      return null;
    }
    if (
      asset.filename !== args.filename ||
      asset.contentType !== args.contentType ||
      asset.sizeBytes !== args.size ||
      asset.checksumSha256 !== args.checksumSha256
    ) {
      throw new CanonicalPublicationConflictError(
        "Upload operation identity was reused for another file",
      );
    }
    const deliveryResult = await settle(
      set(ensureCanonicalDelivery$, asset.id, args, signal),
      signal,
    );
    if (!deliveryResult.ok) {
      if (isForeignKeyViolation(deliveryResult.error)) {
        return null;
      }
      throw deliveryResult.error;
    }
    if (!deliveryResult.value) {
      return null;
    }
    return await set(prepareCanonicalUpload$, asset, args, signal);
  },
);

type MaterializeCanonicalPublishedAssetResult =
  | {
      readonly ok: true;
      readonly assetId: string;
      readonly url: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export const materializeCanonicalPublishedAsset$ = command(
  async (
    { get, set },
    args: {
      readonly assetId: string;
      readonly operationId: string;
      readonly runId: string | null;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<MaterializeCanonicalPublishedAssetResult> => {
    const db = set(writeDb$);
    const [asset] = await db
      .select(canonicalAssetSelection())
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.id, args.assetId),
          eq(runUploadedFiles.userId, args.userId),
          eq(runUploadedFiles.orgId, args.orgId),
          args.runId === null
            ? isNull(runUploadedFiles.runId)
            : eq(runUploadedFiles.runId, args.runId),
          eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
          eq(runUploadedFiles.classification, "published-output"),
          eq(runUploadedFiles.idempotencyKey, args.operationId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!asset?.storageKey || !asset.filename) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Canonical publication asset was not found",
      };
    }
    const url = canonicalAssetUrl(asset);
    if (asset.materializationStatus === "ready") {
      await set(syncArtifactCatalogForFile$, asset.id, signal);
      return { ok: true, assetId: asset.id, url };
    }

    const head = await get(
      s3ObjectHead(artifactStorageBucket(asset.metadata), asset.storageKey),
    );
    signal.throwIfAborted();
    const expectedSize = asset.sizeBytes;
    if (
      head.kind === "missing" ||
      head.contentLength === undefined ||
      (expectedSize !== null && head.contentLength !== expectedSize)
    ) {
      const error = {
        code: "storage-verification-failed",
        message:
          head.kind === "missing"
            ? "Canonical upload was not found"
            : "Canonical upload size did not match",
        retryable: true,
      } as const;
      await db
        .update(runUploadedFiles)
        .set({
          materializationStatus: "failed",
          materializationError: error,
          updatedAt: sql`now()`,
        })
        .where(eq(runUploadedFiles.id, asset.id));
      signal.throwIfAborted();
      return { ok: false, code: error.code, message: error.message };
    }

    // Materialization and the durable catalog handoff must commit together.
    await db.transaction(async (tx) => {
      await tx
        .update(runUploadedFiles)
        .set({
          url,
          sizeBytes: head.contentLength,
          materializationStatus: "ready",
          materializationError: null,
          updatedAt: sql`now()`,
        })
        .where(eq(runUploadedFiles.id, asset.id));
      await tx.execute(queueArtifactCatalogFileSql(asset.id));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
    await set(syncArtifactCatalogForFile$, asset.id, signal);
    if (args.runId !== null) {
      await set(publishArtifactsChangedForRun$, args.runId, signal);
    }
    return { ok: true, assetId: asset.id, url };
  },
);
