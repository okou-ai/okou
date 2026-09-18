import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import {
  introVideoVoiceGenerateRequestSchema,
  type IntroVideoVoiceGenerateResponse,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, eq } from "drizzle-orm";

import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
} from "../context/usage-pricing-resolution";
import { db$, writeDb$ } from "../external/db";
import { checkBillableOperationCredits$ } from "./billable-operation-admission.service";
import { storeGeneratedArtifactObject$ } from "./artifact-storage.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import type { HeyGenGeneratedSpeech } from "./heygen.service";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";

const HEYGEN_INTRO_VIDEO_VOICE_MODEL = "heygen-starfish-tts";
const HEYGEN_INTRO_VIDEO_VOICE_PRICING_CATEGORY = "output_audio_seconds";

type ErrorStatus = 400 | 402 | 502 | 503;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

interface IntroVideoVoiceErrorResponse {
  readonly status: ErrorStatus;
  readonly body: ErrorBody;
}

interface IntroVideoVoiceOptions {
  readonly voiceId: string;
  readonly text: string;
}

interface IntroVideoVoicePricingRow {
  readonly provider: typeof HEYGEN_INTRO_VIDEO_VOICE_MODEL;
  readonly category: typeof HEYGEN_INTRO_VIDEO_VOICE_PRICING_CATEGORY;
  readonly unitPrice: number;
  readonly unitSize: number;
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string): IntroVideoVoiceErrorResponse {
  return { status: 400, body: errorBody(message, "BAD_REQUEST") };
}

export function introVideoVoiceUnavailable(): IntroVideoVoiceErrorResponse {
  return badRequest("HeyGen voice is not available in Intro Video");
}

export function introVideoVoiceServiceUnavailable(
  message: string,
): IntroVideoVoiceErrorResponse {
  return { status: 503, body: errorBody(message, "NOT_CONFIGURED") };
}

export function introVideoVoiceInsufficientCredits(): IntroVideoVoiceErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

export function introVideoVoiceRequiresPaidPlan(): IntroVideoVoiceErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Intro Video narration requires Pro, Team, or Custom workspace access.",
      "PRO_REQUIRED",
    ),
  };
}

export function isIntroVideoVoiceErrorResponse(
  value: unknown,
): value is IntroVideoVoiceErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
}

export function parseIntroVideoVoiceOptions(
  request: unknown,
): IntroVideoVoiceOptions | IntroVideoVoiceErrorResponse {
  const parsed = introVideoVoiceGenerateRequestSchema.safeParse(request);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid request");
  }
  return parsed.data;
}

export const introVideoVoicePricing$: Computed<
  Promise<IntroVideoVoicePricingRow | null>
> = computed(async (get): Promise<IntroVideoVoicePricingRow | null> => {
  const db = get(db$);
  const provider = resolveUsagePricingProvider(
    get(usagePricingResolution$),
    "audio",
    HEYGEN_INTRO_VIDEO_VOICE_MODEL,
  );
  const [row] = await db
    .select({
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "audio"),
        eq(usagePricing.provider, provider),
        eq(usagePricing.category, HEYGEN_INTRO_VIDEO_VOICE_PRICING_CATEGORY),
      ),
    )
    .limit(1);

  return row
    ? {
        provider: HEYGEN_INTRO_VIDEO_VOICE_MODEL,
        category: HEYGEN_INTRO_VIDEO_VOICE_PRICING_CATEGORY,
        ...row,
      }
    : null;
});

export const checkIntroVideoVoiceCredits$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(checkBillableOperationCredits$, args, signal);
  },
);

function estimateCredits(
  billingQuantity: number,
  pricing: IntroVideoVoicePricingRow,
): number {
  return Math.ceil((billingQuantity * pricing.unitPrice) / pricing.unitSize);
}

export const recordGeneratedIntroVideoVoice$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string;
      readonly publicBrand: PublicBrand;
      readonly privateArtifacts: boolean;
      readonly pricing: IntroVideoVoicePricingRow;
      readonly options: IntroVideoVoiceOptions;
      readonly speech: HeyGenGeneratedSpeech;
    },
    signal: AbortSignal,
  ): Promise<IntroVideoVoiceGenerateResponse> => {
    const writeDb = set(writeDb$);
    const extension = params.speech.contentType === "audio/wav" ? "wav" : "mp3";
    const artifact = await set(
      storeGeneratedArtifactObject$,
      {
        userId: params.userId,
        orgId: params.orgId,
        privateArtifacts: params.privateArtifacts,
        filenamePrefix: "intro-video-voice",
        extension,
        body: Buffer.from(params.speech.audioBytes),
        contentType: params.speech.contentType,
        publicBrand: params.publicBrand,
      },
      signal,
    );
    const billingQuantity = Math.max(
      1,
      Math.ceil(params.speech.durationSeconds),
    );
    await set(
      recordWebUploadedFile$,
      {
        runId: params.runId,
        externalId: artifact.id,
        userId: params.userId,
        orgId: params.orgId,
        filename: artifact.filename,
        contentType: params.speech.contentType,
        sizeBytes: params.speech.audioBytes.byteLength,
        url: artifact.url,
        s3Key: artifact.key,
        publicBrand: params.publicBrand,
        metadata: {
          generatedBy: "zero-internal-intro-video-voice",
          provider: "heygen",
          model: HEYGEN_INTRO_VIDEO_VOICE_MODEL,
          voiceId: params.options.voiceId,
          sourceUrl: artifact.isPrivate ? undefined : params.speech.sourceUrl,
          durationSeconds: params.speech.durationSeconds,
          billingQuantity,
          ...(params.speech.providerRequestId
            ? { providerRequestId: params.speech.providerRequestId }
            : {}),
        },
      },
      signal,
    );
    signal.throwIfAborted();

    await writeDb
      .insert(usageEvent)
      .values({
        runId: params.runId,
        idempotencyKey: randomUUID(),
        orgId: params.orgId,
        userId: params.userId,
        kind: "audio",
        provider: HEYGEN_INTRO_VIDEO_VOICE_MODEL,
        category: HEYGEN_INTRO_VIDEO_VOICE_PRICING_CATEGORY,
        quantity: billingQuantity,
      })
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    return {
      id: artifact.id,
      filename: artifact.filename,
      contentType: params.speech.contentType,
      size: params.speech.audioBytes.byteLength,
      url: artifact.url,
      privateArtifacts: artifact.isPrivate,
      durationSeconds: params.speech.durationSeconds,
      creditsCharged: estimateCredits(billingQuantity, params.pricing),
      voiceId: params.options.voiceId,
    };
  },
);
