import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import {
  readArtifactDownload,
  resolveOwnedArtifactReference,
} from "./artifact-references";
import { isUtf8 } from "node:buffer";
import { createWriteStream, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { MIMEType } from "node:util";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  builtInGenerationContract,
  type BuiltInGenerationAcceptedResponse,
  type BuiltInGenerationResponse,
} from "@okouai/api-contracts/contracts/built-in-generation";
import {
  ApiRequestError,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";
import {
  cliClientHeaderApi,
  headersWithCliClientHeaders,
} from "../client-headers";
import { assertPrivateArtifactUrl } from "../../artifact-url";
import { getPlatformOrigin } from "../../platform-url";
import { downloadHostedSiteFiles } from "../../host/clone-hosted-site";
import {
  createRealtimeNotifier,
  type RealtimeNotifier,
} from "../../realtime-notifier";

const IMAGE_GENERATION_POLL_INTERVAL_MS = 2_000;
const IMAGE_GENERATION_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const IMAGE_GENERATION_REQUEST_TIMEOUT_MS = 60_000;

function builtInGenerationClient(baseUrl: string, token: string) {
  return initClient(builtInGenerationContract, {
    baseUrl,
    baseHeaders: { Authorization: `Bearer ${token}` },
    api: cliClientHeaderApi,
  });
}

function generationRequestSignal(owner?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(IMAGE_GENERATION_REQUEST_TIMEOUT_MS);
  return owner ? AbortSignal.any([owner, deadline]) : deadline;
}

export type ImageGenerationAcceptedResponse =
  BuiltInGenerationAcceptedResponse & {
    readonly type: "image";
  };

type ImageGenerationResponse = Omit<
  BuiltInGenerationResponse,
  "type" | "result"
> & {
  readonly type: "image";
  readonly result?: GenerateWebImageResult;
};

/**
 * Known extension → MIME map for accurate upload metadata. Unknown extensions
 * remain opaque as `application/octet-stream`.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".psd": "image/vnd.adobe.photoshop",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpga",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".wave": "audio/wave",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".har": "application/json",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".tsv": "text/tab-separated-values",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docm": "application/vnd.ms-word.document.macroenabled.12",
  ".dotm": "application/vnd.ms-word.template.macroenabled.12",
  ".dotx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  ".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
  ".xltm": "application/vnd.ms-excel.template.macroenabled.12",
  ".xltx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".potm": "application/vnd.ms-powerpoint.template.macroenabled.12",
  ".potx":
    "application/vnd.openxmlformats-officedocument.presentationml.template",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".ppsx":
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ".ppsm": "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".key": "application/vnd.apple.keynote",
  ".parquet": "application/vnd.apache.parquet",
  ".sqlite": "application/vnd.sqlite3",
  ".sqlite3": "application/vnd.sqlite3",
  ".db": "application/vnd.sqlite3",
  ".epub": "application/epub+zip",
  ".ai": "application/postscript",
};

export function inferWebUploadContentType(localPath: string): string {
  const ext = extname(localPath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

const UTF8_TEXT_ARTIFACT_TYPES = new Set([
  "text/markdown",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
]);

function textArtifactContentType(contentType: string): {
  readonly contentType: string;
  readonly validateUtf8: boolean;
} {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!UTF8_TEXT_ARTIFACT_TYPES.has(base)) {
    return { contentType, validateUtf8: false };
  }
  const parsed = new MIMEType(contentType);
  if (parsed.params.has("charset")) {
    return { contentType, validateUtf8: false };
  }
  return {
    contentType: `${parsed.essence}; charset=utf-8`,
    validateUtf8: true,
  };
}

interface DownloadWebFileResult {
  path: string;
  mimetype: string;
  size: number;
  fileCount?: number;
  entrypoint?: string;
}

/** Only the configured API origin may receive the CLI credential. */
export async function webFileReferenceId(
  value: string,
): Promise<string | null> {
  const reference = parseArtifactReference(value, await getPlatformOrigin());
  if (reference)
    return (
      reference.id ??
      (await resolveOwnedArtifactReference(
        `${reference.hash}${reference.extension}`,
        "file",
      ))
    );
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  const baseUrl = new URL(await getBaseUrl());
  if (
    url.origin !== baseUrl.origin ||
    url.pathname !== "/api/web/download-file" ||
    url.username ||
    url.password
  ) {
    return null;
  }
  const id = url.searchParams.get("file_id");
  if (!id) {
    throw new Error("Artifact reference is missing file_id");
  }
  return id;
}

async function fetchWebFile(fileId: string): Promise<Response> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL("/api/web/download-file", baseUrl);
  url.searchParams.set("file_id", fileId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(url, {
    headers: headersWithCliClientHeaders(headers),
  });
  return response;
}

/**
 * Download an authorized artifact or web-uploaded file to a local path.
 * Artifact authorization uses OKOU_TOKEN, but its delivery URL never receives
 * the CLI credential. Raw file IDs retain the authenticated download route.
 */
export async function downloadWebFile(
  fileId: string,
  outPath: string,
): Promise<DownloadWebFileResult> {
  const reference = parseArtifactReference(fileId, await getPlatformOrigin());
  const artifact = reference
    ? await readArtifactDownload(`${reference.hash}${reference.extension}`)
    : undefined;
  if (artifact?.kind === "html") {
    await downloadHostedSiteFiles(artifact.site, outPath);
    return {
      path: outPath,
      mimetype: "text/html",
      size: artifact.site.size,
      fileCount: artifact.site.fileCount,
      entrypoint: join(outPath, "index.html"),
    };
  }
  const response = artifact
    ? await fetch(artifact.url)
    : await fetchWebFile((await webFileReferenceId(fileId)) ?? fileId);

  if (!response.ok) {
    let message = `Failed to download web file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // ignore parse errors — keep generic message
    }
    throw new ApiRequestError(message, code, response.status);
  }

  if (!response.body) {
    throw new ApiRequestError(
      "Web download response has no body",
      "EMPTY_BODY",
      502,
    );
  }

  const mimetype =
    response.headers.get("x-file-mimetype") ??
    response.headers.get("content-type") ??
    artifact?.contentType ??
    "application/octet-stream";

  // Cast required: Web API ReadableStream and Node.js ReadableStream are
  // structurally compatible but have incompatible type declarations.
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(outPath),
  );

  const size = statSync(outPath).size;

  return { path: outPath, mimetype, size };
}

interface UploadWebFileResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

interface GenerateWebImageOptions {
  requirePrivateArtifact?: boolean;
  prompt: string;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  outputCompression?: number;
  moderation?: string;
  seed?: number;
  safetyTolerance?: string;
  enhancePrompt?: boolean;
  imageUrls?: readonly string[];
  maskImageUrl?: string;
  inputFidelity?: string;
  imagePromptStrength?: number;
}

interface GenerateWebImageResult {
  privateArtifacts?: boolean;
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  embedUrl?: string;
  creditsCharged: number;
  model: string;
  provider: string;
  imageSize: string;
  quality: string;
  background: string;
  outputFormat: string;
  outputCompression?: number;
  moderation?: string;
  safetyTolerance?: string;
  revisedPrompt?: string;
  usage?: {
    textInputTokens: number;
    imageInputTokens: number;
    imageOutputTokens: number;
    totalTokens: number;
  };
  billingCategory?: string;
  billingQuantity?: number;
  sourceUrl?: string;
  seed?: number;
  sourceImageUrls?: string[];
  maskImageUrl?: string;
  inputFidelity?: string;
  imagePromptStrength?: number;
}

interface PrepareUploadResponse {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  url: string;
}

interface CompleteUploadResponse {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

async function parseErrorBody(
  response: Response,
  fallback: string,
): Promise<{ message: string; code: string }> {
  let message = `${fallback} (HTTP ${response.status})`;
  let code = "UNKNOWN";
  try {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
    };
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // ignore parse errors — keep generic message
  }
  return { message, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageGenerationAcceptedResponse(
  value: unknown,
): value is ImageGenerationAcceptedResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.generationId === "string" &&
    value.status === "queued" &&
    value.type === "image" &&
    isRecord(value.realtime) &&
    (value.clientReconciliation === undefined ||
      value.clientReconciliation === true)
  );
}

function invalidImageGenerationReceipt(
  body: unknown,
): ImageGenerationWaitError {
  const generationId =
    isRecord(body) && typeof body.generationId === "string"
      ? body.generationId
      : undefined;
  return new ImageGenerationWaitError(
    `Failed to generate image returned an invalid generation response${generationId ? ` (generationId: ${generationId})` : ""}; do not submit another job.`,
    "INVALID_GENERATION_RESPONSE",
    502,
    generationId,
    false,
  );
}

async function getImageGenerationStatus(
  baseUrl: string,
  token: string,
  generationId: string,
  signal: AbortSignal,
): Promise<ImageGenerationResponse> {
  const result = await builtInGenerationClient(baseUrl, token).get({
    headers: {},
    params: { generationId },
    fetchOptions: { signal: generationRequestSignal(signal) },
  });
  if (result.status !== 200) {
    handleError(result, "Failed to get generation status");
  }
  return result.body as ImageGenerationResponse;
}

/** Advance an existing job once; never resubmit or retry an uncertain request. */
async function reconcileBuiltInGeneration(
  baseUrl: string,
  token: string,
  generationId: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await builtInGenerationClient(baseUrl, token).reconcile({
    headers: {},
    params: { generationId },
    body: {},
    fetchOptions: { signal: generationRequestSignal(signal) },
  });
  if (result.status !== 200) {
    handleError(result, "Failed to refresh generation status");
  }
}

function readImageGenerationResult(
  status: ImageGenerationResponse,
  fallback: string,
): GenerateWebImageResult | undefined {
  if (status.status === "completed") {
    if (!status.result) {
      throw new ApiRequestError(
        `${fallback} returned no result`,
        "EMPTY_RESULT",
        502,
      );
    }
    return status.result;
  }

  if (status.status === "failed") {
    const code = status.error?.code ?? "GENERATION_FAILED";
    throw new ApiRequestError(
      status.error?.message ?? `${fallback} failed`,
      code,
      statusForBuiltInGenerationError(code),
    );
  }

  return undefined;
}

function statusForBuiltInGenerationError(code: string): number {
  if (code === "BAD_REQUEST") {
    return 400;
  }
  if (code === "INSUFFICIENT_CREDITS") {
    return 402;
  }
  if (code === "NOT_CONFIGURED") {
    return 503;
  }
  if (code === "GENERATION_TIMEOUT") {
    return 504;
  }
  if (
    code === "GENERATION_OUTPUT_SAFETY_BLOCKED" ||
    code === "GENERATION_INPUT_SAFETY_REJECTED" ||
    code === "GENERATION_INPUT_MEDIA_UNREACHABLE" ||
    code === "GENERATION_INPUT_MEDIA_INVALID"
  ) {
    return 422;
  }
  if (code === "GENERATION_INVALID_PARAMETERS") {
    return 400;
  }
  if (code === "GENERATION_PROVIDER_UNAVAILABLE") {
    return 503;
  }
  if (code.startsWith("NO_") || code.endsWith("_FAILED")) {
    return 502;
  }
  return 500;
}

export class ImageGenerationWaitError extends ApiRequestError {
  constructor(
    message: string,
    code: string,
    status: number,
    readonly generationId: string | undefined,
    readonly terminalFailure: boolean,
  ) {
    super(message, code, status);
    this.name = "ImageGenerationWaitError";
  }
}

async function waitForImageGenerationResult(args: {
  readonly accepted: ImageGenerationAcceptedResponse;
  readonly fallback: string;
}): Promise<GenerateWebImageResult> {
  let notifier: RealtimeNotifier | null = null;
  const owner = new AbortController();
  const signal = AbortSignal.any([
    owner.signal,
    AbortSignal.timeout(IMAGE_GENERATION_WAIT_TIMEOUT_MS),
  ]);
  let notifierCreated = false;
  const startedAt = Date.now();
  const timeoutMs = IMAGE_GENERATION_WAIT_TIMEOUT_MS;
  let terminalFailure = false;

  try {
    const token = await getActiveToken();
    if (!token) {
      throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
    }
    const baseUrl = await getBaseUrl();
    while (!signal.aborted && Date.now() - startedAt < timeoutMs) {
      if (args.accepted.clientReconciliation) {
        await reconcileBuiltInGeneration(
          baseUrl,
          token,
          args.accepted.generationId,
          signal,
        );
      }
      const status = await getImageGenerationStatus(
        baseUrl,
        token,
        args.accepted.generationId,
        signal,
      );
      terminalFailure = status.status === "failed";
      const result = readImageGenerationResult(status, args.fallback);
      if (result) {
        return result;
      }

      const elapsed = Date.now() - startedAt;
      const remaining = timeoutMs - elapsed;
      const waitMs = Math.min(IMAGE_GENERATION_POLL_INTERVAL_MS, remaining);
      if (!notifierCreated) {
        notifier = createRealtimeNotifier(args.accepted.realtime, signal);
        notifierCreated = true;
      }
      if (notifier && !notifier.closed) {
        await notifier.wait(waitMs);
      } else {
        await delay(waitMs, undefined, { signal });
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      // The receipt has already been accepted. Even a single-request timeout or
      // transport failure must preserve the ID so the caller can recover it.
      const requestTimedOut =
        error instanceof Error && error.name === "TimeoutError";
      const failure = new ImageGenerationWaitError(
        `${error instanceof Error ? error.message : `${args.fallback} wait failed`} (generationId: ${args.accepted.generationId}). Retrieve this job with okou generate get ${args.accepted.generationId} --refresh --json; do not submit another job.`,
        requestTimedOut
          ? "GENERATION_REQUEST_TIMEOUT"
          : error instanceof ApiRequestError
            ? error.code
            : "GENERATION_WAIT_FAILED",
        requestTimedOut
          ? 504
          : error instanceof ApiRequestError
            ? error.status
            : 502,
        args.accepted.generationId,
        terminalFailure,
      );
      failure.cause = error;
      throw failure;
    }
  } finally {
    owner.abort();
    await notifier?.close();
  }

  throw new ImageGenerationWaitError(
    `${args.fallback} timed out (generationId: ${args.accepted.generationId}). Retrieve this job with okou generate get ${args.accepted.generationId} --refresh --json; do not submit another job.`,
    "GENERATION_TIMEOUT",
    504,
    args.accepted.generationId,
    false,
  );
}

export async function getBuiltInGeneration(
  generationId: string,
  options?: { readonly refresh?: boolean },
): Promise<BuiltInGenerationResponse> {
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const baseUrl = await getBaseUrl();
  if (options?.refresh) {
    await reconcileBuiltInGeneration(baseUrl, token, generationId);
  }
  const result = await builtInGenerationClient(baseUrl, token).get({
    headers: {},
    params: { generationId },
    fetchOptions: { signal: generationRequestSignal() },
  });
  if (result.status !== 200) {
    handleError(result, "Failed to get generation status");
  }
  return result.body;
}

/**
 * Upload a local file and receive metadata including its stable file URL.
 * Authenticates via OKOU_TOKEN (`file:write` capability) or a CLI
 * PAT / Clerk session.
 *
 * Three-step flow:
 *   1. POST /api/uploads/prepare — server signs a PUT URL for R2
 *   2. PUT the file bytes directly to R2
 *   3. POST /api/uploads/complete — server verifies the object and
 *      records any run-scoped upload association
 *
 * Step 2 never touches the Next.js runtime, which lifts the cap from
 * Vercel's ~4.5 MB body limit up to R2's 5 GB single-PUT limit.
 */
export async function uploadWebFile(
  localPath: string,
  options?: {
    contentType?: string;
    purpose?: "artifact";
    requirePrivateArtifact?: boolean;
  },
): Promise<UploadWebFileResult> {
  const stats = statSync(localPath);
  if (!stats.isFile()) {
    throw new ApiRequestError(
      `Not a regular file: ${localPath}`,
      "BAD_REQUEST",
      400,
    );
  }

  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const filename = basename(localPath);
  const requestedContentType =
    options?.contentType ?? inferWebUploadContentType(localPath);
  const { contentType, validateUtf8 } =
    options?.purpose === "artifact"
      ? textArtifactContentType(requestedContentType)
      : { contentType: requestedContentType, validateUtf8: false };

  const prepareHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const prepareUrl = new URL(
    options?.requirePrivateArtifact
      ? "/api/uploads/prepare/private"
      : "/api/uploads/prepare",
    baseUrl,
  );
  const prepareRes = await fetch(prepareUrl, {
    method: "POST",
    headers: headersWithCliClientHeaders(prepareHeaders),
    body: JSON.stringify({
      filename,
      contentType,
      size: stats.size,
      purpose: options?.purpose,
      requirePrivateArtifact: options?.requirePrivateArtifact,
    }),
  });

  if (!prepareRes.ok) {
    const { message, code } = await parseErrorBody(
      prepareRes,
      "Failed to prepare upload",
    );
    throw new ApiRequestError(message, code, prepareRes.status);
  }

  const prepared = (await prepareRes.json()) as PrepareUploadResponse;
  if (options?.requirePrivateArtifact) {
    await assertPrivateArtifactUrl(prepared.url);
  }

  const bytes = readFileSync(localPath);
  if (validateUtf8 && !isUtf8(bytes)) {
    throw new ApiRequestError(
      "Text artifacts must use UTF-8. Save the file as UTF-8 or specify its actual charset with --content-type.",
      "BAD_REQUEST",
      400,
    );
  }
  const putRes = await fetch(prepared.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": prepared.contentType,
      ...prepared.uploadHeaders,
    },
    body: new Uint8Array(bytes),
  });

  if (!putRes.ok) {
    throw new ApiRequestError(
      `Failed to upload file to storage (HTTP ${putRes.status})`,
      "UPLOAD_FAILED",
      putRes.status,
    );
  }

  const completeUrl = new URL("/api/uploads/complete", baseUrl);
  const completeRes = await fetch(completeUrl, {
    method: "POST",
    headers: headersWithCliClientHeaders(prepareHeaders),
    body: JSON.stringify({
      id: prepared.id,
      contentType: prepared.contentType,
    }),
  });

  if (!completeRes.ok) {
    const { message, code } = await parseErrorBody(
      completeRes,
      "Failed to complete upload",
    );
    throw new ApiRequestError(message, code, completeRes.status);
  }

  const completed = (await completeRes.json()) as CompleteUploadResponse;

  return {
    id: completed.id,
    filename: completed.filename,
    contentType: completed.contentType,
    size: completed.size,
    url: completed.url,
  };
}

/**
 * Generate a billed image from a prompt and receive the public CDN URL.
 * Authenticates via OKOU_TOKEN (`file:write` capability) or a CLI PAT /
 * Clerk session.
 */
export async function generateWebImage(
  options: GenerateWebImageOptions,
): Promise<GenerateWebImageResult> {
  const submitted = await submitWebImage(options);
  if (!isImageGenerationAcceptedResponse(submitted)) {
    return submitted;
  }
  return waitForImageGenerationResult({
    accepted: submitted,
    fallback: "Failed to generate image",
  });
}

/** Submit once without polling; older APIs can return a completed image. */
export async function submitWebImage(
  options: GenerateWebImageOptions,
): Promise<ImageGenerationAcceptedResponse | GenerateWebImageResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(
    new URL(
      options.requirePrivateArtifact
        ? "/api/image-io/generate/private"
        : "/api/image-io/generate",
      baseUrl,
    ),
    {
      method: "POST",
      headers: headersWithCliClientHeaders(headers),
      body: JSON.stringify({
        prompt: options.prompt,
        requirePrivateArtifact: options.requirePrivateArtifact,
        ...(options.size ? { size: options.size } : {}),
        ...(options.quality ? { quality: options.quality } : {}),
        ...(options.background ? { background: options.background } : {}),
        ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
        ...(options.outputCompression !== undefined
          ? { outputCompression: options.outputCompression }
          : {}),
        ...(options.moderation ? { moderation: options.moderation } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.safetyTolerance
          ? { safetyTolerance: options.safetyTolerance }
          : {}),
        ...(options.enhancePrompt !== undefined
          ? { enhancePrompt: options.enhancePrompt }
          : {}),
        ...(options.imageUrls && options.imageUrls.length > 0
          ? { imageUrls: options.imageUrls }
          : {}),
        ...(options.maskImageUrl ? { maskImageUrl: options.maskImageUrl } : {}),
        ...(options.inputFidelity
          ? { inputFidelity: options.inputFidelity }
          : {}),
        ...(options.imagePromptStrength !== undefined
          ? { imagePromptStrength: options.imagePromptStrength }
          : {}),
      }),
    },
  );

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate image",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  const body: unknown = await response.json();
  if (isImageGenerationAcceptedResponse(body)) {
    return body;
  }
  if (response.status === 202) {
    throw invalidImageGenerationReceipt(body);
  }
  return body as GenerateWebImageResult;
}
