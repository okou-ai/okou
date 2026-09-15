import { createHash } from "node:crypto";
import { command } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { RunUploadedFileMetadata } from "@okouai/db/jsonb-contracts/run-uploaded-file";
import {
  CANONICAL_ASSET_VERSION,
  canonicalAssetDeliveries,
  runUploadedFiles,
  type CanonicalAssetMaterializationStatus,
  type RunUploadedFileSource,
} from "@okouai/db/schema/run-uploaded-file";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { ChatEventAttachFileMetadata } from "@okouai/db/schema/chat-event";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { SlackFile } from "../../lib/slack-webhook-context";
import { env } from "../../lib/env";
import { buildFileUrlFromKey, isArtifactKeyV2 } from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { type Db, writeDb$ } from "../external/db";
import {
  fetchSlackFile,
  isSlackFileFetchError,
  MAX_SLACK_FILE_SIZE_BYTES,
  SlackFileFetchError,
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
import { syncArtifactCatalogForFile$ } from "./artifact-catalog.service";
import { publishArtifactsChangedForRun } from "./artifact-realtime.service";
import { sourceForRun } from "./run-uploaded-files.service";

const SLACK_INPUT_IMPORT_TIMEOUT_MS = 10_000;

export interface CanonicalSlackInputAsset {
  readonly assetId: string;
  readonly slackFileId: string;
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

interface CanonicalSlackInputFileArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly publicBrand: PublicBrand;
  readonly botToken?: string;
  readonly file: SlackFile;
}

interface CanonicalAssetRow {
  readonly id: string;
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

function canonicalAssetPublicBrand(
  metadata: RunUploadedFileMetadata,
): PublicBrand {
  const publicBrand: unknown = metadata.publicBrand;
  if (publicBrand === undefined) {
    // Old API writers can omit the field during the observed ~102-minute
    // DB/API rollout window, and their persisted rows remain reachable until
    // expiry or backfill. Remove after both conditions hold; tracked by #28449.
    return "vm0";
  }
  if (publicBrand === "vm0" || publicBrand === "okou") {
    return publicBrand;
  }
  throw new Error(
    `Invalid canonical asset public brand: ${String(publicBrand)}`,
  );
}

function slackFileFilename(file: SlackFile): string {
  return file.name || file.title || file.id || "Untitled";
}

function slackFileContentType(file: SlackFile, filename: string): string {
  return (
    file.mimetype?.split(";")[0]?.trim().toLowerCase() ??
    inferMimetype(filename)
  );
}

function inputMaterializationError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (isSlackFileFetchError(error)) {
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
      message: "Slack file import timed out",
      retryable: true,
    };
  }
  return {
    code: "import-failed",
    message:
      error instanceof Error ? error.message : "Slack file import failed",
    retryable: true,
  };
}

async function readSlackFileBuffer(response: Response): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    size += chunk.value.byteLength;
    if (size > MAX_SLACK_FILE_SIZE_BYTES) {
      await reader.cancel();
      throw new SlackFileFetchError("too-large", "File exceeds maximum size");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, size);
}

function canonicalAssetSelection() {
  return {
    id: runUploadedFiles.id,
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

async function canonicalAssetByIdentity(
  db: Db,
  args: {
    readonly userId: string;
    readonly scope: string;
    readonly key: string;
  },
): Promise<CanonicalAssetRow | undefined> {
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
  return asset;
}

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

async function canonicalInputAssetById(
  db: Db,
  args: {
    readonly assetId: string;
    readonly userId: string;
  },
): Promise<CanonicalAssetRow | undefined> {
  const [asset] = await db
    .select(canonicalAssetSelection())
    .from(runUploadedFiles)
    .where(canonicalInputAssetIdentityCondition(args.assetId, args.userId))
    .limit(1);
  return asset;
}

async function canonicalInputAssetAfterTransitionConflict(
  db: Db,
  asset: CanonicalAssetRow,
  userId: string,
): Promise<CanonicalAssetRow> {
  const current = await canonicalInputAssetById(db, {
    assetId: asset.id,
    userId,
  });
  if (!current) {
    throw new Error("Canonical Slack input asset no longer exists");
  }
  return current;
}

async function ensureSlackInputAsset(
  db: Db,
  args: CanonicalSlackInputFileArgs & {
    readonly fileId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly artifact: ArtifactObjectLocation;
  },
): Promise<CanonicalAssetRow> {
  const scope = "slack-input";
  const [inserted] = await db
    .insert(runUploadedFiles)
    .values({
      id: args.artifact.id,
      runId: null,
      chatThreadId: args.chatThreadId,
      source: "slack",
      externalId: args.fileId,
      userId: args.userId,
      orgId: args.orgId,
      filename: args.filename,
      contentType: args.contentType,
      sizeBytes: args.file.size ?? null,
      url: null,
      metadata: { publicBrand: args.publicBrand },
      assetVersion: CANONICAL_ASSET_VERSION,
      classification: "input",
      accessLevel: "private",
      materializationStatus: "pending",
      checksumSha256: null,
      storageKey: args.artifact.key,
      provenance: {
        provider: "slack",
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        messageTs: args.messageTs,
        externalFileId: args.fileId,
      },
      materializationError: null,
      idempotencyScope: scope,
      idempotencyKey: args.fileId,
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
  if (inserted) {
    return inserted;
  }
  const existing = await canonicalAssetByIdentity(db, {
    userId: args.userId,
    scope,
    key: args.fileId,
  });
  if (!existing) {
    throw new Error("Canonical Slack input asset conflict is missing");
  }
  return existing;
}

function canonicalSlackInputResult(
  asset: CanonicalAssetRow,
  slackFileId: string,
): CanonicalSlackInputAsset {
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
    slackFileId,
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

function immediateSlackInputError(
  file: SlackFile,
  contentType: string,
): CanonicalMaterializationError | undefined {
  if (file.size !== undefined && file.size > MAX_SLACK_FILE_SIZE_BYTES) {
    return {
      code: "too-large",
      message: "File exceeds maximum size",
      retryable: false,
    };
  }
  if (!isAllowedUploadType(contentType)) {
    return {
      code: "unsupported-type",
      message: `Unsupported file type: ${contentType}`,
      retryable: false,
    };
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

async function markCanonicalInputFailed(
  db: Db,
  args: {
    readonly asset: CanonicalAssetRow;
    readonly userId: string;
    readonly error: CanonicalMaterializationError;
  },
): Promise<CanonicalAssetRow> {
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
  return (
    failed ??
    (await canonicalInputAssetAfterTransitionConflict(
      db,
      args.asset,
      args.userId,
    ))
  );
}

async function markCanonicalInputReady(
  db: Db,
  args: {
    readonly asset: CanonicalAssetRow;
    readonly userId: string;
    readonly sizeBytes: number;
    readonly checksumSha256: string;
  },
): Promise<CanonicalAssetRow> {
  let observed = args.asset;
  while (observed.materializationStatus !== "ready") {
    const [ready] = await db
      .update(runUploadedFiles)
      .set({
        sizeBytes: args.sizeBytes,
        checksumSha256: args.checksumSha256,
        materializationStatus: "ready",
        materializationError: null,
        updatedAt: sql`now()`,
      })
      .where(canonicalInputTransitionCondition(observed, args.userId))
      .returning(canonicalAssetSelection());
    if (ready) {
      return ready;
    }
    observed = await canonicalInputAssetAfterTransitionConflict(
      db,
      observed,
      args.userId,
    );
  }
  return observed;
}

async function resetCanonicalInputPending(
  db: Db,
  args: {
    readonly asset: CanonicalAssetRow;
    readonly userId: string;
  },
): Promise<CanonicalAssetRow> {
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
    if (pending) {
      return pending;
    }
    observed = await canonicalInputAssetAfterTransitionConflict(
      db,
      observed,
      args.userId,
    );
  }
  return observed;
}

const importCanonicalSlackInputFile$ = command(
  async (
    { get, set },
    args: {
      readonly asset: CanonicalAssetRow;
      readonly userId: string;
      readonly slackFileId: string;
      readonly downloadUrl: string;
      readonly botToken: string;
      readonly contentType: string;
    },
    signal: AbortSignal,
  ): Promise<CanonicalSlackInputAsset> => {
    const importSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(SLACK_INPUT_IMPORT_TIMEOUT_MS),
    ]);
    const imported = await settleIncludingAbort(
      (async (): Promise<{
        readonly buffer: Buffer;
        readonly checksumSha256: string;
      }> => {
        const response = await fetchSlackFile(
          args.downloadUrl,
          args.botToken,
          importSignal,
        );
        const buffer = await readSlackFileBuffer(response);
        importSignal.throwIfAborted();
        if (buffer.length === 0) {
          throw new SlackFileFetchError(
            "download-failed",
            "Slack file is empty",
          );
        }
        const checksumSha256 = createHash("sha256")
          .update(buffer)
          .digest("hex");
        if (!args.asset.storageKey) {
          throw new Error("Canonical Slack input asset storage key is missing");
        }
        await get(
          putS3Object(
            env("R2_USER_ARTIFACTS_BUCKET_NAME"),
            args.asset.storageKey,
            buffer,
            args.contentType,
            {
              signal: importSignal,
              metadata: artifactObjectMetadata(
                args.userId,
                args.asset.id,
                args.asset.filename ?? args.asset.id,
                canonicalAssetPublicBrand(args.asset.metadata),
              ),
            },
          ),
        );
        return { buffer, checksumSha256 };
      })(),
    );
    signal.throwIfAborted();

    const db = set(writeDb$);
    if (!imported.ok) {
      const failed = await markCanonicalInputFailed(db, {
        asset: args.asset,
        userId: args.userId,
        error: inputMaterializationError(
          importSignal.aborted ? importSignal.reason : imported.error,
        ),
      });
      signal.throwIfAborted();
      return canonicalSlackInputResult(failed, args.slackFileId);
    }
    const ready = await markCanonicalInputReady(db, {
      asset: args.asset,
      userId: args.userId,
      sizeBytes: imported.value.buffer.length,
      checksumSha256: imported.value.checksumSha256,
    });
    signal.throwIfAborted();
    return canonicalSlackInputResult(ready, args.slackFileId);
  },
);

const materializeCanonicalSlackInputFile$ = command(
  async (
    { set },
    args: CanonicalSlackInputFileArgs,
    signal: AbortSignal,
  ): Promise<CanonicalSlackInputAsset | null> => {
    const fileId = args.file.id;
    if (!fileId) {
      return null;
    }
    const filename = slackFileFilename(args.file);
    const contentType = slackFileContentType(args.file, filename);
    const artifact = await set(
      allocateArtifactObject$,
      {
        userId: args.userId,
        filename,
        publicBrand: args.publicBrand,
      },
      signal,
    );
    const db = set(writeDb$);
    let asset = await ensureSlackInputAsset(db, {
      ...args,
      fileId,
      filename,
      contentType,
      artifact,
    });
    signal.throwIfAborted();
    if (asset.materializationStatus === "ready") {
      return canonicalSlackInputResult(asset, fileId);
    }
    if (
      asset.materializationStatus === "failed" &&
      asset.materializationError?.retryable === false
    ) {
      return canonicalSlackInputResult(asset, fileId);
    }

    const immediateError = immediateSlackInputError(args.file, contentType);
    if (immediateError) {
      asset = await markCanonicalInputFailed(db, {
        asset,
        userId: args.userId,
        error: immediateError,
      });
      return canonicalSlackInputResult(asset, fileId);
    }
    if (!args.botToken) {
      asset = await markCanonicalInputFailed(db, {
        asset,
        userId: args.userId,
        error: {
          code: "slack-auth-unavailable",
          message: "Slack is not connected, so this file cannot be imported",
          retryable: true,
        },
      });
      return canonicalSlackInputResult(asset, fileId);
    }
    const downloadUrl = args.file.url_private_download;
    if (!downloadUrl) {
      throw new Error("Canonical Slack input download URL is missing");
    }

    asset = await resetCanonicalInputPending(db, {
      asset,
      userId: args.userId,
    });
    signal.throwIfAborted();
    if (
      asset.materializationStatus === "ready" ||
      (asset.materializationStatus === "failed" &&
        asset.materializationError?.retryable === false)
    ) {
      return canonicalSlackInputResult(asset, fileId);
    }

    return set(
      importCanonicalSlackInputFile$,
      {
        asset,
        userId: args.userId,
        slackFileId: fileId,
        downloadUrl,
        botToken: args.botToken,
        contentType,
      },
      signal,
    );
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
export async function registerCanonicalWebInputAssets(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly files: readonly ChatEventAttachFileMetadata[];
  },
): Promise<void> {
  for (const file of args.files) {
    const [inserted] = await db
      .insert(runUploadedFiles)
      .values({
        runId: null,
        chatThreadId: args.chatThreadId,
        source: "web",
        externalId: file.id,
        userId: args.userId,
        orgId: args.orgId,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.size,
        url: buildFileUrlFromKey(file.objectKey, file.publicBrand),
        metadata: { publicBrand: file.publicBrand },
        assetVersion: CANONICAL_ASSET_VERSION,
        classification: "input",
        accessLevel: "private",
        materializationStatus: "ready",
        storageKey: file.objectKey,
        idempotencyScope: "web-input",
        idempotencyKey: file.id,
      })
      .onConflictDoNothing()
      .returning({ id: runUploadedFiles.id });
    const asset =
      inserted ??
      (await canonicalAssetByIdentity(db, {
        userId: args.userId,
        scope: "web-input",
        key: file.id,
      }));
    if (!asset) {
      throw new Error("Canonical web input asset conflict is missing");
    }
  }
}

interface PrepareCanonicalPublishedAssetArgs {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly operationId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly checksumSha256: string;
  readonly publicBrand: PublicBrand;
  readonly destination: {
    readonly channelId: string;
    readonly threadTs?: string;
    readonly title?: string;
    readonly initialComment?: string;
  };
}

interface PreparedCanonicalPublishedAsset {
  readonly assetId: string;
  readonly operationId: string;
  readonly uploadUrl?: string;
  readonly uploadHeaders?: Readonly<Record<string, string>>;
  readonly url: string;
}

async function ensureCanonicalPublishedAsset(
  db: Db,
  args: PrepareCanonicalPublishedAssetArgs,
  artifact: ArtifactObjectLocation,
  context: {
    readonly scope: string;
    readonly source: RunUploadedFileSource;
    readonly chatThreadId: string | null;
  },
): Promise<CanonicalAssetRow> {
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
      metadata: { publicBrand: args.publicBrand },
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
  const asset =
    inserted ??
    (await canonicalAssetByIdentity(db, {
      userId: args.userId,
      scope: context.scope,
      key: args.operationId,
    }));
  if (!asset) {
    throw new Error("Canonical publication asset conflict is missing");
  }
  if (
    asset.filename !== args.filename ||
    asset.contentType !== args.contentType ||
    asset.sizeBytes !== args.size ||
    asset.checksumSha256 !== args.checksumSha256
  ) {
    throw new Error("Upload operation identity was reused for another file");
  }
  if (!asset.storageKey) {
    throw new Error("Canonical publication storage key is missing");
  }
  return asset;
}

async function ensureCanonicalSlackDelivery(
  db: Db,
  assetId: string,
  args: PrepareCanonicalPublishedAssetArgs,
): Promise<boolean> {
  await db
    .insert(canonicalAssetDeliveries)
    .values({
      assetId,
      provider: "slack",
      operationId: args.operationId,
      status: "pending",
      destination: args.destination,
    })
    .onConflictDoNothing({
      target: [
        canonicalAssetDeliveries.assetId,
        canonicalAssetDeliveries.provider,
        canonicalAssetDeliveries.operationId,
      ],
    });
  const [delivery] = await db
    .select({ destination: canonicalAssetDeliveries.destination })
    .from(canonicalAssetDeliveries)
    .where(
      and(
        eq(canonicalAssetDeliveries.assetId, assetId),
        eq(canonicalAssetDeliveries.provider, "slack"),
        eq(canonicalAssetDeliveries.operationId, args.operationId),
      ),
    )
    .limit(1);
  if (!delivery) {
    return false;
  }
  if (
    delivery.destination.channelId !== args.destination.channelId ||
    delivery.destination.threadTs !== args.destination.threadTs ||
    delivery.destination.title !== args.destination.title ||
    delivery.destination.initialComment !== args.destination.initialComment
  ) {
    throw new Error(
      "Upload operation identity was reused for another Slack destination",
    );
  }
  return true;
}

export const prepareCanonicalPublishedAsset$ = command(
  async (
    { get, set },
    args: PrepareCanonicalPublishedAssetArgs,
    signal: AbortSignal,
  ): Promise<PreparedCanonicalPublishedAsset | null> => {
    const db = set(writeDb$);
    const scope = `run:${args.runId}`;
    const source = await sourceForRun(db, args.runId, "slack", signal);
    const [run] = await db
      .select({ chatThreadId: agentRuns.chatThreadId })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, args.runId), isNotNull(agentRuns.triggerSource)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
      return null;
    }

    const artifact = await set(
      allocateArtifactObject$,
      {
        userId: args.userId,
        filename: args.filename,
        publicBrand: args.publicBrand,
      },
      signal,
    );
    const assetResult = await settle(
      ensureCanonicalPublishedAsset(db, args, artifact, {
        scope,
        source,
        chatThreadId: run.chatThreadId,
      }),
      signal,
    );
    if (!assetResult.ok) {
      if (isForeignKeyViolation(assetResult.error)) {
        return null;
      }
      throw assetResult.error;
    }
    const asset = assetResult.value;
    signal.throwIfAborted();
    const deliveryResult = await settle(
      ensureCanonicalSlackDelivery(db, asset.id, args),
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
    const storageKey = asset.storageKey;
    if (!storageKey) {
      throw new Error("Canonical publication storage key is missing");
    }
    const metadata = isArtifactKeyV2(storageKey)
      ? artifactObjectMetadata(
          args.userId,
          asset.id,
          args.filename,
          canonicalAssetPublicBrand(asset.metadata),
        )
      : undefined;
    const uploadHeaders = metadata ? s3MetadataHeaders(metadata) : undefined;

    const url = buildFileUrlFromKey(
      storageKey,
      canonicalAssetPublicBrand(asset.metadata),
    );
    if (asset.materializationStatus === "ready") {
      return {
        assetId: asset.id,
        operationId: args.operationId,
        url,
      };
    }

    await db
      .update(runUploadedFiles)
      .set({
        materializationStatus: "pending",
        materializationError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(runUploadedFiles.id, asset.id));
    signal.throwIfAborted();
    const uploadUrl = await get(
      generatePresignedPutUrl(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
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
      readonly runId: string;
      readonly userId: string;
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
          eq(runUploadedFiles.runId, args.runId),
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
    const url = buildFileUrlFromKey(
      asset.storageKey,
      canonicalAssetPublicBrand(asset.metadata),
    );
    if (asset.materializationStatus === "ready") {
      await set(syncArtifactCatalogForFile$, asset.id, signal);
      return { ok: true, assetId: asset.id, url };
    }

    const head = await get(
      s3ObjectHead(env("R2_USER_ARTIFACTS_BUCKET_NAME"), asset.storageKey),
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

    await db
      .update(runUploadedFiles)
      .set({
        url,
        sizeBytes: head.contentLength,
        materializationStatus: "ready",
        materializationError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(runUploadedFiles.id, asset.id));
    signal.throwIfAborted();
    await set(syncArtifactCatalogForFile$, asset.id, signal);
    await publishArtifactsChangedForRun(db, args.runId, signal);
    return { ok: true, assetId: asset.id, url };
  },
);
