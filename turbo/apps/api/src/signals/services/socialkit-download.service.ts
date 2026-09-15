import { v5 as uuidv5 } from "uuid";

import {
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  socialKitDownloadDeliveredQualitySchema,
  socialKitDownloadFormatSchema,
  socialKitDownloadPlatformSchema,
  socialKitDownloadResponseSchema,
  type SocialKitDownloadListQuery,
  type SocialKitDownloadListResponse,
  type SocialKitDownloadRequest,
  type SocialKitDownloadResponse,
  type SocialKitErrorResponse,
} from "@okouai/api-contracts/contracts/social";
import { socialKitDownloadJobs } from "@okouai/db/schema/socialkit-download-job";
import { command } from "ccstate";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import {
  abortMultipartS3Upload,
  completeMultipartS3Upload,
  createMultipartS3Upload,
  uploadMultipartS3Part,
  type MultipartS3Part,
} from "../external/s3";
import { type Db, writeDb$ } from "../external/db";
import {
  awaitWithSignal,
  onRejection,
  readBoundedResponseText,
  safeJsonParse,
  settle,
  settleIncludingAbort,
  startUntrackedBestEffortCleanup,
} from "../utils";
import {
  allocateArtifactObject$,
  resolveArtifactObject$,
} from "./artifact-storage.service";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { validateScrapeTargetUrl } from "./scrape-target-policy";
import { normalizeSocialKitError } from "./socialkit-error";

const SOCIALKIT_API_BASE = "https://api.socialkit.dev";
const SOCIALKIT_PROVIDER_TIMEOUT_MS = 240_000;
const SOCIALKIT_DOWNLOAD_TIMEOUT_MS = 270_000;
export const SOCIALKIT_RECONCILIATION_TIMEOUT_MS = 280_000;
const MULTIPART_CLEANUP_TIMEOUT_MS = 10_000;
const CLAIM_CLEANUP_TIMEOUT_MS = 10_000;
// SocialKit charges when ready is observed, so durable settlement gets an independent budget.
const READY_SETTLEMENT_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_FILENAME_STEM_CHARS = 120;
// ISO base media files can use a generic `ftyp` brand for either audio or
// video. Buffer enough of a fast-start file to inspect the `moov` track
// handlers before allocating the immutable artifact key.
const MEDIA_SNIFF_BYTES = 64 * 1024;
const MAX_PROVIDER_FAILURE_CODE_CHARS = 128;
const MAX_PROVIDER_FAILURE_MESSAGE_CHARS = 500;
const INVALID_ARTIFACT_FILENAME_CHARS = String.raw`<>:"/\|?*`;
const PROVIDER_FAILURE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PROVIDER_FAILURE_URL_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu;
const PROVIDER_FAILURE_CREDENTIAL_PATTERN =
  /\b(?:access[ _-]?key|api[ _-]?key|authorization|password|token)\s*[:=]\s*\S+/iu;
const PROVIDER_FAILURE_STACK_PATTERN =
  /(?:\bat\s+(?:async\s+)?(?:\S+\s+\()?[^()\s]+:\d+:\d+\)?|\bFile\s+"[^"]+",\s+line\s+\d+)/u;
const RECONCILE_BATCH_SIZE = 2;
const USAGE_NAMESPACE = "42a65d9f-67d6-4bed-ae87-9f80ce1feb79";
const ACTIVE_STATUSES = [
  "processing",
  "materializing",
  "artifact_failed",
] as const;

type DownloadJob = typeof socialKitDownloadJobs.$inferSelect;
type DownloadJobError = NonNullable<DownloadJob["error"]>;

const PROVIDER_DOWNLOAD_FAILED_ERROR = {
  code: "SOCIALKIT_DOWNLOAD_FAILED",
  message: "SocialKit could not prepare the download",
} satisfies DownloadJobError;

const INVALID_PROVIDER_RESPONSE_ERROR = {
  code: "SOCIALKIT_INVALID_DOWNLOAD_RESPONSE",
  message: "SocialKit returned invalid download metadata",
} satisfies DownloadJobError;

interface SocialKitDownloadErrorResponse {
  readonly status: 400 | 404 | 409 | 422 | 429 | 502 | 503;
  readonly body: SocialKitErrorResponse;
}

class ProviderRequestError extends Error {
  readonly details: DownloadJobError;

  constructor(readonly normalized: ReturnType<typeof normalizeSocialKitError>) {
    super(normalized.error.message);
    this.name = "ProviderRequestError";
    this.details = { ...normalized.error, provider: normalized.evidence };
  }
}

type CreateSocialKitDownloadResponse =
  | { readonly status: 202; readonly body: SocialKitDownloadResponse }
  | ManagedUsageErrorResponse
  | SocialKitDownloadErrorResponse;

interface CreateSocialKitDownloadArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: SocialKitDownloadRequest;
  readonly publicBrand: "vm0" | "okou";
}

const providerStartSchema = z.object({
  jobId: z.string().min(1).max(512),
  status: z.enum(["queued", "processing"]),
});

const providerFileSizeMbSchema = z.union([
  z.number().nonnegative(),
  z
    .string()
    .max(32)
    .regex(/^\d+(?:\.\d+)? MB$/u)
    .transform((value) => {
      return Number.parseFloat(value);
    })
    .pipe(z.number().finite().nonnegative()),
]);

const providerReadySchema = z.object({
  jobId: z.string().min(1).max(512),
  status: z.literal("ready"),
  platform: socialKitDownloadPlatformSchema,
  downloadUrl: z.url().max(8192),
  durationSeconds: z.number().int().positive(),
  fileSizeMB: providerFileSizeMbSchema,
  creditsCost: z.number().int().positive(),
  billed: z.literal(true).optional(),
  quality: socialKitDownloadDeliveredQualitySchema,
  format: socialKitDownloadFormatSchema,
  title: z.unknown().optional(),
  thumbnail: z.unknown().optional(),
});

const providerFailedSchema = z.object({
  status: z.literal("failed"),
  errorCode: z
    .string()
    .min(1)
    .max(MAX_PROVIDER_FAILURE_CODE_CHARS)
    .regex(PROVIDER_FAILURE_CODE_PATTERN),
  error: z.string().trim().min(1).max(MAX_PROVIDER_FAILURE_MESSAGE_CHARS),
  retryable: z.unknown().optional(),
});

const providerThumbnailSchema = z
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  });

function errorResponse(
  status: 409 | 502 | 503,
  message: string,
  code: string,
): SocialKitDownloadErrorResponse {
  return { status, body: { error: { message, code } } };
}

function runId(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function externalStatus(job: DownloadJob): SocialKitDownloadResponse["status"] {
  switch (job.status) {
    case "submitting": {
      return "queued";
    }
    case "processing": {
      return "processing";
    }
    case "materializing": {
      return "materializing";
    }
    case "artifact_failed": {
      return "artifact_failed";
    }
    case "provider_failed": {
      return "provider_failed";
    }
    case "completed": {
      return "completed";
    }
  }
}

function responseForJob(job: DownloadJob): SocialKitDownloadResponse {
  const billed = job.creditsCharged !== null;
  // Historical filenames/content types could be request-derived. Do not use
  // them to reconstruct missing delivery evidence from older JSONB writers.
  const deliveredFormat = job.artifact?.format ?? null;
  const hasVideo = deliveredFormat
    ? deliveredFormat === "mp4"
    : job.providerResult?.format === "mp4";
  return socialKitDownloadResponseSchema.parse({
    downloadId: job.id,
    status: externalStatus(job),
    platform: job.request.platform,
    quality: job.request.quality,
    format: job.request.format,
    requested: { quality: job.request.quality, format: job.request.format },
    delivered: {
      quality: hasVideo ? (job.providerResult?.quality ?? null) : null,
      format: deliveredFormat,
    },
    maxDuration: job.request.maxDuration,
    billingCategory: MANAGED_SOCIALKIT_BILLING_CATEGORY,
    provider: job.providerResult,
    billing:
      job.providerResult && billed
        ? {
            quantity: job.providerResult.creditsCost,
            creditsCharged: job.creditsCharged,
          }
        : null,
    artifact: job.artifact,
    error: job.error
      ? {
          code: job.error.code,
          message: job.error.message,
          ...(job.error.reason === undefined
            ? {}
            : { reason: job.error.reason }),
          ...(job.error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: job.error.retryAfterSeconds }),
          ...(job.error.resubmitRetryable === undefined
            ? {}
            : { resubmitRetryable: job.error.resubmitRetryable }),
          retryable:
            (job.status === "processing" || job.status === "artifact_failed") &&
            (job.error.retryable ?? true),
          billed,
        }
      : null,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  });
}

function providerBody(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    value.success === true &&
    "data" in value
  ) {
    return value.data;
  }
  return value;
}

function safeProviderFailureMessage(
  message: string,
  accessKey: string,
): string | null {
  const hasControlCharacter = [...message].some((character) => {
    const codeUnit = character.charCodeAt(0);
    return (
      codeUnit <= 31 ||
      (codeUnit >= 127 && codeUnit <= 159) ||
      codeUnit === 0x20_28 ||
      codeUnit === 0x20_29
    );
  });
  if (
    hasControlCharacter ||
    PROVIDER_FAILURE_URL_PATTERN.test(message) ||
    PROVIDER_FAILURE_CREDENTIAL_PATTERN.test(message) ||
    PROVIDER_FAILURE_STACK_PATTERN.test(message) ||
    message.includes(accessKey)
  ) {
    return null;
  }
  return message;
}

function providerFailureError(
  value: unknown,
  accessKey: string,
): DownloadJobError | null {
  const parsed = providerFailedSchema.safeParse(value);
  const normalized = normalizeSocialKitError(200, value, { accessKey });
  if (
    !parsed.success &&
    normalized.evidence.errorCode === undefined &&
    normalized.evidence.retryable === undefined
  ) {
    return null;
  }
  return {
    code:
      parsed.success && normalized.evidence.errorCode
        ? `SOCIALKIT_PROVIDER_${normalized.evidence.errorCode}`
        : PROVIDER_DOWNLOAD_FAILED_ERROR.code,
    message:
      (parsed.success
        ? safeProviderFailureMessage(parsed.data.error, accessKey)
        : null) ?? PROVIDER_DOWNLOAD_FAILED_ERROR.message,
    reason: normalized.error.reason,
    resubmitRetryable: normalized.error.retryable,
    provider: normalized.evidence,
  };
}

async function providerJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(SOCIALKIT_PROVIDER_TIMEOUT_MS),
    ]),
  });
  const text = await readBoundedResponseText(
    response,
    MAX_PROVIDER_RESPONSE_BYTES,
  );
  if (text.kind === "too_large") {
    throw new Error("SocialKit returned an oversized job response");
  }
  return {
    response,
    body: providerBody(text.text ? safeJsonParse(text.text) : undefined),
  };
}

async function startProviderJob(
  accessKey: string,
  request: SocialKitDownloadRequest,
  signal: AbortSignal,
): Promise<string> {
  const result = await providerJson(
    `${SOCIALKIT_API_BASE}/v2/${request.platform}/download`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-key": accessKey,
      },
      body: JSON.stringify({
        url: request.url,
        max_duration: request.maxDuration,
        quality: request.quality,
        format: request.format,
      }),
    },
    signal,
  );
  if (!result.response.ok) {
    throw new ProviderRequestError(
      normalizeSocialKitError(result.response.status, result.body, {
        accessKey,
        headers: result.response.headers,
      }),
    );
  }
  return providerStartSchema.parse(result.body).jobId;
}

type ProviderPollResult =
  | { readonly status: "processing" }
  | {
      readonly status: "failed";
      readonly error: DownloadJobError | null;
    }
  | { readonly status: "invalid" }
  | {
      readonly status: "ready";
      readonly ready: z.infer<typeof providerReadySchema>;
    };

async function pollProviderJob(
  accessKey: string,
  providerJobId: string,
  signal: AbortSignal,
): Promise<ProviderPollResult> {
  const result = await providerJson(
    `${SOCIALKIT_API_BASE}/v2/downloads/${encodeURIComponent(providerJobId)}`,
    { method: "GET", headers: { "x-access-key": accessKey } },
    signal,
  );
  if (!result.response.ok) {
    if (result.response.status === 404) {
      return { status: "failed", error: null };
    }
    throw new ProviderRequestError(
      normalizeSocialKitError(result.response.status, result.body, {
        accessKey,
        headers: result.response.headers,
      }),
    );
  }
  if (
    typeof result.body !== "object" ||
    result.body === null ||
    !("status" in result.body) ||
    typeof result.body.status !== "string"
  ) {
    return { status: "invalid" };
  }
  if (result.body.status === "failed") {
    return {
      status: "failed",
      error: providerFailureError(result.body, accessKey),
    };
  }
  if (result.body.status === "queued" || result.body.status === "processing") {
    return { status: "processing" };
  }
  if (result.body.status !== "ready") {
    return { status: "invalid" };
  }
  const ready = providerReadySchema.safeParse(result.body);
  return ready.success
    ? { status: "ready", ready: ready.data }
    : { status: "invalid" };
}

interface SniffedMedia {
  readonly contentType: string;
  readonly extension: "mp4" | "m4a" | "mp3";
}

type IsoTrackKind = "audio" | "video";
type IsoContainerKind = "root" | "moov" | "trak" | "mdia";

interface IsoBox {
  readonly type: string;
  readonly payloadStart: number;
  readonly end: number;
}

function leadingBytesAre(
  head: Uint8Array,
  offset: number,
  signature: string,
): boolean {
  if (head.byteLength < offset + signature.length) {
    return false;
  }
  for (let index = 0; index < signature.length; index += 1) {
    if (head[offset + index] !== signature.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function readUint32(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.byteLength) {
    return null;
  }
  return (
    (bytes[offset]! * 0x01_00_00_00 +
      bytes[offset + 1]! * 0x01_00_00 +
      bytes[offset + 2]! * 0x01_00 +
      bytes[offset + 3]!) >>>
    0
  );
}

function readIsoBox(
  bytes: Uint8Array,
  offset: number,
  parentEnd: number,
): IsoBox | null {
  const size = readUint32(bytes, offset);
  if (size === null || offset + 8 > parentEnd) {
    return null;
  }
  const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  let headerSize = 8;
  let boxSize = size;
  if (size === 1) {
    const high = readUint32(bytes, offset + 8);
    const low = readUint32(bytes, offset + 12);
    if (high === null || low === null) {
      return null;
    }
    boxSize = high * 0x01_00_00_00_00 + low;
    headerSize = 16;
  } else if (size === 0) {
    boxSize = parentEnd - offset;
  }
  if (
    !Number.isSafeInteger(boxSize) ||
    boxSize < headerSize ||
    offset + boxSize > parentEnd
  ) {
    return null;
  }
  return {
    type,
    payloadStart: offset + headerSize,
    end: offset + boxSize,
  };
}

function isoHandlerTrackKind(
  bytes: Uint8Array,
  box: IsoBox,
): IsoTrackKind | null {
  const handlerOffset = box.payloadStart + 8;
  if (handlerOffset + 4 > box.end) {
    return null;
  }
  if (leadingBytesAre(bytes, handlerOffset, "vide")) {
    return "video";
  }
  return leadingBytesAre(bytes, handlerOffset, "soun") ? "audio" : null;
}

function collectIsoTrackKinds(
  bytes: Uint8Array,
  start: number,
  end: number,
  container: IsoContainerKind,
  tracks: Set<IsoTrackKind>,
): void {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readIsoBox(bytes, offset, end);
    if (!box) {
      return;
    }
    if (container === "mdia" && box.type === "hdlr") {
      const track = isoHandlerTrackKind(bytes, box);
      if (track) {
        tracks.add(track);
      }
    } else {
      const childContainer =
        container === "root" && box.type === "moov"
          ? "moov"
          : container === "moov" && box.type === "trak"
            ? "trak"
            : container === "trak" && box.type === "mdia"
              ? "mdia"
              : null;
      if (childContainer) {
        collectIsoTrackKinds(
          bytes,
          box.payloadStart,
          box.end,
          childContainer,
          tracks,
        );
      }
    }
    offset = box.end;
  }
}

function sniffIsoMedia(head: Uint8Array): SniffedMedia | null {
  const tracks = new Set<IsoTrackKind>();
  collectIsoTrackKinds(head, 0, head.byteLength, "root", tracks);
  if (tracks.has("video")) {
    return { contentType: "video/mp4", extension: "mp4" };
  }
  if (tracks.has("audio")) {
    return { contentType: "audio/mp4", extension: "m4a" };
  }
  return leadingBytesAre(head, 8, "M4A") || leadingBytesAre(head, 8, "M4B")
    ? { contentType: "audio/mp4", extension: "m4a" }
    : null;
}

/**
 * SocialKit echoes back only the format that was requested, and the artifact CDN
 * carries no trustworthy media type, so the container and available track
 * handlers are read from the leading file structure instead. A `format=mp4`
 * request can still resolve to an audio-only file upstream, and filing those
 * bytes as `video/mp4` leaves an artifact that no video consumer can decode.
 * Returns null when the media is unrecognized, which keeps the requested format
 * as the recorded media type.
 */
function sniffMedia(head: Uint8Array): SniffedMedia | null {
  if (leadingBytesAre(head, 0, "ID3")) {
    return { contentType: "audio/mpeg", extension: "mp3" };
  }
  if (leadingBytesAre(head, 4, "ftyp")) {
    return sniffIsoMedia(head);
  }
  // MPEG audio frame sync: eleven set bits followed by a non-reserved layer.
  const sync = head[1];
  if (
    head[0] === 0xff &&
    sync !== undefined &&
    (sync & 0xe0) === 0xe0 &&
    (sync & 0x06) !== 0x00
  ) {
    return { contentType: "audio/mpeg", extension: "mp3" };
  }
  return null;
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchSafeSocialKitArtifact(
  initialUrl: string,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const target = await awaitWithSignal(
      validateScrapeTargetUrl(currentUrl),
      signal,
    );
    signal.throwIfAborted();
    if (typeof target === "string" || target.url.protocol !== "https:") {
      throw new Error("SocialKit returned an unsafe artifact URL");
    }
    const response = await fetch(target.url, {
      redirect: "manual",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(SOCIALKIT_DOWNLOAD_TIMEOUT_MS),
      ]),
    });
    signal.throwIfAborted();
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("SocialKit artifact redirect is invalid");
    }
    currentUrl = new URL(location, target.url).toString();
  }
  throw new Error("SocialKit artifact redirected too many times");
}

interface ArtifactDownload {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  // The leading bytes already pulled off the stream to identify the media.
  // The upload consumes them before draining the rest of the reader.
  readonly head: Uint8Array;
  readonly media: SniffedMedia | null;
}

async function readMediaHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  while (bufferedBytes < MEDIA_SNIFF_BYTES) {
    const next = await reader.read();
    signal.throwIfAborted();
    if (next.done) {
      break;
    }
    chunks.push(next.value);
    bufferedBytes += next.value.byteLength;
  }
  return concatChunks(chunks, bufferedBytes);
}

/**
 * Start the artifact download and read a bounded prefix to identify its media.
 * The filename and content type are decided from this before the artifact object
 * is allocated, and the same open stream then carries the whole body into R2,
 * so the artifact is fetched exactly once.
 *
 * The caller owns the returned reader and must cancel it on every path that
 * does not hand it to `streamDownloadToArtifact$`.
 */
async function openArtifactDownload(
  downloadUrl: string,
  signal: AbortSignal,
): Promise<ArtifactDownload> {
  const response = await fetchSafeSocialKitArtifact(downloadUrl, signal);
  signal.throwIfAborted();
  if (!response.ok || !response.body) {
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    throw new Error("SocialKit artifact download failed");
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_BYTES) {
    startUntrackedBestEffortCleanup(response.body.cancel());
    throw new Error("SocialKit artifact exceeds the 2 GiB limit");
  }
  const reader = response.body.getReader();
  const head = await onRejection(readMediaHead(reader, signal), () => {
    startUntrackedBestEffortCleanup(reader.cancel());
  });
  return { reader, head, media: sniffMedia(head) };
}

const streamDownloadToArtifact$ = command(
  async (
    { get },
    args: {
      readonly download: ArtifactDownload;
      readonly bucket: string;
      readonly key: string;
      readonly contentType: string;
      readonly metadata: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const parts: MultipartS3Part[] = [];
    const { reader } = args.download;
    let pendingHead: Uint8Array | null =
      args.download.head.byteLength > 0 ? args.download.head : null;
    const nextChunk = async (): Promise<Uint8Array | null> => {
      if (pendingHead) {
        const chunk = pendingHead;
        pendingHead = null;
        return chunk;
      }
      const next = await reader.read();
      signal.throwIfAborted();
      return next.done ? null : next.value;
    };
    let uploadId: string | undefined;
    let chunks: Uint8Array[] = [];
    let bufferedBytes = 0;
    let totalBytes = 0;

    const uploadBuffered = async (): Promise<void> => {
      if (bufferedBytes === 0) {
        return;
      }
      if (!uploadId) {
        throw new Error("SocialKit multipart upload was not initialized");
      }
      const part = await get(
        uploadMultipartS3Part(
          {
            bucket: args.bucket,
            key: args.key,
            uploadId,
            partNumber: parts.length + 1,
            body: concatChunks(chunks, bufferedBytes),
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      parts.push(part);
      chunks = [];
      bufferedBytes = 0;
    };

    return await onRejection(
      (async (): Promise<number> => {
        uploadId = await get(
          createMultipartS3Upload(
            args.bucket,
            args.key,
            args.contentType,
            args.metadata,
            signal,
          ),
        );
        signal.throwIfAborted();
        while (true) {
          const chunk = await nextChunk();
          if (!chunk) {
            break;
          }
          let offset = 0;
          while (offset < chunk.byteLength) {
            const remaining = MULTIPART_PART_BYTES - bufferedBytes;
            const length = Math.min(remaining, chunk.byteLength - offset);
            const piece = chunk.subarray(offset, offset + length);
            chunks.push(piece);
            bufferedBytes += piece.byteLength;
            totalBytes += piece.byteLength;
            if (totalBytes > MAX_DOWNLOAD_BYTES) {
              throw new Error("SocialKit artifact exceeds the 2 GiB limit");
            }
            offset += length;
            if (bufferedBytes === MULTIPART_PART_BYTES) {
              await uploadBuffered();
              signal.throwIfAborted();
            }
          }
        }
        if (totalBytes === 0) {
          throw new Error("SocialKit returned an empty artifact");
        }
        await uploadBuffered();
        signal.throwIfAborted();
        await get(
          completeMultipartS3Upload(
            args.bucket,
            args.key,
            uploadId,
            parts,
            signal,
          ),
        );
        signal.throwIfAborted();
        reader.releaseLock();
        return totalBytes;
      })(),
      async () => {
        startUntrackedBestEffortCleanup(reader.cancel());
        if (uploadId) {
          await settleIncludingAbort(
            get(
              abortMultipartS3Upload(
                args.bucket,
                args.key,
                uploadId,
                AbortSignal.timeout(MULTIPART_CLEANUP_TIMEOUT_MS),
              ),
            ),
          );
        }
      },
    );
  },
);

function usageIdempotencyKey(downloadId: string): string {
  return uuidv5(
    `${downloadId}:${MANAGED_SOCIALKIT_BILLING_CATEGORY}`,
    USAGE_NAMESPACE,
  );
}

function providerCreditsPerMinute(media: {
  readonly quality: string;
  readonly format: SocialKitDownloadRequest["format"];
}): number {
  return media.format === "mp4" && Number.parseInt(media.quality, 10) >= 720
    ? 4
    : 1;
}

function readyMetadataIsValid(
  job: DownloadJob,
  ready: z.infer<typeof providerReadySchema>,
): boolean {
  const minutes = Math.ceil(ready.durationSeconds / 60);
  const requestedRate = providerCreditsPerMinute(job.request);
  const deliveredRate =
    job.request.platform === "tiktok"
      ? Math.min(requestedRate, providerCreditsPerMinute(ready))
      : requestedRate;
  const expectedCredits = minutes * deliveredRate;
  const maximumCredits =
    Math.ceil(job.request.maxDuration / 60) * requestedRate;
  // SocialKit retains legacy account rates for 30 days. Accept only the exact
  // old or current cost, never arbitrary bounded usage. Remove the old-rate
  // allowance after the managed account transition AND recoverable legacy jobs
  // have drained; a paid job's refresh must not reprice its original usage.
  const validCost =
    ready.creditsCost === expectedCredits || ready.creditsCost === minutes;
  return !(
    ready.jobId !== job.providerJobId ||
    ready.platform !== job.request.platform ||
    ready.format !== job.request.format ||
    ready.durationSeconds > job.request.maxDuration ||
    !validCost ||
    ready.creditsCost > maximumCredits ||
    (job.providerResult !== null &&
      (ready.creditsCost !== job.providerResult.creditsCost ||
        ready.durationSeconds !== job.providerResult.durationSeconds))
  );
}

async function deferClaimedJob(
  writeDb: Db,
  job: DownloadJob,
  error: DownloadJobError | undefined,
  signal: AbortSignal,
): Promise<void> {
  const [current] = await writeDb
    .select({ creditsCharged: socialKitDownloadJobs.creditsCharged })
    .from(socialKitDownloadJobs)
    .where(
      and(
        eq(socialKitDownloadJobs.id, job.id),
        inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
      ),
    );
  signal.throwIfAborted();
  const billed = current !== undefined && current.creditsCharged !== null;
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: billed ? "artifact_failed" : "processing",
      error: error ?? {
        code: billed
          ? "ARTIFACT_MATERIALIZATION_FAILED"
          : "SOCIALKIT_RECONCILIATION_FAILED",
        message: billed
          ? "The artifact could not be materialized"
          : "The SocialKit download could not be reconciled yet",
      },
      retryCount: sql`${socialKitDownloadJobs.retryCount} + 1`,
      claimExpiresAt: sql`now() + GREATEST(LEAST(30, ${socialKitDownloadJobs.retryCount} + 1) * 60, ${error?.retryAfterSeconds ?? 0}) * interval '1 second'`,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(socialKitDownloadJobs.id, job.id),
        inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
      ),
    );
  signal.throwIfAborted();
}

async function startAndPersistProviderJob(
  writeDb: Db,
  created: DownloadJob,
  accessKey: string,
  request: SocialKitDownloadRequest,
): Promise<
  | { readonly job: DownloadJob }
  | { readonly failure: SocialKitDownloadErrorResponse }
> {
  const started = await settleIncludingAbort(
    startProviderJob(
      accessKey,
      request,
      AbortSignal.timeout(SOCIALKIT_PROVIDER_TIMEOUT_MS),
    ),
  );
  if (!started.ok) {
    const normalized =
      started.error instanceof ProviderRequestError
        ? started.error.normalized
        : undefined;
    const failure: SocialKitDownloadErrorResponse = normalized
      ? { status: normalized.status, body: { error: normalized.error } }
      : {
          status: 502,
          body: {
            error: {
              code: "SOCIALKIT_DOWNLOAD_START_FAILED",
              message: "SocialKit could not start the download",
              retryable: false,
            },
          },
        };
    await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "provider_failed",
        error: {
          ...failure.body.error,
          ...(normalized
            ? {
                provider: normalized.evidence,
                resubmitRetryable: normalized.error.retryable,
              }
            : {}),
        },
        updatedAt: nowDate(),
        completedAt: nowDate(),
      })
      .where(eq(socialKitDownloadJobs.id, created.id));
    return { failure };
  }

  const [processing] = await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "processing",
      providerJobId: started.value,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(socialKitDownloadJobs.id, created.id),
        eq(socialKitDownloadJobs.status, "submitting"),
      ),
    )
    .returning();
  if (!processing) {
    throw new Error("Failed to persist SocialKit provider job");
  }
  return { job: processing };
}

export const createSocialKitDownload$ = command(
  async (
    { set },
    args: CreateSocialKitDownloadArgs,
    signal: AbortSignal,
  ): Promise<CreateSocialKitDownloadResponse> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    if (!accessKey) {
      return errorResponse(
        503,
        "Okou SocialKit provider is not configured",
        "NOT_CONFIGURED",
      );
    }
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runId(args.auth),
        resource: {
          kind: "social",
          provider: "socialkit",
          category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
          quantity:
            Math.ceil(args.body.maxDuration / 60) *
            providerCreditsPerMinute(args.body),
        },
        label: "Okou SocialKit download",
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const writeDb = set(writeDb$);
    const [created] = await writeDb
      .insert(socialKitDownloadJobs)
      .values({
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runId(args.auth),
        publicBrand: args.publicBrand,
        request: args.body,
      })
      .onConflictDoNothing()
      .returning();
    signal.throwIfAborted();
    if (!created) {
      return errorResponse(
        409,
        "Another social media download is already in progress",
        "DOWNLOAD_IN_PROGRESS",
      );
    }

    const processing = await startAndPersistProviderJob(
      writeDb,
      created,
      accessKey,
      args.body,
    );
    signal.throwIfAborted();
    if ("failure" in processing) {
      return processing.failure;
    }

    return { status: 202, body: responseForJob(processing.job) };
  },
);

export const getSocialKitDownload$ = command(
  async (
    { set },
    args: {
      readonly downloadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<SocialKitDownloadResponse | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .select()
      .from(socialKitDownloadJobs)
      .where(
        and(
          eq(socialKitDownloadJobs.id, args.downloadId),
          eq(socialKitDownloadJobs.orgId, args.orgId),
          eq(socialKitDownloadJobs.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
    return job ? responseForJob(job) : null;
  },
);

export const listSocialKitDownloads$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly query: SocialKitDownloadListQuery;
    },
    signal: AbortSignal,
  ): Promise<SocialKitDownloadListResponse> => {
    const db = set(writeDb$);
    const { limit, cursor, status } = args.query;
    const anchor = alias(socialKitDownloadJobs, "download_cursor");
    const rows = await db
      .select()
      .from(socialKitDownloadJobs)
      .where(
        and(
          eq(socialKitDownloadJobs.orgId, args.orgId),
          eq(socialKitDownloadJobs.userId, args.userId),
          status === "active"
            ? inArray(socialKitDownloadJobs.status, [
                "submitting",
                ...ACTIVE_STATUSES,
              ])
            : status === undefined
              ? undefined
              : eq(
                  socialKitDownloadJobs.status,
                  status === "queued" ? "submitting" : status,
                ),
          cursor === undefined
            ? undefined
            : lt(
                sql`(${socialKitDownloadJobs.createdAt}, ${socialKitDownloadJobs.id})`,
                db
                  .select({ createdAt: anchor.createdAt, id: anchor.id })
                  .from(anchor)
                  .where(
                    and(
                      eq(anchor.id, cursor),
                      eq(anchor.orgId, args.orgId),
                      eq(anchor.userId, args.userId),
                    ),
                  ),
              ),
        ),
      )
      .orderBy(
        desc(socialKitDownloadJobs.createdAt),
        desc(socialKitDownloadJobs.id),
      )
      .limit(limit + 1);
    signal.throwIfAborted();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      downloads: page.map((job) => {
        return {
          ...responseForJob(job),
          request: job.request,
          resumeCommand:
            job.status === "provider_failed"
              ? null
              : `okou social download --resume ${job.id}`,
        };
      }),
      nextCursor: rows.length > limit && last ? last.id : null,
    };
  },
);

const claimSocialKitDownload$ = command(
  async (
    { set },
    downloadId: string,
    signal: AbortSignal,
  ): Promise<DownloadJob | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .update(socialKitDownloadJobs)
      .set({
        claimExpiresAt: sql`now() + interval '15 minutes'`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(socialKitDownloadJobs.id, downloadId),
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
          or(
            isNull(socialKitDownloadJobs.claimExpiresAt),
            lt(socialKitDownloadJobs.claimExpiresAt, nowDate()),
          ),
        ),
      )
      .returning();
    signal.throwIfAborted();
    return job ?? null;
  },
);

type ProviderReady = z.infer<typeof providerReadySchema>;

function safeProviderResult(ready: ProviderReady) {
  const thumbnail = providerThumbnailSchema.safeParse(ready.thumbnail);
  const downloadUrl = new URL(ready.downloadUrl);
  downloadUrl.hash = "";
  const thumbnailUrl = thumbnail.success ? new URL(thumbnail.data) : null;
  if (thumbnailUrl) {
    thumbnailUrl.hash = "";
  }
  const safeThumbnail =
    thumbnail.success && thumbnailUrl?.href !== downloadUrl.href
      ? thumbnail.data
      : undefined;
  return {
    durationSeconds: ready.durationSeconds,
    fileSizeMB: ready.fileSizeMB,
    creditsCost: ready.creditsCost,
    quality: ready.quality,
    format: ready.format,
    ...(typeof ready.title === "string" && ready.title.length <= 1000
      ? { title: ready.title }
      : {}),
    ...(safeThumbnail ? { thumbnail: safeThumbnail } : {}),
  };
}

function artifactFilename(
  title: string | undefined,
  id: string,
  fileExtension: string,
): string {
  const extension = `.${fileExtension}`;
  const sanitizedTitle = [...(title?.trim() ?? "")]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        (codePoint < 32 ||
          codePoint === 127 ||
          INVALID_ARTIFACT_FILENAME_CHARS.includes(character))
        ? "_"
        : character;
    })
    .join("");
  const titleWithoutExtension = sanitizedTitle.toLowerCase().endsWith(extension)
    ? sanitizedTitle.slice(0, -extension.length)
    : sanitizedTitle;
  const stem = [...titleWithoutExtension]
    .slice(0, MAX_ARTIFACT_FILENAME_STEM_CHARS)
    .join("")
    .trim()
    .replace(/[. ]+$/gu, "");
  return `${stem || `download-${id.slice(0, 8)}`}${extension}`;
}

const settleSocialKitDownloadUsage$ = command(
  async (
    { set },
    args: { readonly job: DownloadJob; readonly quantity: number },
    signal: AbortSignal,
  ): Promise<number> => {
    if (args.job.creditsCharged !== null) {
      return args.job.creditsCharged;
    }
    return await set(
      recordManagedUsage$,
      {
        actor: {
          orgId: args.job.orgId,
          userId: args.job.userId,
          ...(args.job.runId ? { runId: args.job.runId } : {}),
        },
        resource: {
          kind: "social",
          provider: "socialkit",
          category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
          quantity: args.quantity,
        },
        label: "SocialKit download",
        idempotencyKey: usageIdempotencyKey(args.job.id),
      },
      signal,
    );
  },
);

const persistAndSettleSocialKitDownloadUsage$ = command(
  async (
    { set },
    args: {
      readonly job: DownloadJob;
      readonly providerResult: NonNullable<DownloadJob["providerResult"]>;
    },
    signal: AbortSignal,
  ): Promise<DownloadJob> => {
    const writeDb = set(writeDb$);
    const [readyJob] = await writeDb
      .update(socialKitDownloadJobs)
      .set({
        providerResult: args.providerResult,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(socialKitDownloadJobs.id, args.job.id),
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!readyJob) {
      throw new Error("Failed to persist SocialKit ready metadata");
    }

    const creditsCharged = await set(
      settleSocialKitDownloadUsage$,
      { job: readyJob, quantity: args.providerResult.creditsCost },
      signal,
    );
    const [materializing] = await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "materializing",
        creditsCharged,
        error: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(socialKitDownloadJobs.id, args.job.id),
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!materializing) {
      throw new Error("Failed to persist SocialKit usage settlement");
    }
    return materializing;
  },
);

interface StoredArtifactObject {
  readonly key: string;
  readonly url: string;
  readonly sizeBytes: number;
}

const DOWNLOAD_CONTENT_TYPES = {
  mp4: "video/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
} satisfies Record<SocialKitDownloadRequest["format"], string>;

const materializeSocialKitArtifact$ = command(
  async (
    { set },
    args: {
      readonly job: DownloadJob;
      readonly ready: ProviderReady;
      readonly providerResult: NonNullable<DownloadJob["providerResult"]>;
    },
    signal: AbortSignal,
  ): Promise<NonNullable<DownloadJob["artifact"]>> => {
    const download = await openArtifactDownload(args.ready.downloadUrl, signal);
    const media = download.media;
    const filename = artifactFilename(
      args.providerResult.title,
      args.job.id,
      media?.extension ?? args.job.request.format,
    );
    const contentType =
      media?.contentType ?? DOWNLOAD_CONTENT_TYPES[args.job.request.format];
    // The artifact key is derived from the sniffed extension, so the download
    // must already be open before an object stored by an earlier attempt can be
    // looked up. Every retry re-polls the provider and gets a fresh
    // `downloadUrl`, so reopening it on a recovery pass costs one request
    // rather than depending on a link that has since expired.
    const stored = await onRejection(
      (async (): Promise<StoredArtifactObject> => {
        const existing = await set(
          resolveArtifactObject$,
          {
            userId: args.job.userId,
            id: args.job.id,
            filenameHint: filename,
            variant: "socialkit",
          },
          signal,
        );
        if (existing) {
          // A previous attempt already stored this object, so drop the stream
          // instead of downloading a body nothing will consume.
          startUntrackedBestEffortCleanup(download.reader.cancel());
          return {
            key: existing.key,
            url: existing.url,
            sizeBytes: existing.size,
          };
        }
        const location = await set(
          allocateArtifactObject$,
          {
            userId: args.job.userId,
            id: args.job.id,
            variant: "socialkit",
            filename,
            publicBrand: args.job.publicBrand,
          },
          signal,
        );
        const sizeBytes = await set(
          streamDownloadToArtifact$,
          {
            download,
            bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
            key: location.key,
            contentType,
            metadata: location.metadata,
          },
          signal,
        );
        return { key: location.key, url: location.url, sizeBytes };
      })(),
      () => {
        // `streamDownloadToArtifact$` cancels the reader on its own failures.
        // This covers the window before it takes ownership, where a rejected
        // lookup or allocation would otherwise leave the response body open.
        startUntrackedBestEffortCleanup(download.reader.cancel());
      },
    );
    signal.throwIfAborted();
    const artifact = {
      id: args.job.id,
      url: stored.url,
      filename,
      contentType,
      sizeBytes: stored.sizeBytes,
      format: media?.extension ?? null,
    };
    await set(
      recordWebUploadedFile$,
      {
        runId: args.job.runId ?? undefined,
        externalId: artifact.id,
        userId: args.job.userId,
        orgId: args.job.orgId,
        filename: artifact.filename,
        contentType: artifact.contentType,
        sizeBytes: artifact.sizeBytes,
        url: artifact.url,
        s3Key: stored.key,
        publicBrand: args.job.publicBrand,
        metadata: {
          provider: "socialkit",
          providerJobId: args.job.providerJobId,
          platform: args.job.request.platform,
          durationSeconds: args.providerResult.durationSeconds,
          creditsCost: args.providerResult.creditsCost,
        },
      },
      signal,
    );
    return artifact;
  },
);

const completeReadySocialKitDownload$ = command(
  async (
    { set },
    args: { readonly job: DownloadJob; readonly ready: ProviderReady },
    signal: AbortSignal,
  ): Promise<void> => {
    const providerResult =
      args.job.providerResult ?? safeProviderResult(args.ready);
    const settledJob = await set(
      persistAndSettleSocialKitDownloadUsage$,
      { job: args.job, providerResult },
      AbortSignal.timeout(READY_SETTLEMENT_TIMEOUT_MS),
    );
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    const artifact = await set(
      materializeSocialKitArtifact$,
      { job: settledJob, ready: args.ready, providerResult },
      signal,
    );
    await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "completed",
        providerResult,
        creditsCharged: settledJob.creditsCharged,
        artifact,
        error: null,
        claimExpiresAt: null,
        updatedAt: nowDate(),
        completedAt: nowDate(),
      })
      .where(eq(socialKitDownloadJobs.id, args.job.id));
  },
);

async function recordProcessingPoll(
  writeDb: Db,
  job: DownloadJob,
): Promise<void> {
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "processing",
      error: null,
      retryCount: 0,
      claimExpiresAt: null,
      updatedAt: nowDate(),
    })
    .where(eq(socialKitDownloadJobs.id, job.id));
}

async function recordProviderFailure(
  writeDb: Db,
  job: DownloadJob,
  signal: AbortSignal,
  error: DownloadJobError,
): Promise<void> {
  if (job.creditsCharged !== null) {
    await deferClaimedJob(writeDb, job, undefined, signal);
    return;
  }
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "provider_failed",
      error,
      claimExpiresAt: null,
      updatedAt: nowDate(),
      completedAt: nowDate(),
    })
    .where(eq(socialKitDownloadJobs.id, job.id));
}

export const reconcileSocialKitDownload$ = command(
  async (
    { set },
    downloadId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    if (!accessKey) {
      return false;
    }
    let job = await set(claimSocialKitDownload$, downloadId, signal);
    const providerJobId = job?.providerJobId;
    if (!job || !providerJobId) {
      return false;
    }
    const writeDb = set(writeDb$);
    if (job.providerResult && job.creditsCharged === null) {
      const recovered = await settle(
        set(
          persistAndSettleSocialKitDownloadUsage$,
          { job, providerResult: job.providerResult },
          AbortSignal.timeout(READY_SETTLEMENT_TIMEOUT_MS),
        ),
      );
      if (signal.aborted) {
        await settleIncludingAbort(
          deferClaimedJob(
            writeDb,
            job,
            undefined,
            AbortSignal.timeout(CLAIM_CLEANUP_TIMEOUT_MS),
          ),
        );
      }
      signal.throwIfAborted();
      if (!recovered.ok) {
        await deferClaimedJob(writeDb, job, undefined, signal);
        signal.throwIfAborted();
        return true;
      }
      job = recovered.value;
    }
    return await onRejection(
      (async (): Promise<boolean> => {
        const poll = await settle(
          pollProviderJob(accessKey, providerJobId, signal),
        );
        signal.throwIfAborted();
        if (!poll.ok) {
          await deferClaimedJob(
            writeDb,
            job,
            poll.error instanceof ProviderRequestError
              ? poll.error.details
              : undefined,
            signal,
          );
          return true;
        }
        if (poll.value.status === "processing") {
          if (job.creditsCharged === null) {
            await recordProcessingPoll(writeDb, job);
          } else {
            await deferClaimedJob(writeDb, job, undefined, signal);
          }
          signal.throwIfAborted();
          return true;
        }
        if (poll.value.status === "failed") {
          await recordProviderFailure(
            writeDb,
            job,
            signal,
            poll.value.error ?? PROVIDER_DOWNLOAD_FAILED_ERROR,
          );
          signal.throwIfAborted();
          return true;
        }
        if (poll.value.status === "invalid") {
          await recordProviderFailure(
            writeDb,
            job,
            signal,
            INVALID_PROVIDER_RESPONSE_ERROR,
          );
          signal.throwIfAborted();
          return true;
        }
        if (!readyMetadataIsValid(job, poll.value.ready)) {
          await recordProviderFailure(
            writeDb,
            job,
            signal,
            INVALID_PROVIDER_RESPONSE_ERROR,
          );
          signal.throwIfAborted();
          return true;
        }
        const completed = await settle(
          set(
            completeReadySocialKitDownload$,
            { job, ready: poll.value.ready },
            signal,
          ),
        );
        signal.throwIfAborted();
        if (!completed.ok) {
          await deferClaimedJob(writeDb, job, undefined, signal);
          return true;
        }
        return true;
      })(),
      async () => {
        if (!signal.aborted) {
          return;
        }
        await settleIncludingAbort(
          deferClaimedJob(
            writeDb,
            job,
            undefined,
            AbortSignal.timeout(CLAIM_CLEANUP_TIMEOUT_MS),
          ),
        );
      },
    );
  },
);

export const reconcileSocialKitDownloads$ = command(
  async (
    { set },
    args: { readonly candidateIds?: readonly string[] },
    signal: AbortSignal,
  ): Promise<number> => {
    const writeDb = set(writeDb$);
    const candidateScope = args.candidateIds
      ? inArray(socialKitDownloadJobs.id, args.candidateIds)
      : undefined;
    const staleCandidates = await writeDb
      .select({ id: socialKitDownloadJobs.id })
      .from(socialKitDownloadJobs)
      .where(
        and(
          eq(socialKitDownloadJobs.status, "submitting"),
          lt(
            socialKitDownloadJobs.createdAt,
            sql`now() - interval '15 minutes'`,
          ),
          candidateScope,
        ),
      )
      .orderBy(socialKitDownloadJobs.createdAt)
      .limit(RECONCILE_BATCH_SIZE);
    signal.throwIfAborted();
    const staleSubmissions =
      staleCandidates.length === 0
        ? []
        : await writeDb
            .update(socialKitDownloadJobs)
            .set({
              status: "provider_failed",
              error: {
                code: "SOCIALKIT_DOWNLOAD_START_INTERRUPTED",
                message: "The SocialKit download start was interrupted",
              },
              updatedAt: nowDate(),
              completedAt: nowDate(),
            })
            .where(
              and(
                inArray(
                  socialKitDownloadJobs.id,
                  staleCandidates.map((candidate) => {
                    return candidate.id;
                  }),
                ),
                eq(socialKitDownloadJobs.status, "submitting"),
              ),
            )
            .returning({ id: socialKitDownloadJobs.id });
    signal.throwIfAborted();
    const activeLimit = RECONCILE_BATCH_SIZE - staleSubmissions.length;
    if (activeLimit === 0) {
      return staleSubmissions.length;
    }
    const jobs = await writeDb
      .select({ id: socialKitDownloadJobs.id })
      .from(socialKitDownloadJobs)
      .where(
        and(
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
          or(
            isNull(socialKitDownloadJobs.claimExpiresAt),
            lt(socialKitDownloadJobs.claimExpiresAt, nowDate()),
          ),
          candidateScope,
        ),
      )
      .orderBy(socialKitDownloadJobs.updatedAt)
      .limit(activeLimit);
    signal.throwIfAborted();
    let processed = staleSubmissions.length;
    for (const job of jobs) {
      if (await set(reconcileSocialKitDownload$, job.id, signal)) {
        processed += 1;
      }
    }
    return processed;
  },
);
