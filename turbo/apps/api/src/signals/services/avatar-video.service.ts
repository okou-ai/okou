import { Buffer } from "node:buffer";

import { command, computed, type Computed } from "ccstate";
import {
  AVATAR_VIDEO_TRANSPARENT_SCREEN_STYLE,
  avatarVideoGenerateRequestSchema,
} from "@okouai/api-contracts/contracts/avatar-video";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, eq } from "drizzle-orm";

import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
} from "../context/usage-pricing-resolution";
import { db$, writeDb$ } from "../external/db";
import { storeGeneratedArtifactObject$ } from "./artifact-storage.service";
import {
  builtInGenerationUsageIdempotencyKey,
  type BuiltInGenerationUsageIdempotency,
} from "./built-in-generation-usage-idempotency";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";

const JOGGAI_AVATAR_VIDEO_MODEL = "joggai-talking-avatar";
const JOGGAI_AVATAR_VIDEO_PRICING_CATEGORY = "output_video_joggai_credits";
const JOGGAI_CREDIT_DURATION_SECONDS = 120;

type ErrorStatus = 400 | 502;

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
