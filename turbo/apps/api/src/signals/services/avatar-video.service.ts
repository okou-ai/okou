import { Buffer } from "node:buffer";

import { command, computed, type Computed } from "ccstate";
import {
  AVATAR_VIDEO_TRANSPARENT_SCREEN_STYLE,
  avatarVideoGenerateRequestSchema,
  type AvatarVideoAvatarsQuery,
  type AvatarVideoVoicesQuery,
} from "@okouai/api-contracts/contracts/avatar-video";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { redactPresignedUrls } from "../../lib/presigned-url-redaction";
import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
} from "../context/usage-pricing-resolution";
import { db$, writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { checkBillableOperationCredits$ } from "./billable-operation-admission.service";
import { storeGeneratedArtifactObject$ } from "./artifact-storage.service";
import {
  builtInGenerationUsageIdempotencyKey,
  type BuiltInGenerationUsageIdempotency,
} from "./built-in-generation-usage-idempotency";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";

const L = logger("AvatarVideo");

const JOGGAI_AVATAR_VIDEO_MODEL = "joggai-talking-avatar";
const JOGGAI_AVATAR_VIDEO_PRICING_CATEGORY = "output_video_joggai_credits";

const JOGGAI_API_BASE_URL = "https://api.jogg.ai/v2";
const JOGGAI_CREATE_AVATAR_VIDEO_URL = `${JOGGAI_API_BASE_URL}/create_video_from_avatar`;
const JOGGAI_PUBLIC_AVATARS_URL = `${JOGGAI_API_BASE_URL}/avatars/public`;
const JOGGAI_PUBLIC_VOICES_URL = `${JOGGAI_API_BASE_URL}/voices`;
const JOGGAI_CREDIT_DURATION_SECONDS = 120;

type ErrorStatus = 400 | 402 | 502 | 503;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

interface AvatarVideoErrorResponse {
  readonly status: ErrorStatus;
  readonly body: ErrorBody;
}

export interface AvatarVideoOptions {
  readonly avatarId: number;
  readonly voiceId: string;
  readonly inputType: "script" | "audio";
  readonly script: string | undefined;
  readonly audioUrl: string | undefined;
  readonly aspectRatio: "portrait" | "landscape" | "square";
  readonly screenStyle: 1 | 2 | 3;
  readonly caption: boolean;
  readonly videoName: string | undefined;
}

interface AvatarVideoPricingRow {
  readonly provider: typeof JOGGAI_AVATAR_VIDEO_MODEL;
  readonly category: typeof JOGGAI_AVATAR_VIDEO_PRICING_CATEGORY;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface JoggAiAvatarVideoHandle {
  readonly videoId: string;
}

interface JoggAiAvatar {
  readonly id: number;
  readonly name: string;
  readonly videoUrl?: string;
  readonly coverUrl?: string;
  readonly aspectRatio?: number;
  readonly style?: string;
  readonly gender?: string;
  readonly age?: string;
}

interface JoggAiVoice {
  readonly id: string;
  readonly name: string;
  readonly sampleUrl?: string;
  readonly language?: string;
  readonly gender?: string;
  readonly age?: string;
  readonly accent?: string;
  readonly useCase?: string;
}

interface JoggAiVoiceFilterOptions {
  readonly languages: readonly string[];
  readonly useCases: readonly string[];
}

type JoggAiWebhookPayload =
  | { readonly kind: "pending" }
  | {
      readonly kind: "failed";
      readonly videoId: string;
      readonly message: string;
    }
  | {
      readonly kind: "completed";
      readonly videoId: string;
      readonly sourceUrl: string;
      readonly coverUrl: string | undefined;
      readonly durationSeconds: number;
    };

interface ParsedAvatarVideoGeneration {
  readonly videoBytes: Buffer;
  readonly contentType: string;
  readonly sourceUrl: string;
  readonly coverUrl: string | undefined;
  readonly providerVideoId: string;
  readonly durationSeconds: number;
  readonly billingQuantity: number;
  readonly options: AvatarVideoOptions;
}

interface RecordedAvatarVideo {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly privateArtifacts: boolean;
  readonly durationSeconds: number;
  readonly creditsCharged: number;
  readonly provider: "joggai";
  readonly model: typeof JOGGAI_AVATAR_VIDEO_MODEL;
  readonly providerVideoId: string;
  readonly avatarId: number;
  readonly voiceId: string;
  readonly inputType: "script" | "audio";
  readonly aspectRatio: "portrait" | "landscape" | "square";
  readonly screenStyle: 1 | 2 | 3;
  readonly caption: boolean;
  readonly sourceUrl: string | undefined;
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string): AvatarVideoErrorResponse {
  return { status: 400, body: errorBody(message, "BAD_REQUEST") };
}

function badGateway(message: string, code: string): AvatarVideoErrorResponse {
  return { status: 502, body: errorBody(message, code) };
}

export function avatarVideoServiceUnavailable(
  message: string,
): AvatarVideoErrorResponse {
  return { status: 503, body: errorBody(message, "NOT_CONFIGURED") };
}

export function avatarVideoInsufficientCredits(): AvatarVideoErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

export function avatarVideoRequiresPaidPlan(): AvatarVideoErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Built-in avatar video generation requires Pro, Team, or Custom workspace access.",
      "PRO_REQUIRED",
    ),
  };
}

export function isAvatarVideoErrorResponse(
  value: unknown,
): value is AvatarVideoErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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

export function parseAvatarVideoOptions(
  body: unknown,
): AvatarVideoOptions | AvatarVideoErrorResponse {
  const parsed = avatarVideoGenerateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid request");
  }
  const inputType = parsed.data.script ? "script" : "audio";
  const screenStyle = parsed.data.screenStyle ?? 1;
  // JoggAI documents that the alpha-channel WebM is only produced with captions
  // off, so a transparent request defaults to no captions. An explicit caption
  // choice still wins; the provider owns the rule.
  const captionDefault = screenStyle !== AVATAR_VIDEO_TRANSPARENT_SCREEN_STYLE;
  return {
    avatarId: parsed.data.avatarId,
    voiceId: parsed.data.voiceId,
    inputType,
    script: parsed.data.script,
    audioUrl: parsed.data.audioUrl,
    aspectRatio: parsed.data.aspectRatio ?? "portrait",
    screenStyle,
    caption: parsed.data.caption ?? captionDefault,
    videoName: parsed.data.videoName,
  };
}

export const avatarVideoPricing$: Computed<
  Promise<AvatarVideoPricingRow | null>
> = computed(async (get): Promise<AvatarVideoPricingRow | null> => {
  const db = get(db$);
  const provider = resolveUsagePricingProvider(
    get(usagePricingResolution$),
    "video",
    JOGGAI_AVATAR_VIDEO_MODEL,
  );
  const [row] = await db
    .select({
      provider: usagePricing.provider,
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, provider),
        eq(usagePricing.category, JOGGAI_AVATAR_VIDEO_PRICING_CATEGORY),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    provider: JOGGAI_AVATAR_VIDEO_MODEL,
    category: JOGGAI_AVATAR_VIDEO_PRICING_CATEGORY,
    unitPrice: row.unitPrice,
    unitSize: row.unitSize,
  };
});

export const checkAvatarVideoCredits$ = command(
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

function joggAiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}

function joggAiProviderError(
  responseStatus: number,
  code: number | undefined,
  message: string | undefined,
): AvatarVideoErrorResponse {
  const providerMessage = message ?? "Unknown provider error";
  if (responseStatus === 400 || code === 40_000) {
    return badRequest(`JoggAI rejected the request: ${providerMessage}`);
  }
  if (code === 10_105 || code === 18_020 || code === 18_025) {
    return {
      status: 503,
      body: errorBody(
        "JoggAI avatar video generation is temporarily unavailable",
        "JOGGAI_UNAVAILABLE",
      ),
    };
  }
  return badGateway(
    `JoggAI avatar video generation failed: ${providerMessage}`,
    "JOGGAI_REQUEST_FAILED",
  );
}

function joggAiEnvelopeError(
  body: unknown,
  responseStatus: number,
): AvatarVideoErrorResponse | null {
  if (!isRecord(body)) {
    return badGateway(
      "JoggAI returned an invalid response",
      "JOGGAI_BAD_RESPONSE",
    );
  }
  const code = optionalNumber(body.code);
  if (responseStatus >= 200 && responseStatus < 300 && code === 0) {
    return null;
  }
  const rawMessage = optionalString(body.msg);
  const message = rawMessage ? redactPresignedUrls(rawMessage) : undefined;
  L.warn("JoggAI API request failed", {
    status: responseStatus,
    providerCode: code,
    providerMessage: message,
  });
  return joggAiProviderError(responseStatus, code, message);
}

function joggAiVoiceInput(
  options: AvatarVideoOptions,
): Record<string, unknown> {
  if (options.inputType === "script") {
    return {
      type: "script",
      voice_id: options.voiceId,
      script: options.script,
    };
  }
  return {
    type: "audio",
    voice_id: options.voiceId,
    audio_url: options.audioUrl,
  };
}

export async function submitJoggAiAvatarVideo(
  options: AvatarVideoOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<JoggAiAvatarVideoHandle | AvatarVideoErrorResponse> {
  const response = await fetch(JOGGAI_CREATE_AVATAR_VIDEO_URL, {
    method: "POST",
    headers: joggAiHeaders(apiKey),
    body: JSON.stringify(
      compactObject({
        avatar: { avatar_type: 0, avatar_id: options.avatarId },
        voice: joggAiVoiceInput(options),
        aspect_ratio: options.aspectRatio,
        screen_style: options.screenStyle,
        caption: options.caption,
        video_name: options.videoName,
      }),
    ),
    signal,
  });
  const body = safeJsonParse(await response.text());
  const error = joggAiEnvelopeError(body, response.status);
  if (error) {
    return error;
  }
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const videoId = data ? optionalString(data.video_id) : undefined;
  if (!videoId) {
    return badGateway(
      "JoggAI returned no avatar video ID",
      "JOGGAI_NO_VIDEO_ID",
    );
  }
  return { videoId };
}

function addQueryValue(
  url: URL,
  key: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) {
    url.searchParams.set(key, String(value));
  }
}

function parseJoggAiAvatar(value: unknown): JoggAiAvatar | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = optionalNumber(value.id);
  const name = optionalString(value.name);
  if (!id || !Number.isInteger(id) || !name) {
    return null;
  }
  const videoUrl = optionalString(value.video_url);
  const coverUrl = optionalString(value.cover_url);
  const aspectRatio = optionalNumber(value.aspect_ratio);
  const style = optionalString(value.style);
  const gender = optionalString(value.gender);
  const age = optionalString(value.age);
  return {
    id,
    name,
    ...(videoUrl ? { videoUrl } : {}),
    ...(coverUrl ? { coverUrl } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...(style ? { style } : {}),
    ...(gender ? { gender } : {}),
    ...(age ? { age } : {}),
  };
}

function parseJoggAiVoice(value: unknown): JoggAiVoice | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = optionalString(value.voice_id);
  const name = optionalString(value.name);
  if (!id || !name) {
    return null;
  }
  const sampleUrl = optionalString(value.audio_url);
  const language = optionalString(value.language);
  const gender = optionalString(value.gender);
  const age = optionalString(value.age);
  const accent = optionalString(value.accent);
  const useCase = optionalString(value.use_case);
  return {
    id,
    name,
    ...(sampleUrl ? { sampleUrl } : {}),
    ...(language ? { language } : {}),
    ...(gender ? { gender } : {}),
    ...(age ? { age } : {}),
    ...(accent ? { accent } : {}),
    ...(useCase ? { useCase } : {}),
  };
}

function paginateProviderCollection<T>(
  items: readonly T[],
  page: number | undefined,
  pageSize: number | undefined,
): readonly T[] {
  if (
    page === undefined ||
    pageSize === undefined ||
    items.length <= pageSize
  ) {
    return items;
  }
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

function normalizedCategoryValues(
  values: readonly (string | undefined)[],
): readonly string[] {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const normalized = value?.trim().toLowerCase();
        return normalized ? [normalized] : [];
      }),
    ),
  ).sort();
}

async function getJoggAiCollection(
  url: URL,
  apiKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | AvatarVideoErrorResponse> {
  const response = await fetch(url, {
    method: "GET",
    headers: joggAiHeaders(apiKey),
    signal,
  });
  const body = safeJsonParse(await response.text());
  const error = joggAiEnvelopeError(body, response.status);
  if (error) {
    return error;
  }
  if (!isRecord(body) || !isRecord(body.data)) {
    return badGateway(
      "JoggAI returned an invalid response",
      "JOGGAI_BAD_RESPONSE",
    );
  }
  return body.data;
}

export async function listJoggAiPublicAvatars(
  query: AvatarVideoAvatarsQuery,
  apiKey: string,
  signal: AbortSignal,
): Promise<
  { readonly avatars: readonly JoggAiAvatar[] } | AvatarVideoErrorResponse
> {
  const url = new URL(JOGGAI_PUBLIC_AVATARS_URL);
  addQueryValue(url, "page", query.page);
  addQueryValue(url, "page_size", query.pageSize);
  addQueryValue(url, "aspect_ratio", query.aspectRatio);
  addQueryValue(url, "style", query.style);
  addQueryValue(url, "gender", query.gender);
  addQueryValue(url, "age", query.age);
  addQueryValue(url, "scene", query.scene);
  addQueryValue(url, "ethnicity", query.ethnicity);

  const data = await getJoggAiCollection(url, apiKey, signal);
  if (isAvatarVideoErrorResponse(data)) {
    return data;
  }
  if (!Array.isArray(data.avatars)) {
    return badGateway("JoggAI returned no avatar list", "JOGGAI_BAD_RESPONSE");
  }
  const avatars = data.avatars.flatMap((value) => {
    const avatar = parseJoggAiAvatar(value);
    return avatar ? [avatar] : [];
  });
  return {
    avatars: paginateProviderCollection(avatars, query.page, query.pageSize),
  };
}

export async function listJoggAiPublicVoices(
  query: AvatarVideoVoicesQuery,
  apiKey: string,
  signal: AbortSignal,
): Promise<
  | {
      readonly voices: readonly JoggAiVoice[];
      readonly hasMore: boolean;
      readonly filterOptions: JoggAiVoiceFilterOptions;
    }
  | AvatarVideoErrorResponse
> {
  const url = new URL(JOGGAI_PUBLIC_VOICES_URL);
  addQueryValue(url, "page", query.page);
  addQueryValue(url, "page_size", query.pageSize);
  addQueryValue(url, "gender", query.gender);
  addQueryValue(url, "language", query.language);
  addQueryValue(url, "age", query.age);
  addQueryValue(url, "use_case", query.useCase);

  const data = await getJoggAiCollection(url, apiKey, signal);
  if (isAvatarVideoErrorResponse(data)) {
    return data;
  }
  if (!Array.isArray(data.voices)) {
    return badGateway("JoggAI returned no voice list", "JOGGAI_BAD_RESPONSE");
  }
  const voices = data.voices.flatMap((value) => {
    const voice = parseJoggAiVoice(value);
    return voice ? [voice] : [];
  });
  const providerReturnedFullCollection =
    query.page !== undefined &&
    query.pageSize !== undefined &&
    voices.length > query.pageSize;
  const pageVoices = paginateProviderCollection(
    voices,
    query.page,
    query.pageSize,
  );
  const fullCollectionHasMore =
    query.pageSize !== undefined &&
    pageVoices.length === query.pageSize &&
    (query.page ?? 1) * query.pageSize < voices.length;
  return {
    voices: pageVoices,
    hasMore: providerReturnedFullCollection
      ? fullCollectionHasMore
      : data.has_more === true,
    filterOptions: {
      languages: normalizedCategoryValues(
        voices.map((voice) => {
          return voice.language;
        }),
      ),
      useCases: normalizedCategoryValues(
        voices.map((voice) => {
          return voice.useCase;
        }),
      ),
    },
  };
}

function webhookErrorMessage(value: Record<string, unknown>): string {
  if (isRecord(value.error)) {
    return (
      optionalString(value.error.message) ??
      optionalString(value.error.code) ??
      "Generation failed"
    );
  }
  return optionalString(value.err_msg) ?? "Generation failed";
}

export function parseJoggAiWebhookPayload(
  value: unknown,
): JoggAiWebhookPayload | AvatarVideoErrorResponse {
  if (!isRecord(value) || !isRecord(value.data)) {
    return badRequest("Invalid JoggAI webhook payload");
  }
  const event = optionalString(value.event);
  const status = optionalString(value.data.status)?.toLowerCase();
  const videoId =
    optionalString(value.data.project_id) ??
    optionalString(value.data.video_id);
  if (!videoId) {
    return badRequest("JoggAI webhook did not include a video ID");
  }
  if (event === "generated_avatar_video_failed" || status === "failed") {
    return {
      kind: "failed",
      videoId,
      message: webhookErrorMessage(value.data),
    };
  }
  if (event !== "generated_avatar_video_success" && status !== "completed") {
    return { kind: "pending" };
  }
  const sourceUrl = optionalString(value.data.video_url);
  if (!sourceUrl) {
    return badRequest("JoggAI webhook did not include a video URL");
  }
  const duration = optionalNumber(value.data.duration);
  return {
    kind: "completed",
    videoId,
    sourceUrl,
    coverUrl: optionalString(value.data.cover_url),
    durationSeconds: duration && duration > 0 ? duration : 0,
  };
}

function normalizeVideoContentType(value: string | null): string {
  const contentType = value?.split(";")[0]?.trim().toLowerCase();
  if (
    contentType === "video/mp4" ||
    contentType === "video/webm" ||
    contentType === "video/quicktime"
  ) {
    return contentType;
  }
  return "video/mp4";
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

export async function downloadJoggAiAvatarVideo(
  payload: Extract<JoggAiWebhookPayload, { readonly kind: "completed" }>,
  options: AvatarVideoOptions,
  signal: AbortSignal,
): Promise<ParsedAvatarVideoGeneration | AvatarVideoErrorResponse> {
  const response = await fetch(payload.sourceUrl, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download the generated avatar video",
      "VIDEO_DOWNLOAD_FAILED",
    );
  }
  const videoBytes = Buffer.from(await response.arrayBuffer());
  if (videoBytes.byteLength === 0) {
    return badGateway("JoggAI returned an empty video", "NO_VIDEO_RETURNED");
  }
  return {
    videoBytes,
    contentType: normalizeVideoContentType(
      response.headers.get("content-type"),
    ),
    sourceUrl: payload.sourceUrl,
    coverUrl: payload.coverUrl,
    providerVideoId: payload.videoId,
    durationSeconds: payload.durationSeconds,
    billingQuantity: Math.max(
      1,
      Math.ceil(payload.durationSeconds / JOGGAI_CREDIT_DURATION_SECONDS),
    ),
    options,
  };
}

function estimateCredits(
  billingQuantity: number,
  pricing: AvatarVideoPricingRow,
): number {
  return Math.ceil((billingQuantity * pricing.unitPrice) / pricing.unitSize);
}

export const recordGeneratedAvatarVideo$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly billingRunId: string | null;
      readonly billingContext: string;
      readonly publicBrand: PublicBrand;
      readonly privateArtifacts: boolean;
      readonly pricing: AvatarVideoPricingRow;
      readonly generation: ParsedAvatarVideoGeneration;
      readonly usageIdempotency: BuiltInGenerationUsageIdempotency;
    },
    signal: AbortSignal,
  ): Promise<RecordedAvatarVideo> => {
    const writeDb = set(writeDb$);
    const artifact = await set(
      storeGeneratedArtifactObject$,
      {
        userId: params.userId,
        orgId: params.orgId,
        privateArtifacts: params.privateArtifacts,
        filenamePrefix: "avatar-video",
        extension: extensionForContentType(params.generation.contentType),
        body: params.generation.videoBytes,
        contentType: params.generation.contentType,
        publicBrand: params.publicBrand,
      },
      signal,
    );
    await set(
      recordWebUploadedFile$,
      {
        runId: params.runId,
        externalId: artifact.id,
        userId: params.userId,
        orgId: params.orgId,
        filename: artifact.filename,
        contentType: params.generation.contentType,
        sizeBytes: params.generation.videoBytes.byteLength,
        url: artifact.url,
        s3Key: artifact.key,
        publicBrand: params.publicBrand,
        metadata: compactObject({
          generatedBy: "zero-joggai-avatar-video",
          provider: "joggai",
          model: JOGGAI_AVATAR_VIDEO_MODEL,
          providerVideoId: params.generation.providerVideoId,
          sourceUrl: artifact.isPrivate
            ? undefined
            : params.generation.sourceUrl,
          coverUrl: artifact.isPrivate ? undefined : params.generation.coverUrl,
          durationSeconds: params.generation.durationSeconds,
          avatarId: params.generation.options.avatarId,
          voiceId: params.generation.options.voiceId,
          inputType: params.generation.options.inputType,
          aspectRatio: params.generation.options.aspectRatio,
          screenStyle: params.generation.options.screenStyle,
          caption: params.generation.options.caption,
          videoName: params.generation.options.videoName,
          billingQuantity: params.generation.billingQuantity,
        }),
      },
      signal,
    );
    signal.throwIfAborted();

    await writeDb
      .insert(usageEvent)
      .values({
        runId: params.runId ?? null,
        billingRunId: params.billingRunId,
        billingContext: params.billingContext,
        idempotencyKey: builtInGenerationUsageIdempotencyKey({
          ...params.usageIdempotency,
          category: params.pricing.category,
        }),
        orgId: params.orgId,
        userId: params.userId,
        kind: "video",
        provider: JOGGAI_AVATAR_VIDEO_MODEL,
        category: params.pricing.category,
        quantity: params.generation.billingQuantity,
      })
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    return {
      id: artifact.id,
      filename: artifact.filename,
      contentType: params.generation.contentType,
      size: params.generation.videoBytes.byteLength,
      url: artifact.url,
      privateArtifacts: artifact.isPrivate,
      durationSeconds: params.generation.durationSeconds,
      creditsCharged: estimateCredits(
        params.generation.billingQuantity,
        params.pricing,
      ),
      provider: "joggai",
      model: JOGGAI_AVATAR_VIDEO_MODEL,
      providerVideoId: params.generation.providerVideoId,
      avatarId: params.generation.options.avatarId,
      voiceId: params.generation.options.voiceId,
      inputType: params.generation.options.inputType,
      aspectRatio: params.generation.options.aspectRatio,
      screenStyle: params.generation.options.screenStyle,
      caption: params.generation.options.caption,
      sourceUrl: artifact.isPrivate ? undefined : params.generation.sourceUrl,
    };
  },
);
