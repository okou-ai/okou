import {
  introVideoRenderRequestSchema,
  introVideoRenderResponseSchema,
  type IntroVideoRenderRequest,
  type IntroVideoRenderResponse,
} from "@okouai/api-contracts/contracts/intro-video-render";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { createWriteStream, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Realtime, type AuthOptions, type InboundMessage } from "ably";
import type {
  BuiltInGenerationAcceptedResponse,
  BuiltInGenerationResponse,
} from "@okouai/api-contracts/contracts/built-in-generation";
import type {
  AvatarVideoAvatar,
  AvatarVideoAvatarsQuery,
  AvatarVideoGenerateRequest,
  AvatarVideoGenerateResponse,
  AvatarVideoVoice,
  AvatarVideoVoicesQuery,
} from "@okouai/api-contracts/contracts/avatar-video";
import {
  avatarVideoAvatarsResponseSchema,
  avatarVideoVoicesResponseSchema,
} from "@okouai/api-contracts/contracts/avatar-video";
import type {
  IntroVideoAvatarsQuery,
  IntroVideoAvatarsResponse,
  IntroVideoPresenterGenerateRequest,
  IntroVideoPresenterGenerateResponse,
  IntroVideoStylesQuery,
  IntroVideoStylesResponse,
  IntroVideoVoiceGenerateRequest,
  IntroVideoVoiceGenerateResponse,
  IntroVideoVoicesQuery,
  IntroVideoVoicesResponse,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import {
  introVideoAvatarsResponseSchema,
  introVideoStylesResponseSchema,
  introVideoVoicesResponseSchema,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import {
  introVideoAgentResponseSchema,
  type IntroVideoAgentGenerateRequest,
  type IntroVideoAgentResponse,
} from "@okouai/api-contracts/contracts/intro-video-agent";
import { ApiRequestError, getBaseUrl } from "../core/client-factory";
import { getActiveToken } from "../config";
import { headersWithCliClientHeaders } from "../client-headers";

const BUILT_IN_GENERATION_POLL_INTERVAL_MS = 2_000;
const BUILT_IN_GENERATION_WAIT_TIMEOUT_MS_BY_TYPE = {
  image: 15 * 60 * 1000,
  video: 30 * 60 * 1000,
  presentation: 60 * 60 * 1000,
  website: 60 * 60 * 1000,
} as const satisfies Record<BuiltInGenerationAcceptedResponse["type"], number>;
const ABLY_CONNECT_TIMEOUT_MS = 10_000;

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

interface DownloadWebFileResult {
  path: string;
  mimetype: string;
  size: number;
}

/** Only the configured API origin may receive the CLI credential. */
export async function webFileReferenceId(
  value: string,
): Promise<string | null> {
  const reference = parseArtifactReference(value);
  if (reference) return reference.id;
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

export async function fetchGenerationReference(
  url: string | URL,
): Promise<Response> {
  const id = await webFileReferenceId(String(url));
  return id ? fetchWebFile(id) : fetch(url);
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
 * Download a web-uploaded file to a local path, streaming the response body
 * to disk. Authenticates via OKOU_TOKEN. Response is binary, so this bypasses
 * the typed contract client.
 */
export async function downloadWebFile(
  fileId: string,
  outPath: string,
): Promise<DownloadWebFileResult> {
  const response = await fetchWebFile(
    parseArtifactReference(fileId)?.id ?? fileId,
  );

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
    "application/octet-stream";

  // Cast required: Web API ReadableStream and Node.js ReadableStream are
  // structurally compatible but have incompatible type declarations.
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(outPath),
  );

  const contentLengthHeader = response.headers.get("content-length");
  const size = contentLengthHeader ? Number(contentLengthHeader) : 0;

  return { path: outPath, mimetype, size };
}

interface UploadWebFileResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

interface GenerateWebVoiceOptions {
  text: string;
  voice?: string;
  instructions?: string;
}

interface GenerateWebVoiceResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  durationSeconds: number;
  creditsCharged: number;
  model: string;
  voice: string;
}

interface GenerateWebImageOptions {
  prompt: string;
  model?: string;
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

interface GenerateWebVideoOptions {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  duration?: string;
  resolution?: string;
  generateAudio?: boolean;
  negativePrompt?: string;
  seed?: number;
  autoFix?: boolean;
  safetyTolerance?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
  firstFrameImageUrl?: string;
  lastFrameImageUrl?: string;
}

interface GenerateWebVideoResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  durationSeconds: number;
  creditsCharged: number;
  model: string;
  aspectRatio: string;
  duration: string;
  resolution: string;
  generateAudio: boolean;
  sourceUrl: string;
  requestId?: string;
}

interface ListWebAvatarVideoAvatarsResult {
  readonly avatars: readonly AvatarVideoAvatar[];
}

interface ListWebAvatarVideoVoicesResult {
  readonly voices: readonly AvatarVideoVoice[];
  readonly hasMore: boolean;
}

function shouldIncludePayloadValue(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

function compactPayload(
  entries: readonly (readonly [string, unknown])[],
): Record<string, unknown> {
  return Object.fromEntries(
    entries.filter(([, value]) => {
      return shouldIncludePayloadValue(value);
    }),
  );
}

function generateWebVideoPayload(
  options: GenerateWebVideoOptions,
): Record<string, unknown> {
  return compactPayload([
    ["prompt", options.prompt],
    ["model", options.model],
    ["aspectRatio", options.aspectRatio],
    ["duration", options.duration],
    ["resolution", options.resolution],
    ["generateAudio", options.generateAudio],
    ["negativePrompt", options.negativePrompt],
    ["seed", options.seed],
    ["autoFix", options.autoFix],
    ["safetyTolerance", options.safetyTolerance],
    ["imageUrls", options.imageUrls],
    ["videoUrls", options.videoUrls],
    ["audioUrls", options.audioUrls],
    ["firstFrameImageUrl", options.firstFrameImageUrl],
    ["lastFrameImageUrl", options.lastFrameImageUrl],
  ]);
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

function authenticatedJsonHeaders(token: string): Headers {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  return headersWithCliClientHeaders(headers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBuiltInGenerationAcceptedResponse(
  value: unknown,
): value is BuiltInGenerationAcceptedResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.generationId === "string" &&
    value.status === "queued" &&
    (value.type === "image" ||
      value.type === "video" ||
      value.type === "presentation" ||
      value.type === "website") &&
    isRecord(value.realtime)
  );
}

interface BuiltInGenerationNotifier {
  wait(timeoutMs: number): Promise<void>;
  close(): void;
}

function createBuiltInGenerationRealtime(
  accepted: BuiltInGenerationAcceptedResponse,
): Realtime {
  let nextAuthRequest = accepted.realtime.tokenRequest;
  const authCallback: NonNullable<AuthOptions["authCallback"]> = (
    _params,
    callback,
  ) => {
    const current = nextAuthRequest;
    nextAuthRequest = accepted.realtime.tokenRequest;
    callback(null, current);
  };

  return new Realtime({
    authCallback,
    autoConnect: true,
    disconnectedRetryTimeout: 5000,
    suspendedRetryTimeout: 15_000,
  });
}

function waitForRealtimeConnected(
  ably: Realtime,
  timeoutMs = ABLY_CONNECT_TIMEOUT_MS,
): Promise<void> {
  if (ably.connection.state === "connected") {
    return Promise.resolve();
  }
  if (ably.connection.state === "failed") {
    return Promise.reject(new Error("Ably connection failed"));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out connecting to Ably"));
    }, timeoutMs);

    ably.connection.once("connected", () => {
      clearTimeout(timer);
      resolve();
    });
    ably.connection.once("failed", (stateChange) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Ably connection failed: ${stateChange?.reason?.message ?? "unknown"}`,
        ),
      );
    });
  });
}

async function createBuiltInGenerationNotifier(
  accepted: BuiltInGenerationAcceptedResponse,
): Promise<BuiltInGenerationNotifier | null> {
  const ably = createBuiltInGenerationRealtime(accepted);

  try {
    await waitForRealtimeConnected(ably);
    const channel = ably.channels.get(accepted.realtime.channelName);

    let pendingEvent = false;
    let closed = false;
    let wake: (() => void) | null = null;

    const wakeWaiter = () => {
      const current = wake;
      wake = null;
      current?.();
    };

    const onMessage = (_message: InboundMessage) => {
      if (wake) {
        wakeWaiter();
        return;
      }
      pendingEvent = true;
    };

    await channel.subscribe(accepted.realtime.eventName, onMessage);

    return {
      wait(timeoutMs: number): Promise<void> {
        if (pendingEvent || closed || timeoutMs <= 0) {
          pendingEvent = false;
          return Promise.resolve();
        }

        return new Promise((resolve) => {
          function done() {
            clearTimeout(timer);
            if (wake === done) {
              wake = null;
            }
            resolve();
          }
          const timer = setTimeout(done, timeoutMs);
          wake = done;
        });
      },
      close(): void {
        if (closed) {
          return;
        }
        closed = true;
        channel.unsubscribe(accepted.realtime.eventName, onMessage);
        wakeWaiter();
        ably.close();
      },
    };
  } catch {
    ably.close();
    return null;
  }
}

async function getBuiltInGenerationStatus(
  baseUrl: string,
  token: string,
  generationId: string,
): Promise<BuiltInGenerationResponse> {
  const response = await fetch(
    new URL(`/api/built-in-generations/${generationId}`, baseUrl),
    { headers: authenticatedJsonHeaders(token) },
  );

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to get generation status",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return (await response.json()) as BuiltInGenerationResponse;
}

function readBuiltInGenerationResult<T>(
  status: BuiltInGenerationResponse,
  fallback: string,
): T | undefined {
  if (status.status === "completed") {
    if (!status.result) {
      throw new ApiRequestError(
        `${fallback} returned no result`,
        "EMPTY_RESULT",
        502,
      );
    }
    return status.result as T;
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
  if (
    code.startsWith("BYTEPLUS_INVALID_PARAMETER") ||
    code.startsWith("BYTEPLUS_INPUT_")
  ) {
    return 400;
  }
  if (code.startsWith("BYTEPLUS_")) {
    return 502;
  }
  if (code.startsWith("NO_") || code.endsWith("_FAILED")) {
    return 502;
  }
  return 500;
}

async function waitForBuiltInGenerationResult<T>(args: {
  readonly accepted: BuiltInGenerationAcceptedResponse;
  readonly baseUrl: string;
  readonly token: string;
  readonly fallback: string;
}): Promise<T> {
  let notifier: BuiltInGenerationNotifier | null = null;
  let notifierCreated = false;
  const startedAt = Date.now();
  const timeoutMs =
    BUILT_IN_GENERATION_WAIT_TIMEOUT_MS_BY_TYPE[args.accepted.type];

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const status = await getBuiltInGenerationStatus(
        args.baseUrl,
        args.token,
        args.accepted.generationId,
      );
      const result = readBuiltInGenerationResult<T>(status, args.fallback);
      if (result) {
        return result;
      }

      const elapsed = Date.now() - startedAt;
      const remaining = timeoutMs - elapsed;
      const waitMs = Math.min(BUILT_IN_GENERATION_POLL_INTERVAL_MS, remaining);
      if (!notifierCreated) {
        notifier = await createBuiltInGenerationNotifier(args.accepted);
        notifierCreated = true;
      }
      if (notifier) {
        await notifier.wait(waitMs);
      } else {
        await delay(waitMs);
      }
    }
  } finally {
    notifier?.close();
  }

  throw new ApiRequestError(
    `${args.fallback} timed out (generationId: ${args.accepted.generationId})`,
    "GENERATION_TIMEOUT",
    504,
  );
}

async function readBuiltInGenerationResponse<T>(args: {
  readonly response: Response;
  readonly baseUrl: string;
  readonly token: string;
  readonly fallback: string;
}): Promise<T> {
  const body: unknown = await args.response.json();
  if (isBuiltInGenerationAcceptedResponse(body)) {
    return waitForBuiltInGenerationResult<T>({
      accepted: body,
      baseUrl: args.baseUrl,
      token: args.token,
      fallback: args.fallback,
    });
  }
  if (args.response.status === 202) {
    throw new ApiRequestError(
      `${args.fallback} returned an invalid generation response`,
      "INVALID_GENERATION_RESPONSE",
      502,
    );
  }
  return body as T;
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
  options?: { contentType?: string; purpose?: "artifact" },
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
  const contentType =
    options?.contentType ?? inferWebUploadContentType(localPath);

  const prepareHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const prepareUrl = new URL("/api/uploads/prepare", baseUrl);
  const prepareRes = await fetch(prepareUrl, {
    method: "POST",
    headers: headersWithCliClientHeaders(prepareHeaders),
    body: JSON.stringify({
      filename,
      contentType,
      size: stats.size,
      purpose: options?.purpose,
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

  const bytes = readFileSync(localPath);
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
 * Generate billed speech audio from text and receive the public CDN URL.
 * Authenticates via OKOU_TOKEN (`file:write` capability) or a CLI PAT /
 * Clerk session.
 */
export async function generateWebVoice(
  options: GenerateWebVoiceOptions,
): Promise<GenerateWebVoiceResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(new URL("/api/voice-io/speech", baseUrl), {
    method: "POST",
    headers: headersWithCliClientHeaders(headers),
    body: JSON.stringify({
      text: options.text,
      ...(options.voice ? { voice: options.voice } : {}),
      ...(options.instructions ? { instructions: options.instructions } : {}),
    }),
  });

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate voice",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return (await response.json()) as GenerateWebVoiceResult;
}

/**
 * Generate a billed image from a prompt and receive the public CDN URL.
 * Authenticates via OKOU_TOKEN (`file:write` capability) or a CLI PAT /
 * Clerk session.
 */
export async function generateWebImage(
  options: GenerateWebImageOptions,
): Promise<GenerateWebImageResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(new URL("/api/image-io/generate", baseUrl), {
    method: "POST",
    headers: headersWithCliClientHeaders(headers),
    body: JSON.stringify({
      prompt: options.prompt,
      ...(options.model ? { model: options.model } : {}),
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
  });

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate image",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return readBuiltInGenerationResponse<GenerateWebImageResult>({
    response,
    baseUrl,
    token,
    fallback: "Failed to generate image",
  });
}

/**
 * Generate a billed video from a prompt and receive the public CDN URL.
 * Authenticates via OKOU_TOKEN (`file:write` capability) or a CLI PAT /
 * Clerk session.
 */
export async function generateWebVideo(
  options: GenerateWebVideoOptions,
): Promise<GenerateWebVideoResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(new URL("/api/video-io/generate", baseUrl), {
    method: "POST",
    headers: headersWithCliClientHeaders(headers),
    body: JSON.stringify(generateWebVideoPayload(options)),
  });

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate video",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return readBuiltInGenerationResponse<GenerateWebVideoResult>({
    response,
    baseUrl,
    token,
    fallback: "Failed to generate video",
  });
}

/**
 * Generate a billed JoggAI talking-avatar video and receive its public CDN URL.
 */
export async function generateWebAvatarVideo(
  options: AvatarVideoGenerateRequest,
): Promise<AvatarVideoGenerateResponse> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const response = await fetch(new URL("/api/avatar-video/generate", baseUrl), {
    method: "POST",
    headers: headersWithCliClientHeaders({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate avatar video",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return readBuiltInGenerationResponse<AvatarVideoGenerateResponse>({
    response,
    baseUrl,
    token,
    fallback: "Failed to generate avatar video",
  });
}

/**
 * Generate the private transparent presenter take used by Intro Video.
 * This endpoint accepts run credentials only and is intentionally not exposed
 * through the public `okou generate` surface.
 */
export async function generateWebIntroVideoPresenter(
  options: IntroVideoPresenterGenerateRequest,
): Promise<IntroVideoPresenterGenerateResponse> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const response = await fetch(
    new URL("/api/intro-video/presenter/generate", baseUrl),
    {
      method: "POST",
      headers: headersWithCliClientHeaders({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(options),
    },
  );
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate Intro Video presenter",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return readBuiltInGenerationResponse<IntroVideoPresenterGenerateResponse>({
    response,
    baseUrl,
    token,
    fallback: "Failed to generate Intro Video presenter",
  });
}

/** Submit once and return the durable native Video Agent job without waiting. */
export async function generateWebIntroVideoAgent(
  options: IntroVideoAgentGenerateRequest,
): Promise<IntroVideoAgentResponse> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const response = await fetch(
    new URL("/api/intro-video/agent/generate", baseUrl),
    {
      method: "POST",
      headers: headersWithCliClientHeaders({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(options),
    },
  );
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to submit Intro Video Agent job",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return introVideoAgentResponseSchema.parse(await response.json());
}

/** Reconcile one existing job; this endpoint never creates another video. */
export async function getWebIntroVideoAgent(
  generationId: string,
): Promise<IntroVideoAgentResponse> {
  const baseUrl = await getBaseUrl();
  return introVideoAgentResponseSchema.parse(
    await getIntroVideoCatalog(
      new URL(
        `/api/intro-video/agent/${encodeURIComponent(generationId)}`,
        baseUrl,
      ),
      "Failed to get Intro Video Agent job",
    ),
  );
}

/**
 * Generate the private HeyGen narration track used by Intro Video.
 * The returned permanent URL is reused for presenter lip sync and final mix.
 */
export async function generateWebIntroVideoVoice(
  options: IntroVideoVoiceGenerateRequest,
): Promise<IntroVideoVoiceGenerateResponse> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const response = await fetch(
    new URL("/api/intro-video/voice/generate", baseUrl),
    {
      method: "POST",
      headers: headersWithCliClientHeaders({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(options),
    },
  );
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate Intro Video narration",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return readBuiltInGenerationResponse<IntroVideoVoiceGenerateResponse>({
    response,
    baseUrl,
    token,
    fallback: "Failed to generate Intro Video narration",
  });
}

function introVideoCatalogUrl(
  baseUrl: string,
  collection: "avatars" | "styles" | "voices",
  query: Record<string, string | number | undefined>,
): URL {
  const url = new URL(`/api/intro-video/${collection}`, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function getIntroVideoCatalog(
  url: URL,
  fallback: string,
): Promise<unknown> {
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const response = await fetch(url, {
    headers: headersWithCliClientHeaders({
      Authorization: `Bearer ${token}`,
    }),
  });
  if (!response.ok) {
    const { message, code } = await parseErrorBody(response, fallback);
    throw new ApiRequestError(message, code, response.status);
  }
  return await response.json();
}

export async function listWebIntroVideoAvatars(
  query: IntroVideoAvatarsQuery,
): Promise<IntroVideoAvatarsResponse> {
  const baseUrl = await getBaseUrl();
  return introVideoAvatarsResponseSchema.parse(
    await getIntroVideoCatalog(
      introVideoCatalogUrl(baseUrl, "avatars", query),
      "Failed to list Intro Video avatars",
    ),
  );
}

export async function listWebIntroVideoStyles(
  query: IntroVideoStylesQuery,
): Promise<IntroVideoStylesResponse> {
  const baseUrl = await getBaseUrl();
  return introVideoStylesResponseSchema.parse(
    await getIntroVideoCatalog(
      introVideoCatalogUrl(baseUrl, "styles", query),
      "Failed to list Intro Video styles",
    ),
  );
}

export async function listWebIntroVideoVoices(
  query: IntroVideoVoicesQuery,
): Promise<IntroVideoVoicesResponse> {
  const baseUrl = await getBaseUrl();
  return introVideoVoicesResponseSchema.parse(
    await getIntroVideoCatalog(
      introVideoCatalogUrl(baseUrl, "voices", query),
      "Failed to list Intro Video voices",
    ),
  );
}

function avatarVideoCollectionUrl(
  baseUrl: string,
  collection: "avatars" | "voices",
  query: Record<string, string | number | undefined>,
): URL {
  const url = new URL(`/api/avatar-video/${collection}`, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function getAvatarVideoCollection(
  url: URL,
  fallback: string,
): Promise<unknown> {
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const response = await fetch(url, {
    headers: headersWithCliClientHeaders({
      Authorization: `Bearer ${token}`,
    }),
  });
  if (!response.ok) {
    const { message, code } = await parseErrorBody(response, fallback);
    throw new ApiRequestError(message, code, response.status);
  }
  return await response.json();
}

export async function listWebAvatarVideoAvatars(
  query: AvatarVideoAvatarsQuery,
): Promise<ListWebAvatarVideoAvatarsResult> {
  const baseUrl = await getBaseUrl();
  return avatarVideoAvatarsResponseSchema.parse(
    await getAvatarVideoCollection(
      avatarVideoCollectionUrl(baseUrl, "avatars", query),
      "Failed to list JoggAI avatars",
    ),
  );
}

export async function listWebAvatarVideoVoices(
  query: AvatarVideoVoicesQuery,
): Promise<ListWebAvatarVideoVoicesResult> {
  const baseUrl = await getBaseUrl();
  return avatarVideoVoicesResponseSchema.parse(
    await getAvatarVideoCollection(
      avatarVideoCollectionUrl(baseUrl, "voices", query),
      "Failed to list JoggAI voices",
    ),
  );
}

export interface TranscribeAudioSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface TranscribeAudioResult {
  readonly text: string;
  readonly segments?: readonly TranscribeAudioSegment[];
}

export async function transcribeAudio(
  audioPath: string,
  options: { readonly verbose?: boolean } = {},
): Promise<TranscribeAudioResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const url = new URL("/api/voice-io/stt", baseUrl);
  if (options.verbose) {
    url.searchParams.set("verbose", "true");
  }

  const audioData = readFileSync(audioPath);
  const filename = basename(audioPath);
  const ext = extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".mp4": "audio/mp4",
    ".m4a": "audio/m4a",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
  };
  const mimeType = mimeMap[ext] ?? "audio/mpeg";

  const formData = new FormData();
  formData.append("file", new Blob([audioData], { type: mimeType }), filename);

  const response = await fetch(url, {
    method: "POST",
    headers: headersWithCliClientHeaders(headers),
    body: formData,
  });

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Transcription failed",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return (await response.json()) as TranscribeAudioResult;
}

export async function createWebIntroVideoRender(
  input: IntroVideoRenderRequest,
): Promise<IntroVideoRenderResponse> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token)
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  const response = await fetch(new URL("/api/intro-video/renders", baseUrl), {
    method: "POST",
    headers: headersWithCliClientHeaders({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(introVideoRenderRequestSchema.parse(input)),
  });
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to submit cloud render; keep the original request ID",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return introVideoRenderResponseSchema.parse(await response.json());
}

export async function getWebIntroVideoRender(
  id: string,
): Promise<IntroVideoRenderResponse> {
  const baseUrl = await getBaseUrl();
  return introVideoRenderResponseSchema.parse(
    await getIntroVideoCatalog(
      new URL(`/api/intro-video/renders/${encodeURIComponent(id)}`, baseUrl),
      "Failed to retrieve cloud render",
    ),
  );
}
