import { createHash } from "node:crypto";
import { command } from "ccstate";
import type { CanonicalAssetProvenance } from "@okouai/db/jsonb-contracts/run-uploaded-file";
import { files } from "@okouai/db/schema/file";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { SlackFile } from "../../lib/slack-webhook-context";
import { inferMimetype } from "../../lib/mimetype";
import { nowDate } from "../../lib/time";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { db$, writeDb$ } from "../external/db";
import { DiscordFileFetchError } from "../external/discord-file-fetcher";
import { WechatMediaDownloadError } from "../external/wechat-media";
import { FeishuApiError } from "../external/feishu-client";
import { isTelegramApiError } from "../external/telegram-client";
import {
  fetchSlackFile,
  isSlackFileFetchError,
  MAX_SLACK_FILE_SIZE_BYTES,
} from "../external/slack-file-fetcher";
import {
  downloadS3BufferWithMaxBytes,
  generatePresignedPutUrl,
  putS3Object,
  s3MetadataHeaders,
  s3ObjectHead,
  S3ObjectSizeLimitError,
} from "../external/s3";
import { settle, settleIncludingAbort } from "../utils";
import {
  allocatePrivateArtifact$,
  completePrivateArtifact$,
  fileStorageBucket,
  privateArtifactRecord$,
  privateArtifactsBucket,
  resolvePrivateArtifactUrl$,
  type PrivateArtifactRecord,
} from "./private-artifact-storage.service";

const MAX_INPUT_FILE_SIZE_BYTES = 100 * 1024 * 1024;

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

export type CanonicalInputAssetStatus = "pending" | "ready" | "failed";

export interface CanonicalInputAsset {
  readonly assetId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly status: CanonicalInputAssetStatus;
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
  readonly source: string;
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

interface InputFileRow {
  readonly id: string;
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly storageKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number | null;
  readonly checksumSha256: string | null;
  readonly deletedAt: Date | null;
}

interface CanonicalInputError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

function deterministicInputFileId(
  userId: string,
  scope: string,
  key: string,
): string {
  const hex = createHash("sha256")
    .update(`canonical-input:${userId}:${scope}:${key}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
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

function inputMaterializationError(error: unknown): CanonicalInputError {
  if (
    error instanceof DiscordFileFetchError ||
    error instanceof WechatMediaDownloadError
  ) {
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

function immediateInputError(
  contentType: string,
  size: number | undefined,
  maxBytes: number,
): CanonicalInputError | undefined {
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
): CanonicalInputError | undefined {
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
  readonly asset: InputFileRow;
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
  | { readonly ok: false; readonly error: CanonicalInputError };

type PreparedCanonicalInputFile =
  | { readonly kind: "complete"; readonly asset: CanonicalInputAsset }
  | { readonly kind: "import"; readonly plan: CanonicalInputImportPlan };

/** The import owner covers provider download, bounded reading and object upload. */
export function canonicalInputImportSignals(signal: AbortSignal) {
  const importController = new AbortController();
  const importSignal = AbortSignal.any([signal, importController.signal]);
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

const findInputFileRow$ = command(
  async (
    { get },
    args: { readonly id: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<InputFileRow | undefined> => {
    const [row] = await get(db$)
      .select({
        id: files.id,
        orgId: files.orgId,
        ownerUserId: files.ownerUserId,
        storageKey: files.storageKey,
        filename: files.filename,
        contentType: files.contentType,
        sizeBytes: files.sizeBytes,
        checksumSha256: files.checksumSha256,
        deletedAt: files.deletedAt,
      })
      .from(files)
      .where(and(eq(files.id, args.id), eq(files.ownerUserId, args.userId)))
      .limit(1);
    signal.throwIfAborted();
    if (!row?.storageKey || !row.filename) {
      return undefined;
    }
    return {
      id: row.id,
      orgId: row.orgId,
      ownerUserId: row.ownerUserId,
      storageKey: row.storageKey,
      filename: row.filename,
      contentType: row.contentType ?? "application/octet-stream",
      sizeBytes: row.sizeBytes,
      checksumSha256: row.checksumSha256,
      deletedAt: row.deletedAt,
    };
  },
);

const ensureInputFileRow$ = command(
  async (
    { set },
    args: CanonicalInputFileArgs & { readonly id: string },
    signal: AbortSignal,
  ): Promise<InputFileRow> => {
    const existing = await set(
      findInputFileRow$,
      { id: args.id, userId: args.userId },
      signal,
    );
    if (existing) {
      return existing;
    }
    const location = await set(
      allocatePrivateArtifact$,
      {
        id: args.id,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        size: args.size ?? 0,
      },
      signal,
    );
    return {
      id: location.id,
      orgId: args.orgId,
      ownerUserId: args.userId,
      storageKey: location.key,
      filename: args.filename,
      contentType: args.contentType,
      sizeBytes: null,
      checksumSha256: null,
      deletedAt: null,
    };
  },
);

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
    await get(
      putS3Object(
        fileStorageBucket(plan.asset.storageKey),
        plan.asset.storageKey,
        buffer,
        contentType,
        {
          signal,
          metadata: { "artifact-id": plan.asset.id },
        },
      ),
    );
    signal.throwIfAborted();
    return { sizeBytes: buffer.length, checksumSha256, contentType };
  },
);

/** Persist the settled import into `files` using the caller's live scope. */
export const completeCanonicalInputFile$ = command(
  async (
    { set },
    plan: CanonicalInputImportPlan,
    outcome: CanonicalInputImportOutcome,
    signal: AbortSignal,
  ): Promise<CanonicalInputAsset> => {
    if (!outcome.ok) {
      if (!outcome.error.retryable) {
        // Tombstone permanently failed imports on the deterministic input row
        // (`deletedAt IS NOT NULL` with `sizeBytes IS NULL`) so redelivered
        // webhook events do not re-fetch broken external media.
        await set(writeDb$)
          .update(files)
          .set({ deletedAt: nowDate() })
          .where(
            and(
              eq(files.id, plan.asset.id),
              eq(files.ownerUserId, plan.userId),
              isNull(files.sizeBytes),
              isNull(files.deletedAt),
            ),
          );
        signal.throwIfAborted();
      }
      return {
        assetId: plan.asset.id,
        filename: plan.asset.filename,
        contentType: plan.asset.contentType,
        size: 0,
        status: "failed",
        error: outcome.error,
      };
    }
    const [updated] = await set(writeDb$)
      .update(files)
      .set({
        sizeBytes: outcome.value.sizeBytes,
        checksumSha256: outcome.value.checksumSha256,
        contentType: outcome.value.contentType,
      })
      .where(
        and(
          eq(files.id, plan.asset.id),
          eq(files.ownerUserId, plan.userId),
          isNull(files.deletedAt),
        ),
      )
      .returning({
        id: files.id,
        filename: files.filename,
        contentType: files.contentType,
        sizeBytes: files.sizeBytes,
      });
    signal.throwIfAborted();
    return {
      assetId: updated?.id ?? plan.asset.id,
      filename: updated?.filename ?? plan.asset.filename,
      contentType: updated?.contentType ?? outcome.value.contentType,
      size: updated?.sizeBytes ?? outcome.value.sizeBytes,
      status: "ready",
    };
  },
);

/** Resolve durable identity before the provider starts any external work. */
export const prepareCanonicalInputFile$ = command(
  async (
    { set },
    args: CanonicalInputFileArgs & { readonly maxBytes?: number },
    signal: AbortSignal,
  ): Promise<PreparedCanonicalInputFile> => {
    const id = deterministicInputFileId(args.userId, args.scope, args.key);
    const existing = await set(
      findInputFileRow$,
      { id, userId: args.userId },
      signal,
    );
    if (
      existing &&
      existing.deletedAt === null &&
      existing.sizeBytes !== null
    ) {
      return {
        kind: "complete",
        asset: {
          assetId: existing.id,
          filename: existing.filename,
          contentType: existing.contentType,
          size: existing.sizeBytes,
          status: "ready",
        },
      };
    }
    if (
      existing &&
      existing.deletedAt !== null &&
      existing.sizeBytes === null
    ) {
      return {
        kind: "complete",
        asset: {
          assetId: existing.id,
          filename: existing.filename,
          contentType: existing.contentType,
          size: 0,
          status: "failed",
          error: {
            code: "import-failed",
            message: "File could not be imported",
            retryable: false,
          },
        },
      };
    }
    const maxBytes = args.maxBytes ?? MAX_INPUT_FILE_SIZE_BYTES;
    const immediateError = immediateInputError(
      args.contentType,
      args.size,
      maxBytes,
    );
    if (immediateError) {
      return {
        kind: "complete",
        asset: {
          assetId: id,
          filename: args.filename,
          contentType: args.contentType,
          size: args.size ?? 0,
          status: "failed",
          error: immediateError,
        },
      };
    }
    const asset = await set(ensureInputFileRow$, { ...args, id }, signal);
    if (asset.sizeBytes !== null) {
      return {
        kind: "complete",
        asset: {
          assetId: asset.id,
          filename: asset.filename,
          contentType: asset.contentType,
          size: asset.sizeBytes,
          status: "ready",
        },
      };
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

const buildSlackInputImportPlan$ = command(
  async (
    { set },
    args: CanonicalSlackInputFileArgs & {
      readonly id: string;
      readonly fileId: string;
      readonly filename: string;
      readonly contentType: string;
      readonly downloadUrl: string;
      readonly botToken: string;
    },
    signal: AbortSignal,
  ): Promise<PreparedSlackInput> => {
    const asset = await set(
      ensureInputFileRow$,
      {
        ...args,
        source: "slack",
        scope: "slack-input",
        key: args.fileId,
        externalId: args.fileId,
        size: args.file.size,
        provenance: {
          provider: "slack",
          workspaceId: args.workspaceId,
          channelId: args.channelId,
          messageTs: args.messageTs,
          externalFileId: args.fileId,
        },
      },
      signal,
    );
    if (asset.sizeBytes !== null) {
      return {
        kind: "complete",
        asset: {
          assetId: asset.id,
          filename: asset.filename,
          contentType: asset.contentType,
          size: asset.sizeBytes,
          status: "ready",
          slackFileId: args.fileId,
        },
      };
    }
    return {
      kind: "import",
      slackFileId: args.fileId,
      plan: {
        asset,
        userId: args.userId,
        contentType: args.contentType,
        maxBytes: MAX_SLACK_FILE_SIZE_BYTES,
      },
      download: { url: args.downloadUrl, botToken: args.botToken },
    };
  },
);

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
    const id = deterministicInputFileId(args.userId, "slack-input", fileId);
    const existing = await set(
      findInputFileRow$,
      { id, userId: args.userId },
      signal,
    );
    if (
      existing &&
      existing.deletedAt === null &&
      existing.sizeBytes !== null
    ) {
      return {
        kind: "complete",
        asset: {
          assetId: existing.id,
          filename: existing.filename,
          contentType: existing.contentType,
          size: existing.sizeBytes,
          status: "ready",
          slackFileId: fileId,
        },
      };
    }
    if (
      existing &&
      existing.deletedAt !== null &&
      existing.sizeBytes === null
    ) {
      return {
        kind: "complete",
        asset: {
          assetId: existing.id,
          filename: existing.filename,
          contentType: existing.contentType,
          size: 0,
          status: "failed",
          error: {
            code: "import-failed",
            message: "File could not be imported",
            retryable: false,
          },
          slackFileId: fileId,
        },
      };
    }

    const immediateError = immediateSlackInputError(args.file, contentType);
    if (immediateError) {
      return {
        kind: "complete",
        asset: {
          assetId: id,
          filename,
          contentType,
          size: args.file.size ?? 0,
          status: "failed",
          error: immediateError,
          slackFileId: fileId,
        },
      };
    }
    if (!args.botToken) {
      return {
        kind: "complete",
        asset: {
          assetId: id,
          filename,
          contentType,
          size: args.file.size ?? 0,
          status: "failed",
          error: {
            code: "slack-auth-unavailable",
            message: "Slack is not connected, so this file cannot be imported",
            retryable: true,
          },
          slackFileId: fileId,
        },
      };
    }
    const downloadUrl = args.file.url_private_download;
    if (!downloadUrl) {
      throw new Error("Canonical Slack input download URL is missing");
    }

    return await set(
      buildSlackInputImportPlan$,
      {
        ...args,
        id,
        fileId,
        filename,
        contentType,
        downloadUrl,
        botToken: args.botToken,
      },
      signal,
    );
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

export interface PreparedPublishedImFile {
  readonly assetId: string;
  readonly url: string;
  readonly uploadUrl: string;
  readonly uploadHeaders: Readonly<Record<string, string>>;
}

/** Allocate a private `files` row and presigned PUT URL for fire-and-forget IM delivery. */
export const preparePublishedImFile$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly runId: string | null;
      readonly filename: string;
      readonly contentType: string;
      readonly size: number;
      readonly checksumSha256?: string;
    },
    signal: AbortSignal,
  ): Promise<PreparedPublishedImFile | null> => {
    if (args.runId !== null) {
      const [run] = await get(db$)
        .select({ id: agentRuns.id })
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
    }
    const location = await set(
      allocatePrivateArtifact$,
      {
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        size: args.size,
        purpose: "artifact",
        ...(args.runId !== null ? { runId: args.runId } : {}),
        ...(args.checksumSha256 !== undefined
          ? { checksumSha256: args.checksumSha256 }
          : {}),
      },
      signal,
    );
    const uploadUrl = await get(
      generatePresignedPutUrl(
        location.bucket,
        location.key,
        args.contentType,
        {
          usePublicEndpoint: true,
          metadata: location.metadata,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    return {
      assetId: location.id,
      url: location.url,
      uploadUrl,
      uploadHeaders: s3MetadataHeaders(location.metadata),
    };
  },
);

export type FinalizedPublishedImFileResult =
  | {
      readonly ok: true;
      readonly file: PrivateArtifactRecord & { readonly sizeBytes: number };
      readonly url: string;
      readonly bytes?: Buffer;
    }
  | {
      readonly ok: false;
      readonly code:
        | "NOT_FOUND"
        | "INVALID_FILE"
        | "STORAGE_UNAVAILABLE"
        | "storage-verification-failed";
      readonly message: string;
    };

const downloadAndVerifyPublishedImBytes$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly record: PrivateArtifactRecord;
      readonly expectedLength: number;
      readonly maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly ok: true;
        readonly bytes: Buffer;
        readonly checksumSha256: string;
      }
    | Extract<FinalizedPublishedImFileResult, { ok: false }>
  > => {
    if (args.expectedLength > args.maxBytes) {
      return {
        ok: false,
        code: "INVALID_FILE",
        message: "File exceeds the upload size limit",
      };
    }
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          args.bucket,
          args.record.key,
          args.maxBytes,
          signal,
        ),
      ),
      signal,
    );
    if (!downloaded.ok) {
      if (downloaded.error instanceof S3ObjectSizeLimitError) {
        return {
          ok: false,
          code: "INVALID_FILE",
          message: "File exceeds the upload size limit",
        };
      }
      if (
        downloaded.error instanceof Error &&
        downloaded.error.name === "NoSuchKey"
      ) {
        return {
          ok: false,
          code: "INVALID_FILE",
          message: "Uploaded file was not found",
        };
      }
      return {
        ok: false,
        code: "STORAGE_UNAVAILABLE",
        message: "Could not read the uploaded file",
      };
    }
    const bytes = downloaded.value;
    if (bytes.byteLength < 1 || bytes.byteLength !== args.expectedLength) {
      return {
        ok: false,
        code: "INVALID_FILE",
        message: "Uploaded bytes do not match storage metadata",
      };
    }
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      args.record.checksumSha256 &&
      checksumSha256 !== args.record.checksumSha256
    ) {
      return {
        ok: false,
        code: "INVALID_FILE",
        message: "Uploaded bytes do not match the declared checksum",
      };
    }
    return { ok: true, bytes, checksumSha256 };
  },
);

/** Verify uploaded bytes in R2 and synchronously register the `files` + `artifacts` rows. */
export const finalizePublishedImFile$ = command(
  async (
    { get, set },
    args: {
      readonly assetId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly runId: string | null;
      readonly downloadMaxBytes?: number;
      readonly contentTypeOverride?: string;
    },
    signal: AbortSignal,
  ): Promise<FinalizedPublishedImFileResult> => {
    const record = await set(privateArtifactRecord$, args.assetId, signal);
    if (
      !record ||
      record.userId !== args.userId ||
      record.orgId !== args.orgId
    ) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Published file was not found",
      };
    }
    const url = await set(
      resolvePrivateArtifactUrl$,
      { id: record.id, filename: record.filename },
      signal,
    );
    const effectiveContentType = args.contentTypeOverride ?? record.contentType;
    const bucket = privateArtifactsBucket();

    const head = await get(s3ObjectHead(bucket, record.key));
    signal.throwIfAborted();
    if (
      head.kind === "missing" ||
      head.contentLength === undefined ||
      head.contentLength < 1
    ) {
      return {
        ok: false,
        code: "INVALID_FILE",
        message: "Uploaded file failed storage verification",
      };
    }

    let bytes: Buffer | undefined;
    let checksumSha256 = record.checksumSha256;
    if (args.downloadMaxBytes !== undefined) {
      const verified = await set(
        downloadAndVerifyPublishedImBytes$,
        {
          bucket,
          record,
          expectedLength: head.contentLength,
          maxBytes: args.downloadMaxBytes,
        },
        signal,
      );
      if (!verified.ok) {
        return verified;
      }
      bytes = verified.bytes;
      checksumSha256 = verified.checksumSha256;
    }

    const sizeBytes = bytes?.byteLength ?? head.contentLength;
    await set(
      completePrivateArtifact$,
      {
        id: record.id,
        url,
        contentType: effectiveContentType,
        size: sizeBytes,
        ...(checksumSha256 !== null ? { checksumSha256 } : {}),
        ...(args.runId !== null ? { runId: args.runId } : {}),
        registerArtifact: true,
      },
      signal,
    );
    return {
      ok: true,
      file: {
        ...record,
        contentType: effectiveContentType,
        sizeBytes,
        checksumSha256,
        isReady: true,
      },
      url,
      ...(bytes ? { bytes } : {}),
    };
  },
);
