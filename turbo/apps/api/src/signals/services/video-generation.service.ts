import { Buffer } from "node:buffer";

import { command, computed, type Computed } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import {
  DEFAULT_VIDEO_ASPECT_RATIO,
  DEFAULT_VIDEO_DURATION,
  DEFAULT_VIDEO_MODEL,
  SEEDANCE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_MODEL_ALIASES,
  VIDEO_MODEL_CONFIGS,
  VIDEO_MODELS,
  VIDEO_RESOLUTIONS,
  type SeedanceResolution,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoModel,
  type VideoModelConfig,
  type VideoProvider,
  type VideoResolution,
} from "@okouai/core/video-model-catalog";
import { and, eq, inArray } from "drizzle-orm";

import { logger } from "../../lib/log";
import { redactPresignedUrls } from "../../lib/presigned-url-redaction";
import {
  canonicalUsagePricingProvider,
  resolveUsagePricingProvider,
  usagePricingResolution$,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import { db$, writeDb$ } from "../external/db";
import { checkBillableOperationCredits$ } from "./billable-operation-admission.service";
import { storeGeneratedArtifactObject$ } from "./artifact-storage.service";
import { safeJsonParse, safeSync, tapError } from "../utils";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import {
  builtInGenerationUsageIdempotencyKey,
  type BuiltInGenerationUsageIdempotency,
} from "./built-in-generation-usage-idempotency";

const BYTEPLUS_VIDEO_TASKS_URL =
  "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";
const MINIMAX_VIDEO_GENERATION_URL =
  "https://api.minimax.io/v2/video_generation";

const L = logger("VideoGeneration");
const VIDEO_IO_MAX_PROMPT_LENGTH = 32_000;
const MINIMAX_H3_MAX_PROMPT_LENGTH = 7000;
const PROVIDER_ERROR_BODY_LOG_MAX_LENGTH = 4000;

const USAGE_KIND = "video";
const VIDEO_AUDIO_CATEGORY = "output_video_seconds.audio";
const VIDEO_SILENT_CATEGORY = "output_video_seconds.silent";
const VIDEO_AUDIO_4K_CATEGORY = "output_video_seconds.audio.4k";
const VIDEO_SILENT_4K_CATEGORY = "output_video_seconds.silent.4k";
const VIDEO_TOKEN_CATEGORY = "output_video_tokens";
const VIDEO_TOKEN_480_720_NO_VIDEO_CATEGORY =
  "output_video_tokens.480p_720p.no_video";
const VIDEO_TOKEN_480_720_WITH_VIDEO_CATEGORY =
  "output_video_tokens.480p_720p.with_video";
const VIDEO_TOKEN_1080_NO_VIDEO_CATEGORY = "output_video_tokens.1080p.no_video";
const VIDEO_TOKEN_1080_WITH_VIDEO_CATEGORY =
  "output_video_tokens.1080p.with_video";
const VIDEO_TOKEN_AUDIO_CATEGORY = "output_video_tokens.audio";
const VIDEO_TOKEN_SILENT_CATEGORY = "output_video_tokens.silent";
const MINIMAX_OUTPUT_VIDEO_768P_CATEGORY = "output_video_seconds.768p";
const MINIMAX_OUTPUT_VIDEO_2K_CATEGORY = "output_video_seconds.2k";
const MINIMAX_INPUT_VIDEO_768P_CATEGORY = "input_video_seconds.768p";
const MINIMAX_INPUT_VIDEO_2K_CATEGORY = "input_video_seconds.2k";
const MINIMAX_ADDITIONAL_INPUT_IMAGE_CATEGORY = "input_image.additional";
const MINIMAX_VIDEO_PRICING_CATEGORIES = [
  MINIMAX_OUTPUT_VIDEO_768P_CATEGORY,
  MINIMAX_OUTPUT_VIDEO_2K_CATEGORY,
  MINIMAX_INPUT_VIDEO_768P_CATEGORY,
  MINIMAX_INPUT_VIDEO_2K_CATEGORY,
  MINIMAX_ADDITIONAL_INPUT_IMAGE_CATEGORY,
] as const;
const VIDEO_PRICING_CATEGORIES = [
  VIDEO_AUDIO_CATEGORY,
  VIDEO_SILENT_CATEGORY,
  VIDEO_AUDIO_4K_CATEGORY,
  VIDEO_SILENT_4K_CATEGORY,
  VIDEO_TOKEN_CATEGORY,
  VIDEO_TOKEN_480_720_NO_VIDEO_CATEGORY,
  VIDEO_TOKEN_480_720_WITH_VIDEO_CATEGORY,
  VIDEO_TOKEN_1080_NO_VIDEO_CATEGORY,
  VIDEO_TOKEN_1080_WITH_VIDEO_CATEGORY,
  VIDEO_TOKEN_AUDIO_CATEGORY,
  VIDEO_TOKEN_SILENT_CATEGORY,
  ...MINIMAX_VIDEO_PRICING_CATEGORIES,
] as const;

type VideoPricingCategory = (typeof VIDEO_PRICING_CATEGORIES)[number];
type VideoDimensions = {
  readonly width: number;
  readonly height: number;
};
type DimensionTable = Partial<
  Record<SeedanceResolution, Record<VideoAspectRatio, VideoDimensions>>
>;

const SEEDANCE_2_5_DIMENSIONS = {
  "480p": {
    "21:9": { width: 992, height: 432 },
    "16:9": { width: 854, height: 480 },
    "4:3": { width: 752, height: 560 },
    "1:1": { width: 640, height: 640 },
    "3:4": { width: 560, height: 752 },
    "9:16": { width: 480, height: 854 },
  },
  "720p": {
    "21:9": { width: 1470, height: 630 },
    "16:9": { width: 1280, height: 720 },
    "4:3": { width: 1112, height: 834 },
    "1:1": { width: 960, height: 960 },
    "3:4": { width: 834, height: 1112 },
    "9:16": { width: 720, height: 1280 },
  },
  "1080p": {
    "21:9": { width: 2206, height: 946 },
    "16:9": { width: 1920, height: 1080 },
    "4:3": { width: 1664, height: 1248 },
    "1:1": { width: 1440, height: 1440 },
    "3:4": { width: 1248, height: 1664 },
    "9:16": { width: 1080, height: 1920 },
  },
} as const satisfies DimensionTable;

const SEEDANCE_2_DIMENSIONS = {
  "480p": {
    "21:9": { width: 992, height: 432 },
    "16:9": { width: 864, height: 496 },
    "4:3": { width: 752, height: 560 },
    "1:1": { width: 640, height: 640 },
    "3:4": { width: 560, height: 752 },
    "9:16": { width: 496, height: 864 },
  },
  "720p": {
    "21:9": { width: 1470, height: 630 },
    "16:9": { width: 1280, height: 720 },
    "4:3": { width: 1112, height: 834 },
    "1:1": { width: 960, height: 960 },
    "3:4": { width: 834, height: 1112 },
    "9:16": { width: 720, height: 1280 },
  },
  "1080p": {
    "21:9": { width: 2206, height: 946 },
    "16:9": { width: 1920, height: 1080 },
    "4:3": { width: 1664, height: 1248 },
    "1:1": { width: 1440, height: 1440 },
    "3:4": { width: 1248, height: 1664 },
    "9:16": { width: 1080, height: 1920 },
  },
} as const satisfies DimensionTable;

type ErrorStatus = 400 | 402 | 500 | 502 | 503 | 504;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

type VideoErrorResponse = {
  readonly status: ErrorStatus;
  readonly body: ErrorBody;
};

export interface VideoPricingRow {
  readonly provider: VideoModel;
  readonly category: VideoPricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

export type VideoPricing = ReadonlyMap<string, VideoPricingRow>;

export interface VideoOptions {
  readonly model: VideoModel;
  readonly prompt: string;
  readonly aspectRatio: VideoAspectRatio;
  readonly duration: VideoDuration;
  readonly durationSeconds: number;
  readonly resolution: VideoResolution;
  readonly generateAudio: boolean;
  readonly negativePrompt: string | undefined;
  readonly seed: number | undefined;
  readonly autoFix: boolean;
  readonly safetyTolerance: string;
  readonly referenceImageUrls: readonly string[];
  readonly inputVideoUrls: readonly string[];
  readonly referenceAudioUrls: readonly string[];
  readonly firstFrameImageUrl: string | undefined;
  readonly lastFrameImageUrl: string | undefined;
}

interface BytePlusTaskHandle {
  readonly taskId: string;
  readonly status: string | undefined;
}

interface MiniMaxTaskHandle {
  readonly taskId: string;
}

interface FalQueueHandle {
  readonly requestId: string | undefined;
  readonly statusUrl: string;
  readonly responseUrl: string;
}

interface FalFile {
  readonly url: string;
  readonly contentType: string | undefined;
}

interface FalVideoResult {
  readonly requestId: string | undefined;
  readonly sourceUrl: string;
  readonly falContentType: string | undefined;
}

interface BytePlusVideoResult {
  readonly requestId: string | undefined;
  readonly sourceUrl: string;
  readonly bytePlusContentType: string | undefined;
  readonly completionTokens: number | undefined;
}

interface MiniMaxVideoResult {
  readonly requestId: string;
  readonly sourceUrl: string;
  readonly resolution: "768p" | "2k";
  readonly aspectRatio: VideoAspectRatio | undefined;
  readonly outputSeconds: number;
  readonly inputSeconds: number;
  readonly inputImageCount: number;
}

interface VideoProviderError {
  readonly message: string;
  readonly code: string;
}

interface ParsedVideoGeneration {
  readonly model: VideoModel;
  readonly videoBytes: Buffer;
  readonly contentType: string;
  readonly sourceUrl: string;
  readonly requestId: string | undefined;
  readonly aspectRatio: VideoAspectRatio;
  readonly duration: VideoDuration;
  readonly durationSeconds: number;
  readonly resolution: VideoResolution;
  readonly generateAudio: boolean;
  readonly negativePrompt: string | undefined;
  readonly seed: number | undefined;
  readonly autoFix: boolean;
  readonly safetyTolerance: string;
  readonly referenceImageUrls: readonly string[];
  readonly inputVideoUrls: readonly string[];
  readonly referenceAudioUrls: readonly string[];
  readonly firstFrameImageUrl: string | undefined;
  readonly lastFrameImageUrl: string | undefined;
  readonly billing: readonly VideoBillingEntry[];
}

interface VideoBillingEntry {
  readonly category: VideoPricingCategory;
  readonly quantity: number;
}

interface RecordedVideo {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly durationSeconds: number;
  readonly creditsCharged: number;
  readonly model: VideoModel;
  readonly aspectRatio: VideoAspectRatio;
  readonly duration: VideoDuration;
  readonly resolution: VideoResolution;
  readonly generateAudio: boolean;
  readonly sourceUrl: string | undefined;
  readonly requestId: string | undefined;
}

type MultimodalVideoContent =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image_url";
      readonly image_url: { readonly url: string };
      readonly role?: "first_frame" | "last_frame" | "reference_image";
    }
  | {
      readonly type: "video_url";
      readonly video_url: { readonly url: string };
      readonly role: "reference_video";
    }
  | {
      readonly type: "audio_url";
      readonly audio_url: { readonly url: string };
      readonly role: "reference_audio";
    };

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string, code = "BAD_REQUEST") {
  return { status: 400 as const, body: errorBody(message, code) };
}

function videoInternalError(message: string) {
  return {
    status: 500 as const,
    body: errorBody(message, "INTERNAL_SERVER_ERROR"),
  };
}

function badGateway(message: string, code: string) {
  return { status: 502 as const, body: errorBody(message, code) };
}

function bytePlusErrorStatus(status: number): ErrorStatus {
  if (status === 400 || status === 503 || status === 504) {
    return status;
  }
  return 502;
}

function normalizeBytePlusErrorCode(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized
    ? `BYTEPLUS_${normalized}`
    : "BYTEPLUS_VIDEO_GENERATION_FAILED";
}

function bytePlusProviderErrorResponse(
  providerError: VideoProviderError,
  providerStatus: number,
): VideoErrorResponse {
  if (
    providerError.code ===
    "InputImageSensitiveContentDetected.PrivacyInformation"
  ) {
    return {
      status: bytePlusErrorStatus(providerStatus),
      body: errorBody(
        "This model does not allow directly uploaded images that may contain a real person. Remove or replace them before trying again.",
        "GENERATION_INPUT_REAL_PERSON_IMAGE_REJECTED",
      ),
    };
  }

  return {
    status: bytePlusErrorStatus(providerStatus),
    body: errorBody(
      `BytePlus video generation failed: ${providerError.message}`,
      normalizeBytePlusErrorCode(providerError.code),
    ),
  };
}

function miniMaxErrorStatus(status: number): ErrorStatus {
  if (status === 400 || status === 422) {
    return 400;
  }
  if (status === 402) {
    return 402;
  }
  if (status === 429) {
    return 503;
  }
  return 502;
}

function normalizeMiniMaxErrorCode(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized
    ? `MINIMAX_${normalized}`
    : "MINIMAX_VIDEO_GENERATION_FAILED";
}

function miniMaxProviderErrorResponse(
  providerError: VideoProviderError,
  providerStatus: number,
): VideoErrorResponse {
  return {
    status: miniMaxErrorStatus(providerStatus),
    body: errorBody(
      `MiniMax video generation failed: ${providerError.message}`,
      normalizeMiniMaxErrorCode(providerError.code),
    ),
  };
}

export function videoServiceUnavailable(message: string, code: string) {
  return { status: 503 as const, body: errorBody(message, code) };
}

export function videoInsufficientCredits() {
  return {
    status: 402 as const,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

export function videoRequiresPaidPlan() {
  return {
    status: 402 as const,
    body: errorBody(
      "Built-in video generation requires Pro, Team, or Custom workspace access.",
      "PRO_REQUIRED",
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProviderString(
  body: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function stringifyCompact(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const serialized = safeSync(() => {
    return JSON.stringify(value);
  });
  return "ok" in serialized ? serialized.ok : undefined;
}

function readVideoProviderError(value: unknown): VideoProviderError | null {
  if (!isRecord(value)) {
    return null;
  }

  const sources = [value.error, value.data, value.response, value].filter(
    isRecord,
  );
  for (const source of sources) {
    const message =
      readProviderString(source, [
        "message",
        "error_message",
        "errorMessage",
        "detail",
        "description",
        "reason",
        "failure_reason",
        "failureReason",
        "status_message",
        "statusMessage",
        "err_msg",
      ]) ?? stringifyCompact(source.error);
    if (!message) {
      continue;
    }
    const code =
      readProviderString(source, ["code", "error_code", "errorCode", "type"]) ??
      readProviderString(value, ["code", "error_code", "errorCode", "type"]);
    const param = readProviderString(source, ["param", "parameter"]);
    return {
      message: redactPresignedUrls(param ? `${message} (${param})` : message),
      code: code ?? "VIDEO_GENERATION_FAILED",
    };
  }

  return null;
}

function videoProviderErrorFromText(
  text: string | undefined,
  status: number,
  statusText: string,
): VideoProviderError {
  const parsed = text ? safeJsonParse(text) : undefined;
  const providerError = readVideoProviderError(parsed);
  if (providerError) {
    return providerError;
  }
  return {
    message: statusText
      ? `${statusText} (HTTP ${status})`
      : `provider returned HTTP ${status}`,
    code: "VIDEO_GENERATION_FAILED",
  };
}

function videoProviderFailureError(payload: unknown): VideoProviderError {
  return (
    readVideoProviderError(payload) ?? {
      message: "Generation failed",
      code: "VIDEO_GENERATION_FAILED",
    }
  );
}

export function bytePlusBuiltInGenerationError(payload: unknown): {
  readonly message: string;
  readonly code: string;
} {
  const providerError = videoProviderFailureError(payload);
  return {
    message: `BytePlus video generation failed: ${providerError.message}`,
    code: normalizeBytePlusErrorCode(providerError.code),
  };
}

export function miniMaxBuiltInGenerationError(payload: unknown): {
  readonly message: string;
  readonly code: string;
} {
  const providerError = videoProviderFailureError(payload);
  return {
    message: `MiniMax video generation failed: ${providerError.message}`,
    code: normalizeMiniMaxErrorCode(providerError.code),
  };
}

function readString(
  body: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readOptionalStringFromKeys(
  body: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readOptionalString(body, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readStringArray(
  body: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = body[key];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => {
        return typeof entry === "string";
      })
      .map((entry) => {
        return entry.trim();
      })
      .filter((entry) => {
        return entry.length > 0;
      });
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function readStringArrayFromKeys(
  body: Record<string, unknown>,
  keys: readonly string[],
): readonly string[] {
  return [
    ...new Set(
      keys.flatMap((key) => {
        return readStringArray(body, key);
      }),
    ),
  ];
}

function readBoolean(
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
}

function includesString<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return values.some((candidate) => {
    return candidate === value;
  });
}

function hasString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      return entry !== undefined;
    }),
  );
}

function normalizeVideoModel(value: string): VideoModel | null {
  if (value in VIDEO_MODEL_CONFIGS) {
    return value as VideoModel;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized in VIDEO_MODEL_ALIASES) {
    return VIDEO_MODEL_ALIASES[normalized as keyof typeof VIDEO_MODEL_ALIASES];
  }
  return null;
}

// Every catalog model is accepted here, so the hint names them all. `public`
// only decides which of them the composer picker offers.
function videoModelList(): string {
  return VIDEO_MODELS.map((model) => {
    return VIDEO_MODEL_CONFIGS[model].alias;
  }).join(", ");
}

export function videoProviderForModel(model: VideoModel): VideoProvider {
  return VIDEO_MODEL_CONFIGS[model].provider;
}

function parseDurationSeconds(duration: VideoDuration): number {
  return Number(duration.replace("s", ""));
}

interface VideoReferenceOptions {
  readonly alias: string;
  readonly referenceImageUrls: readonly string[];
  readonly inputVideoUrls: readonly string[];
  readonly referenceAudioUrls: readonly string[];
  readonly firstFrameImageUrl: string | undefined;
  readonly lastFrameImageUrl: string | undefined;
}

function validateMiniMaxVideoReferences(
  options: VideoReferenceOptions,
): VideoErrorResponse | null {
  if (options.referenceImageUrls.length > 9) {
    return badRequest("reference image URLs cannot exceed 9 items");
  }
  const referenceFileCount =
    options.referenceImageUrls.length +
    options.inputVideoUrls.length +
    options.referenceAudioUrls.length;
  if (referenceFileCount > 12) {
    return badRequest("reference media URLs cannot exceed 12 items");
  }
  if (
    referenceFileCount > 0 &&
    (options.firstFrameImageUrl || options.lastFrameImageUrl)
  ) {
    return badRequest(
      "MiniMax H3 frame images and reference media cannot be combined",
    );
  }
  return null;
}

function validateReferenceAudioDependency(
  modelConfig: VideoModelConfig,
  options: VideoReferenceOptions,
): VideoErrorResponse | null {
  if (
    modelConfig.provider === "byteplus" &&
    modelConfig.family === "seedance-2-5"
  ) {
    return null;
  }
  if (
    options.referenceAudioUrls.length > 0 &&
    options.referenceImageUrls.length === 0 &&
    options.inputVideoUrls.length === 0 &&
    !options.firstFrameImageUrl &&
    !options.lastFrameImageUrl
  ) {
    return badRequest(
      "reference audio requires at least one image or video reference",
    );
  }
  return null;
}

function videoReferenceLimits(modelConfig: VideoModelConfig): {
  readonly image: number | undefined;
  readonly video: number;
  readonly audio: number;
} {
  if (
    modelConfig.provider === "byteplus" &&
    modelConfig.family === "seedance-2-5"
  ) {
    return { image: 30, video: 10, audio: 10 };
  }
  return {
    image: undefined,
    video: 3,
    audio: modelConfig.provider === "minimax" ? 3 : 1,
  };
}

function validateVideoReferenceCounts(
  modelConfig: VideoModelConfig,
  options: VideoReferenceOptions,
): VideoErrorResponse | null {
  const limits = videoReferenceLimits(modelConfig);
  if (
    limits.image !== undefined &&
    options.referenceImageUrls.length > limits.image
  ) {
    return badRequest(
      `reference image URLs cannot exceed ${limits.image} items`,
    );
  }
  if (options.inputVideoUrls.length > limits.video) {
    return badRequest(
      `reference video URLs cannot exceed ${limits.video} items`,
    );
  }
  if (options.referenceAudioUrls.length > limits.audio) {
    return badRequest(
      `reference audio URLs cannot exceed ${limits.audio} ${
        limits.audio === 1 ? "item" : "items"
      }`,
    );
  }
  return null;
}

function validateVideoReferences(
  modelConfig: VideoModelConfig,
  options: VideoReferenceOptions,
): VideoErrorResponse | null {
  if (
    options.referenceImageUrls.length > 0 &&
    !modelConfig.supportsReferenceImage
  ) {
    return badRequest(
      `Reference images are not supported for ${options.alias}`,
    );
  }
  if (
    options.inputVideoUrls.length > 0 &&
    !modelConfig.supportsReferenceVideo
  ) {
    return badRequest(
      `Reference videos are not supported for ${options.alias}`,
    );
  }
  if (
    options.referenceAudioUrls.length > 0 &&
    !modelConfig.supportsReferenceAudio
  ) {
    return badRequest(`Reference audio is not supported for ${options.alias}`);
  }
  if (options.firstFrameImageUrl && !modelConfig.supportsFirstFrame) {
    return badRequest(
      `First frame image is not supported for ${options.alias}`,
    );
  }
  if (options.lastFrameImageUrl && !modelConfig.supportsLastFrame) {
    return badRequest(`Last frame image is not supported for ${options.alias}`);
  }
  const referenceCountError = validateVideoReferenceCounts(
    modelConfig,
    options,
  );
  if (referenceCountError) {
    return referenceCountError;
  }
  if (modelConfig.provider === "minimax") {
    const miniMaxError = validateMiniMaxVideoReferences(options);
    if (miniMaxError) {
      return miniMaxError;
    }
  }
  return validateReferenceAudioDependency(modelConfig, options);
}

function parseVideoGenerateAudio(
  body: Record<string, unknown>,
  modelConfig: VideoModelConfig,
): boolean | VideoErrorResponse {
  const requested = readBoolean(
    body,
    "generateAudio",
    readBoolean(body, "generate_audio", true),
  );
  if (modelConfig.provider === "minimax" && !requested) {
    return badRequest("MiniMax H3 always generates native audio");
  }
  return modelConfig.supportsGenerateAudio ? requested : false;
}

function parseVideoPrompt(
  body: Record<string, unknown>,
): string | VideoErrorResponse {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    return badRequest("prompt is required");
  }
  if (prompt.length > VIDEO_IO_MAX_PROMPT_LENGTH) {
    return badRequest(
      `prompt exceeds ${VIDEO_IO_MAX_PROMPT_LENGTH} characters`,
    );
  }
  return prompt;
}

function parseVideoAspectRatio(
  body: Record<string, unknown>,
  modelConfig: VideoModelConfig,
): VideoAspectRatio | VideoErrorResponse {
  const aspectRatio = readString(
    body,
    "aspectRatio",
    DEFAULT_VIDEO_ASPECT_RATIO,
  );
  if (!includesString(VIDEO_ASPECT_RATIOS, aspectRatio)) {
    return badRequest(`Unsupported video aspect ratio: ${aspectRatio}`);
  }
  if (!hasString(modelConfig.aspectRatios, aspectRatio)) {
    return badRequest(
      `Unsupported video aspect ratio for ${modelConfig.alias}: ${aspectRatio}`,
    );
  }
  return aspectRatio;
}

/**
 * Whether the request chose a model of its own.
 *
 * `parseVideoOptions` reads `model` through `readString`, which treats a blank
 * value as unset and applies its own default. A caller that decides whether to
 * substitute a different default has to answer the same question the same way;
 * two independent answers disagree exactly on `model: ""`, and the substitution
 * is then skipped for a request that never named anything.
 */
export function namesVideoModel(body: unknown): boolean {
  return isRecord(body) && readString(body, "model", "") !== "";
}

export function parseVideoOptions(
  body: unknown,
): VideoOptions | VideoErrorResponse {
  if (!isRecord(body)) {
    return badRequest("Invalid JSON body");
  }

  const prompt = parseVideoPrompt(body);
  if (typeof prompt !== "string") {
    return prompt;
  }

  const rawModel = readString(body, "model", DEFAULT_VIDEO_MODEL);
  const model = normalizeVideoModel(rawModel);
  if (!model) {
    return badRequest(
      `Unsupported video model: ${rawModel}. Available models: ${videoModelList()}`,
    );
  }
  const modelConfig = VIDEO_MODEL_CONFIGS[model];
  if (
    modelConfig.provider === "minimax" &&
    prompt.length > MINIMAX_H3_MAX_PROMPT_LENGTH
  ) {
    return badRequest(
      `prompt exceeds ${MINIMAX_H3_MAX_PROMPT_LENGTH} characters for MiniMax H3`,
    );
  }

  const aspectRatio = parseVideoAspectRatio(body, modelConfig);
  if (typeof aspectRatio !== "string") {
    return aspectRatio;
  }

  const duration = readString(body, "duration", DEFAULT_VIDEO_DURATION);
  if (!includesString(VIDEO_DURATIONS, duration)) {
    return badRequest(`Unsupported video duration: ${duration}`);
  }
  if (!hasString(modelConfig.durations, duration)) {
    return badRequest(
      `Unsupported video duration for ${modelConfig.alias}: ${duration}`,
    );
  }

  const resolution = readString(
    body,
    "resolution",
    modelConfig.defaultResolution,
  );
  if (!includesString(VIDEO_RESOLUTIONS, resolution)) {
    return badRequest(`Unsupported video resolution: ${resolution}`);
  }
  if (!hasString(modelConfig.resolutions, resolution)) {
    return badRequest(
      `Unsupported video resolution for ${modelConfig.alias}: ${resolution}`,
    );
  }

  const seed = typeof body.seed === "number" ? body.seed : undefined;
  if (
    seed !== undefined &&
    (!Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed))
  ) {
    return badRequest("seed must be a non-negative safe integer");
  }

  const referenceImageUrls = readStringArrayFromKeys(body, [
    "imageUrls",
    "image_urls",
    "referenceImageUrls",
    "reference_image_urls",
  ]);
  const inputVideoUrls = readStringArrayFromKeys(body, [
    "videoUrls",
    "video_urls",
    "inputVideoUrls",
    "input_video_urls",
    "referenceVideoUrls",
    "reference_video_urls",
  ]);
  const referenceAudioUrls = readStringArrayFromKeys(body, [
    "audioUrls",
    "audio_urls",
    "referenceAudioUrls",
    "reference_audio_urls",
  ]);
  const firstFrameImageUrl = readOptionalStringFromKeys(body, [
    "firstFrameImageUrl",
    "first_frame_image_url",
  ]);
  const lastFrameImageUrl = readOptionalStringFromKeys(body, [
    "lastFrameImageUrl",
    "last_frame_image_url",
  ]);

  const referenceError = validateVideoReferences(modelConfig, {
    alias: modelConfig.alias,
    referenceImageUrls,
    inputVideoUrls,
    referenceAudioUrls,
    firstFrameImageUrl,
    lastFrameImageUrl,
  });
  if (referenceError) {
    return referenceError;
  }

  const generateAudio = parseVideoGenerateAudio(body, modelConfig);
  if (typeof generateAudio !== "boolean") {
    return generateAudio;
  }

  return {
    model,
    prompt,
    aspectRatio,
    duration,
    durationSeconds: parseDurationSeconds(duration),
    resolution,
    generateAudio,
    negativePrompt:
      readOptionalString(body, "negativePrompt") ??
      readOptionalString(body, "negative_prompt"),
    seed,
    autoFix: readBoolean(body, "autoFix", readBoolean(body, "auto_fix", true)),
    safetyTolerance: readString(body, "safetyTolerance", "4"),
    referenceImageUrls,
    inputVideoUrls,
    referenceAudioUrls,
    firstFrameImageUrl,
    lastFrameImageUrl,
  };
}

function mapPricingRows(
  rows: readonly {
    readonly provider: string;
    readonly category: string;
    readonly unitPrice: number;
    readonly unitSize: number;
  }[],
  resolution: UsagePricingResolution,
): VideoPricing {
  const pricing = new Map<string, VideoPricingRow>();
  for (const row of rows) {
    const model = normalizeVideoModel(
      canonicalUsagePricingProvider(resolution, USAGE_KIND, row.provider),
    );
    if (model && includesString(VIDEO_PRICING_CATEGORIES, row.category)) {
      pricing.set(videoPricingKey(model, row.category), {
        provider: model,
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }
  return pricing;
}

function videoPricingKey(
  model: VideoModel,
  category: VideoPricingCategory,
): string {
  return `${model}:${category}`;
}

function videoPricingCategoryForOptions(
  options: Pick<
    VideoOptions,
    "generateAudio" | "inputVideoUrls" | "model" | "resolution"
  >,
): VideoPricingCategory {
  const config = VIDEO_MODEL_CONFIGS[options.model];
  if (config.provider === "minimax") {
    return options.resolution === "2k"
      ? MINIMAX_OUTPUT_VIDEO_2K_CATEGORY
      : MINIMAX_OUTPUT_VIDEO_768P_CATEGORY;
  }
  if (config.provider === "fal") {
    if (options.resolution === "4k") {
      return options.generateAudio
        ? VIDEO_AUDIO_4K_CATEGORY
        : VIDEO_SILENT_4K_CATEGORY;
    }
    return options.generateAudio ? VIDEO_AUDIO_CATEGORY : VIDEO_SILENT_CATEGORY;
  }
  if (config.family === "seedance-2-5" || config.family === "seedance-2") {
    const hasInputVideo = options.inputVideoUrls.length > 0;
    if (options.resolution === "1080p") {
      return hasInputVideo
        ? VIDEO_TOKEN_1080_WITH_VIDEO_CATEGORY
        : VIDEO_TOKEN_1080_NO_VIDEO_CATEGORY;
    }
    return hasInputVideo
      ? VIDEO_TOKEN_480_720_WITH_VIDEO_CATEGORY
      : VIDEO_TOKEN_480_720_NO_VIDEO_CATEGORY;
  }
  if (config.family === "seedance-1-5") {
    return options.generateAudio
      ? VIDEO_TOKEN_AUDIO_CATEGORY
      : VIDEO_TOKEN_SILENT_CATEGORY;
  }
  return VIDEO_TOKEN_CATEGORY;
}

function videoPricingCategoriesForOptions(
  options: Pick<
    VideoOptions,
    "generateAudio" | "inputVideoUrls" | "model" | "resolution"
  >,
): readonly VideoPricingCategory[] {
  if (VIDEO_MODEL_CONFIGS[options.model].provider === "minimax") {
    return MINIMAX_VIDEO_PRICING_CATEGORIES;
  }
  return [videoPricingCategoryForOptions(options)];
}

export function getMissingVideoPricing(
  pricing: ReadonlyMap<string, VideoPricingRow>,
  options: Pick<
    VideoOptions,
    "generateAudio" | "inputVideoUrls" | "model" | "resolution"
  >,
): readonly VideoPricingCategory[] {
  return videoPricingCategoriesForOptions(options).filter((category) => {
    return !pricing.has(videoPricingKey(options.model, category));
  });
}

export const videoPricing$: Computed<Promise<VideoPricing>> = computed(
  async (get): Promise<VideoPricing> => {
    const db = get(db$);
    const resolution = get(usagePricingResolution$);
    const lookupProviders = VIDEO_MODELS.map((provider) => {
      return resolveUsagePricingProvider(resolution, USAGE_KIND, provider);
    });
    const rows = await db
      .select({
        provider: usagePricing.provider,
        category: usagePricing.category,
        unitPrice: usagePricing.unitPrice,
        unitSize: usagePricing.unitSize,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, USAGE_KIND),
          inArray(usagePricing.provider, lookupProviders),
          inArray(usagePricing.category, [...VIDEO_PRICING_CATEGORIES]),
        ),
      );

    return mapPricingRows(rows, resolution);
  },
);

export const checkVideoCredits$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(checkBillableOperationCredits$, args, signal);
  },
);

function falHeaders(falKey: string): Record<string, string> {
  return {
    Authorization: `Key ${falKey}`,
    "Content-Type": "application/json",
  };
}

function parseFalQueueHandle(value: unknown): FalQueueHandle | null {
  if (!isRecord(value)) {
    return null;
  }
  const statusUrl =
    typeof value.status_url === "string" ? value.status_url : undefined;
  const responseUrl =
    typeof value.response_url === "string" ? value.response_url : undefined;
  if (!statusUrl || !responseUrl) {
    return null;
  }
  return {
    requestId:
      typeof value.request_id === "string" ? value.request_id : undefined,
    statusUrl,
    responseUrl,
  };
}

function falVideoQueueUrl(model: VideoModel): string {
  return `https://queue.fal.run/${model}`;
}

function falVideoInput(options: VideoOptions): Record<string, unknown> {
  const config = VIDEO_MODEL_CONFIGS[options.model];
  if (config.provider !== "fal") {
    throw new Error("Expected a Fal video model");
  }

  if (config.requestFormat === "kling") {
    return compactObject({
      prompt: options.prompt,
      aspect_ratio: options.aspectRatio,
      duration: String(options.durationSeconds),
      generate_audio: options.generateAudio,
      ...(config.supportsNegativePrompt && options.negativePrompt
        ? { negative_prompt: options.negativePrompt }
        : {}),
    });
  }

  return compactObject({
    prompt: options.prompt,
    aspect_ratio: options.aspectRatio,
    duration: options.duration,
    resolution: options.resolution,
    generate_audio: options.generateAudio,
    ...(config.supportsAutoFix ? { auto_fix: options.autoFix } : {}),
    ...(config.supportsSafetyTolerance
      ? { safety_tolerance: options.safetyTolerance }
      : {}),
    ...(config.supportsNegativePrompt && options.negativePrompt
      ? { negative_prompt: options.negativePrompt }
      : {}),
    ...(config.supportsSeed && options.seed !== undefined
      ? { seed: options.seed }
      : {}),
  });
}

export async function submitFalVideoGeneration(
  options: VideoOptions,
  falKey: string,
  signal: AbortSignal,
  webhookUrl: string,
): Promise<FalQueueHandle | VideoErrorResponse> {
  const queueUrl = new URL(falVideoQueueUrl(options.model));
  queueUrl.searchParams.set("fal_webhook", webhookUrl);
  const response = await fetch(queueUrl, {
    method: "POST",
    headers: falHeaders(falKey),
    body: JSON.stringify(falVideoInput(options)),
    signal,
  });

  if (!response.ok) {
    return videoInternalError("Video generation failed");
  }

  const body: unknown = await response.json();
  const handle = parseFalQueueHandle(body);
  if (!handle) {
    return badGateway("Fal returned no queue handle", "NO_QUEUE_HANDLE");
  }
  return handle;
}

function bearerJsonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function parseBytePlusTaskHandle(value: unknown): BytePlusTaskHandle | null {
  if (!isRecord(value)) {
    return null;
  }
  const taskId =
    typeof value.id === "string"
      ? value.id
      : typeof value.task_id === "string"
        ? value.task_id
        : undefined;
  if (!taskId) {
    return null;
  }
  return {
    taskId,
    status: typeof value.status === "string" ? value.status : undefined,
  };
}

function multimodalVideoContent(
  options: VideoOptions,
): readonly MultimodalVideoContent[] {
  const config = VIDEO_MODEL_CONFIGS[options.model];
  const requiresExplicitFrameRole =
    config.provider === "byteplus" && config.family === "seedance-2-5";
  const content: MultimodalVideoContent[] = [
    {
      type: "text",
      text: options.prompt,
    },
  ];
  const hasFirstAndLastFrame =
    Boolean(options.firstFrameImageUrl) && Boolean(options.lastFrameImageUrl);
  if (options.firstFrameImageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: options.firstFrameImageUrl },
      ...(hasFirstAndLastFrame || requiresExplicitFrameRole
        ? { role: "first_frame" }
        : {}),
    });
  }
  if (options.lastFrameImageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: options.lastFrameImageUrl },
      role: "last_frame",
    });
  }
  for (const url of options.referenceImageUrls) {
    content.push({
      type: "image_url",
      image_url: { url },
      role: "reference_image",
    });
  }
  for (const url of options.inputVideoUrls) {
    content.push({
      type: "video_url",
      video_url: { url },
      role: "reference_video",
    });
  }
  for (const url of options.referenceAudioUrls) {
    content.push({
      type: "audio_url",
      audio_url: { url },
      role: "reference_audio",
    });
  }
  return content;
}

function bytePlusVideoInput(
  options: VideoOptions,
  webhookUrl: string,
): Record<string, unknown> {
  const config = VIDEO_MODEL_CONFIGS[options.model];
  const usesAdaptiveFrameRatio =
    config.provider === "byteplus" &&
    config.family === "seedance-2-5" &&
    Boolean(options.firstFrameImageUrl || options.lastFrameImageUrl);
  return compactObject({
    model: options.model,
    content: multimodalVideoContent(options),
    callback_url: webhookUrl,
    resolution: options.resolution,
    ratio: usesAdaptiveFrameRatio ? "adaptive" : options.aspectRatio,
    duration: options.durationSeconds,
    ...(config.supportsGenerateAudio
      ? { generate_audio: options.generateAudio }
      : {}),
    ...(config.supportsSeed && options.seed !== undefined
      ? { seed: options.seed }
      : {}),
  });
}

async function readProviderErrorBodyForLog(
  response: Response,
): Promise<string | undefined> {
  const body = await tapError(response.text());
  if (!body) {
    return undefined;
  }
  const redactedBody = redactPresignedUrls(body);
  return redactedBody.length > PROVIDER_ERROR_BODY_LOG_MAX_LENGTH
    ? `${redactedBody.slice(0, PROVIDER_ERROR_BODY_LOG_MAX_LENGTH)}...`
    : redactedBody;
}

export async function submitBytePlusVideoGeneration(
  options: VideoOptions,
  apiKey: string,
  signal: AbortSignal,
  webhookUrl: string,
): Promise<BytePlusTaskHandle | VideoErrorResponse> {
  const response = await fetch(BYTEPLUS_VIDEO_TASKS_URL, {
    method: "POST",
    headers: bearerJsonHeaders(apiKey),
    body: JSON.stringify(bytePlusVideoInput(options, webhookUrl)),
    signal,
  });

  if (!response.ok) {
    const responseBody = await readProviderErrorBodyForLog(response);
    const providerError = videoProviderErrorFromText(
      responseBody,
      response.status,
      response.statusText,
    );
    L.warn("BytePlus video generation task creation failed", {
      provider: "byteplus",
      model: options.model,
      status: response.status,
      statusText: response.statusText,
      providerErrorCode: providerError.code,
      providerErrorMessage: providerError.message,
      responseBody,
      hasFirstFrameImage: Boolean(options.firstFrameImageUrl),
      hasLastFrameImage: Boolean(options.lastFrameImageUrl),
      referenceImageCount: options.referenceImageUrls.length,
      referenceVideoCount: options.inputVideoUrls.length,
      referenceAudioCount: options.referenceAudioUrls.length,
    });
    return bytePlusProviderErrorResponse(providerError, response.status);
  }

  const body: unknown = await response.json();
  const handle = parseBytePlusTaskHandle(body);
  if (!handle) {
    return badGateway("BytePlus returned no task handle", "NO_TASK_HANDLE");
  }
  return handle;
}

function miniMaxResolution(resolution: VideoResolution): "768P" | "2K" {
  if (resolution === "768p") {
    return "768P";
  }
  if (resolution === "2k") {
    return "2K";
  }
  throw new Error("Unsupported MiniMax H3 video resolution");
}

function miniMaxVideoInput(
  options: VideoOptions,
  webhookUrl: string,
): Record<string, unknown> {
  const hasFrameImage = Boolean(
    options.firstFrameImageUrl || options.lastFrameImageUrl,
  );
  return {
    model: options.model,
    content: multimodalVideoContent(options),
    callback_url: webhookUrl,
    resolution: miniMaxResolution(options.resolution),
    duration: options.durationSeconds,
    ratio: hasFrameImage ? "adaptive" : options.aspectRatio,
  };
}

function parseMiniMaxTaskHandle(value: unknown): MiniMaxTaskHandle | null {
  if (!isRecord(value) || typeof value.task_id !== "string") {
    return null;
  }
  return { taskId: value.task_id };
}

export async function submitMiniMaxVideoGeneration(
  options: VideoOptions,
  apiKey: string,
  signal: AbortSignal,
  webhookUrl: string,
): Promise<MiniMaxTaskHandle | VideoErrorResponse> {
  const response = await fetch(MINIMAX_VIDEO_GENERATION_URL, {
    method: "POST",
    headers: bearerJsonHeaders(apiKey),
    body: JSON.stringify(miniMaxVideoInput(options, webhookUrl)),
    signal,
  });

  if (!response.ok) {
    const responseBody = await readProviderErrorBodyForLog(response);
    const providerError = videoProviderErrorFromText(
      responseBody,
      response.status,
      response.statusText,
    );
    L.warn("MiniMax H3 video generation task creation failed", {
      provider: "minimax",
      model: options.model,
      status: response.status,
      statusText: response.statusText,
      providerErrorCode: providerError.code,
      providerErrorMessage: providerError.message,
      responseBody,
      hasFirstFrameImage: Boolean(options.firstFrameImageUrl),
      hasLastFrameImage: Boolean(options.lastFrameImageUrl),
      referenceImageCount: options.referenceImageUrls.length,
      referenceVideoCount: options.inputVideoUrls.length,
      referenceAudioCount: options.referenceAudioUrls.length,
    });
    return miniMaxProviderErrorResponse(providerError, response.status);
  }

  const body: unknown = await response.json();
  const handle = parseMiniMaxTaskHandle(body);
  if (!handle) {
    return badGateway("MiniMax returned no task handle", "NO_TASK_HANDLE");
  }
  return handle;
}

function normalizeVideoContentType(
  value: string | null | undefined,
): string | null {
  const contentType = value?.split(";")[0]?.trim().toLowerCase();
  if (
    contentType === "video/mp4" ||
    contentType === "video/webm" ||
    contentType === "video/quicktime"
  ) {
    return contentType;
  }
  return null;
}

function readVideoUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = readVideoUrl(entry);
      if (url) {
        return url;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const directUrl =
    typeof value.video_url === "string"
      ? value.video_url
      : typeof value.url === "string"
        ? value.url
        : undefined;
  if (directUrl) {
    return directUrl;
  }
  return (
    readVideoUrl(value.video_url) ??
    readVideoUrl(value.video) ??
    readVideoUrl(value.output) ??
    readVideoUrl(value.result) ??
    readVideoUrl(value.content)
  );
}

function readVideoContentType(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const contentType = readVideoContentType(entry);
      if (contentType) {
        return contentType;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const directType =
    typeof value.content_type === "string"
      ? value.content_type
      : typeof value.contentType === "string"
        ? value.contentType
        : undefined;
  if (directType) {
    return directType;
  }
  return (
    readVideoContentType(value.video_url) ??
    readVideoContentType(value.video) ??
    readVideoContentType(value.output) ??
    readVideoContentType(value.result) ??
    readVideoContentType(value.content)
  );
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.ceil(value);
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.ceil(value);
}

function readCompletionTokens(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage = isRecord(value.usage) ? value.usage : undefined;
  return (
    readPositiveInteger(usage?.completion_tokens) ??
    readPositiveInteger(usage?.total_tokens) ??
    readPositiveInteger(value.completion_tokens)
  );
}

function parseFalFile(value: unknown): FalFile | null {
  if (!isRecord(value) || typeof value.url !== "string") {
    return null;
  }
  return {
    url: value.url,
    contentType:
      typeof value.content_type === "string" ? value.content_type : undefined,
  };
}

export function parseFalVideoResult(
  value: unknown,
  requestId: string | undefined,
): FalVideoResult | VideoErrorResponse {
  if (!isRecord(value)) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  const video = parseFalFile(value.video);
  const sourceUrl = video?.url ?? readVideoUrl(value.video);
  if (!sourceUrl) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  return {
    requestId,
    sourceUrl,
    falContentType: video?.contentType ?? readVideoContentType(value.video),
  };
}

export function parseBytePlusVideoResult(
  value: unknown,
): BytePlusVideoResult | VideoErrorResponse {
  if (!isRecord(value)) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  const sourceUrl =
    readVideoUrl(value.content) ??
    readVideoUrl(value.output) ??
    readVideoUrl(value.result) ??
    readVideoUrl(value);
  if (!sourceUrl) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  return {
    requestId:
      typeof value.id === "string"
        ? value.id
        : typeof value.task_id === "string"
          ? value.task_id
          : undefined,
    sourceUrl,
    bytePlusContentType: readVideoContentType(value),
    completionTokens: readCompletionTokens(value),
  };
}

export function parseMiniMaxVideoResult(
  value: unknown,
): MiniMaxVideoResult | VideoErrorResponse {
  if (!isRecord(value)) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  const task = isRecord(value.task) ? value.task : value;
  const sourceUrl = readVideoUrl(task.content);
  if (!sourceUrl) {
    return badGateway("Model returned no video data", "NO_VIDEO_RETURNED");
  }
  if (typeof task.id !== "string" || task.id.length === 0) {
    return badGateway("MiniMax returned no task ID", "NO_TASK_HANDLE");
  }
  const resolution =
    task.resolution === "768P"
      ? "768p"
      : task.resolution === "2K"
        ? "2k"
        : undefined;
  if (!resolution) {
    return badGateway(
      "MiniMax returned an invalid resolution",
      "INVALID_VIDEO_RESULT",
    );
  }
  if (!isRecord(task.usage)) {
    return badGateway("MiniMax returned no usage data", "INVALID_VIDEO_USAGE");
  }
  const outputSeconds = readPositiveInteger(task.usage.output_seconds);
  const inputSeconds = readNonNegativeInteger(task.usage.input_seconds);
  const inputImageCount = readNonNegativeInteger(task.usage.input_image_count);
  if (
    outputSeconds === undefined ||
    inputSeconds === undefined ||
    inputImageCount === undefined
  ) {
    return badGateway(
      "MiniMax returned invalid usage data",
      "INVALID_VIDEO_USAGE",
    );
  }
  const aspectRatio =
    typeof task.ratio === "string" &&
    includesString(VIDEO_ASPECT_RATIOS, task.ratio)
      ? task.ratio
      : undefined;
  return {
    requestId: task.id,
    sourceUrl,
    resolution,
    aspectRatio,
    outputSeconds,
    inputSeconds,
    inputImageCount,
  };
}

export async function downloadFalVideo(
  result: FalVideoResult,
  options: VideoOptions,
  signal: AbortSignal,
): Promise<ParsedVideoGeneration | VideoErrorResponse> {
  const response = await fetch(result.sourceUrl, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download generated video",
      "VIDEO_DOWNLOAD_FAILED",
    );
  }

  const videoBytes = Buffer.from(await response.arrayBuffer());
  if (videoBytes.byteLength === 0) {
    return badGateway("Model returned empty video", "NO_VIDEO_RETURNED");
  }

  const contentType =
    normalizeVideoContentType(result.falContentType) ??
    normalizeVideoContentType(response.headers.get("content-type")) ??
    "video/mp4";

  return {
    model: options.model,
    videoBytes,
    contentType,
    sourceUrl: result.sourceUrl,
    requestId: result.requestId,
    aspectRatio: options.aspectRatio,
    duration: options.duration,
    durationSeconds: options.durationSeconds,
    resolution: options.resolution,
    generateAudio: options.generateAudio,
    negativePrompt: options.negativePrompt,
    seed: options.seed,
    autoFix: options.autoFix,
    safetyTolerance: options.safetyTolerance,
    referenceImageUrls: options.referenceImageUrls,
    inputVideoUrls: options.inputVideoUrls,
    referenceAudioUrls: options.referenceAudioUrls,
    firstFrameImageUrl: options.firstFrameImageUrl,
    lastFrameImageUrl: options.lastFrameImageUrl,
    billing: [
      {
        category: videoPricingCategoryForOptions(options),
        quantity: videoBillingQuantityForOptions(options),
      },
    ],
  };
}

export async function downloadBytePlusVideo(
  result: BytePlusVideoResult,
  options: VideoOptions,
  signal: AbortSignal,
): Promise<ParsedVideoGeneration | VideoErrorResponse> {
  const response = await fetch(result.sourceUrl, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download generated video",
      "VIDEO_DOWNLOAD_FAILED",
    );
  }

  const videoBytes = Buffer.from(await response.arrayBuffer());
  if (videoBytes.byteLength === 0) {
    return badGateway("Model returned empty video", "NO_VIDEO_RETURNED");
  }

  const contentType =
    normalizeVideoContentType(result.bytePlusContentType) ??
    normalizeVideoContentType(response.headers.get("content-type")) ??
    "video/mp4";

  return {
    model: options.model,
    videoBytes,
    contentType,
    sourceUrl: result.sourceUrl,
    requestId: result.requestId,
    aspectRatio: options.aspectRatio,
    duration: options.duration,
    durationSeconds: options.durationSeconds,
    resolution: options.resolution,
    generateAudio: options.generateAudio,
    negativePrompt: options.negativePrompt,
    seed: options.seed,
    autoFix: options.autoFix,
    safetyTolerance: options.safetyTolerance,
    referenceImageUrls: options.referenceImageUrls,
    inputVideoUrls: options.inputVideoUrls,
    referenceAudioUrls: options.referenceAudioUrls,
    firstFrameImageUrl: options.firstFrameImageUrl,
    lastFrameImageUrl: options.lastFrameImageUrl,
    billing: [
      {
        category: videoPricingCategoryForOptions(options),
        quantity:
          result.completionTokens ?? videoBillingQuantityForOptions(options),
      },
    ],
  };
}

function miniMaxOutputVideoCategory(
  resolution: "768p" | "2k",
): VideoPricingCategory {
  return resolution === "2k"
    ? MINIMAX_OUTPUT_VIDEO_2K_CATEGORY
    : MINIMAX_OUTPUT_VIDEO_768P_CATEGORY;
}

function miniMaxInputVideoCategory(
  resolution: "768p" | "2k",
): VideoPricingCategory {
  return resolution === "2k"
    ? MINIMAX_INPUT_VIDEO_2K_CATEGORY
    : MINIMAX_INPUT_VIDEO_768P_CATEGORY;
}

function miniMaxBillingEntries(
  result: MiniMaxVideoResult,
): readonly VideoBillingEntry[] {
  return [
    {
      category: miniMaxOutputVideoCategory(result.resolution),
      quantity: result.outputSeconds,
    },
    {
      category: miniMaxInputVideoCategory(result.resolution),
      quantity: result.inputSeconds,
    },
    {
      category: MINIMAX_ADDITIONAL_INPUT_IMAGE_CATEGORY,
      quantity: Math.max(result.inputImageCount - 5, 0),
    },
  ];
}

export async function downloadMiniMaxVideo(
  result: MiniMaxVideoResult,
  options: VideoOptions,
  signal: AbortSignal,
): Promise<ParsedVideoGeneration | VideoErrorResponse> {
  const response = await fetch(result.sourceUrl, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download generated video",
      "VIDEO_DOWNLOAD_FAILED",
    );
  }

  const videoBytes = Buffer.from(await response.arrayBuffer());
  if (videoBytes.byteLength === 0) {
    return badGateway("Model returned empty video", "NO_VIDEO_RETURNED");
  }

  return {
    model: options.model,
    videoBytes,
    contentType:
      normalizeVideoContentType(response.headers.get("content-type")) ??
      "video/mp4",
    sourceUrl: result.sourceUrl,
    requestId: result.requestId,
    aspectRatio: result.aspectRatio ?? options.aspectRatio,
    duration: options.duration,
    durationSeconds: options.durationSeconds,
    resolution: result.resolution,
    generateAudio: true,
    negativePrompt: undefined,
    seed: undefined,
    autoFix: false,
    safetyTolerance: options.safetyTolerance,
    referenceImageUrls: options.referenceImageUrls,
    inputVideoUrls: options.inputVideoUrls,
    referenceAudioUrls: options.referenceAudioUrls,
    firstFrameImageUrl: options.firstFrameImageUrl,
    lastFrameImageUrl: options.lastFrameImageUrl,
    billing: miniMaxBillingEntries(result),
  };
}

function extensionForContentType(contentType: string): string {
  if (contentType === "video/webm") {
    return "webm";
  }
  if (contentType === "video/quicktime") {
    return "mov";
  }
  return "mp4";
}

function isSeedanceResolution(
  resolution: VideoResolution,
): resolution is SeedanceResolution {
  return includesString(SEEDANCE_RESOLUTIONS, resolution);
}

function seedanceDimensions(
  model: VideoModel,
  resolution: VideoResolution,
  aspectRatio: VideoAspectRatio,
): VideoDimensions {
  if (!isSeedanceResolution(resolution)) {
    throw new Error("Unsupported Seedance video resolution");
  }
  const config = VIDEO_MODEL_CONFIGS[model];
  if (config.provider !== "byteplus") {
    throw new Error("Expected a BytePlus video model");
  }
  const dimensionTable: DimensionTable =
    config.family === "seedance-2-5"
      ? SEEDANCE_2_5_DIMENSIONS
      : SEEDANCE_2_DIMENSIONS;
  const dimensions = dimensionTable[resolution];
  if (!dimensions) {
    throw new Error(`Unsupported Seedance resolution: ${resolution}`);
  }
  return dimensions[aspectRatio];
}

function seedanceOutputTokens(
  options: Pick<
    VideoOptions,
    "aspectRatio" | "durationSeconds" | "model" | "resolution"
  >,
): number {
  const dimensions = seedanceDimensions(
    options.model,
    options.resolution,
    options.aspectRatio,
  );
  return Math.ceil(
    (dimensions.width * dimensions.height * options.durationSeconds * 24) /
      1024,
  );
}

function videoBillingQuantityForOptions(
  options: Pick<
    VideoOptions,
    "aspectRatio" | "durationSeconds" | "model" | "resolution"
  >,
): number {
  if (VIDEO_MODEL_CONFIGS[options.model].provider === "fal") {
    return options.durationSeconds;
  }
  return seedanceOutputTokens(options);
}

function estimateVideoCredits(
  model: VideoModel,
  billing: readonly VideoBillingEntry[],
  pricing: VideoPricing,
): number {
  return billing.reduce((total, row) => {
    if (row.quantity <= 0) {
      return total;
    }
    const pricingRow = pricing.get(videoPricingKey(model, row.category));
    if (!pricingRow) {
      throw new Error(`Missing video pricing for ${model}:${row.category}`);
    }
    return (
      total +
      Math.ceil((row.quantity * pricingRow.unitPrice) / pricingRow.unitSize)
    );
  }, 0);
}

interface RecordGeneratedVideoArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly billingRunId: string | null;
  readonly billingContext: string;
  readonly publicBrand: PublicBrand;
  readonly privateArtifacts: boolean;
  readonly pricing: VideoPricing;
  readonly generation: ParsedVideoGeneration;
  readonly usageIdempotency: BuiltInGenerationUsageIdempotency;
}

export const recordGeneratedVideo$ = command(
  async (
    { set },
    params: RecordGeneratedVideoArgs,
    signal: AbortSignal,
  ): Promise<RecordedVideo> => {
    const writeDb = set(writeDb$);
    const artifact = await set(
      storeGeneratedArtifactObject$,
      {
        userId: params.userId,
        orgId: params.orgId,
        privateArtifacts: params.privateArtifacts,
        filenamePrefix: "video",
        extension: extensionForContentType(params.generation.contentType),
        body: params.generation.videoBytes,
        contentType: params.generation.contentType,
        publicBrand: params.publicBrand,
      },
      signal,
    );
    const { id: fileId, filename, key: s3Key, url } = artifact;
    await set(
      recordWebUploadedFile$,
      {
        runId: params.runId,
        externalId: fileId,
        userId: params.userId,
        orgId: params.orgId,
        filename,
        contentType: params.generation.contentType,
        sizeBytes: params.generation.videoBytes.byteLength,
        url,
        s3Key,
        publicBrand: params.publicBrand,
        metadata: compactObject({
          generatedBy: "zero-official-video",
          model: params.generation.model,
          sourceUrl: artifact.isPrivate
            ? undefined
            : params.generation.sourceUrl,
          requestId: params.generation.requestId,
          aspectRatio: params.generation.aspectRatio,
          duration: params.generation.duration,
          durationSeconds: params.generation.durationSeconds,
          resolution: params.generation.resolution,
          generateAudio: params.generation.generateAudio,
          negativePrompt: params.generation.negativePrompt,
          seed: params.generation.seed,
          autoFix: params.generation.autoFix,
          safetyTolerance: params.generation.safetyTolerance,
          billingQuantity: params.generation.billing[0]?.quantity,
          billing: params.generation.billing,
          referenceImageUrls:
            params.generation.referenceImageUrls.length > 0
              ? params.generation.referenceImageUrls
              : undefined,
          inputVideoUrls:
            params.generation.inputVideoUrls.length > 0
              ? params.generation.inputVideoUrls
              : undefined,
          referenceAudioUrls:
            params.generation.referenceAudioUrls.length > 0
              ? params.generation.referenceAudioUrls
              : undefined,
          firstFrameImageUrl: params.generation.firstFrameImageUrl,
          lastFrameImageUrl: params.generation.lastFrameImageUrl,
        }),
      },
      signal,
    );
    signal.throwIfAborted();

    const usageRows = params.generation.billing.filter((row) => {
      return row.quantity > 0;
    });

    await writeDb
      .insert(usageEvent)
      .values(
        usageRows.map((row) => {
          return {
            runId: params.runId ?? null,
            billingRunId: params.billingRunId,
            billingContext: params.billingContext,
            idempotencyKey: builtInGenerationUsageIdempotencyKey({
              ...params.usageIdempotency,
              category: row.category,
            }),
            orgId: params.orgId,
            userId: params.userId,
            kind: USAGE_KIND,
            provider: params.generation.model,
            category: row.category,
            quantity: row.quantity,
          };
        }),
      )
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    return {
      id: fileId,
      filename,
      contentType: params.generation.contentType,
      size: params.generation.videoBytes.byteLength,
      url,
      durationSeconds: params.generation.durationSeconds,
      creditsCharged: estimateVideoCredits(
        params.generation.model,
        params.generation.billing,
        params.pricing,
      ),
      model: params.generation.model,
      aspectRatio: params.generation.aspectRatio,
      duration: params.generation.duration,
      resolution: params.generation.resolution,
      generateAudio: params.generation.generateAudio,
      sourceUrl: artifact.isPrivate ? undefined : params.generation.sourceUrl,
      requestId: params.generation.requestId,
    };
  },
);
