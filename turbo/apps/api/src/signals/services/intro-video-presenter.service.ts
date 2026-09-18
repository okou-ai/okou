import { Buffer } from "node:buffer";

import { command, computed, type Computed } from "ccstate";
import {
  introVideoPresenterGenerateRequestSchema,
  type IntroVideoPresenterGenerateResponse,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { isHeyGenIntroVideoAvatarId } from "@okouai/core/intro-video-avatars";
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
import {
  builtInGenerationUsageIdempotencyKey,
  type BuiltInGenerationUsageIdempotency,
} from "./built-in-generation-usage-idempotency";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";

const HEYGEN_INTRO_VIDEO_PRESENTER_MODEL = "heygen-avatar-iii";
const HEYGEN_INTRO_VIDEO_PRESENTER_PRICING_CATEGORY = "output_video_seconds";

type ErrorStatus = 400 | 402 | 502 | 503;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

interface IntroVideoPresenterErrorResponse {
  readonly status: ErrorStatus;
  readonly body: ErrorBody;
}

export interface IntroVideoPresenterOptions {
  readonly avatarId: string;
  readonly avatarGroupId: string | undefined;
  readonly audioUrl: string;
  readonly aspectRatio: "landscape";
  readonly videoName: string | undefined;
}

interface IntroVideoPresenterPricingRow {
  readonly provider: typeof HEYGEN_INTRO_VIDEO_PRESENTER_MODEL;
  readonly category: typeof HEYGEN_INTRO_VIDEO_PRESENTER_PRICING_CATEGORY;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface ParsedIntroVideoPresenterGeneration {
  readonly videoBytes: Buffer;
  readonly contentType: "video/webm";
  readonly sourceUrl: string;
  readonly providerVideoId: string;
  readonly durationSeconds: number;
  readonly billingQuantity: number;
  readonly options: IntroVideoPresenterOptions;
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string): IntroVideoPresenterErrorResponse {
  return { status: 400, body: errorBody(message, "BAD_REQUEST") };
}

export function introVideoPresenterAvatarUnavailable(): IntroVideoPresenterErrorResponse {
  return badRequest("HeyGen avatar is not available in Intro Video");
}

export function introVideoPresenterServiceUnavailable(
  message: string,
): IntroVideoPresenterErrorResponse {
  return { status: 503, body: errorBody(message, "NOT_CONFIGURED") };
}

export function introVideoPresenterInsufficientCredits(): IntroVideoPresenterErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

export function introVideoPresenterRequiresPaidPlan(): IntroVideoPresenterErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Intro Video presenter generation requires Pro, Team, or Custom workspace access.",
      "PRO_REQUIRED",
    ),
  };
}

export function isIntroVideoPresenterErrorResponse(
  value: unknown,
): value is IntroVideoPresenterErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
}

export function parseIntroVideoPresenterOptions(
  request: unknown,
): IntroVideoPresenterOptions | IntroVideoPresenterErrorResponse {
  const parsed = introVideoPresenterGenerateRequestSchema.safeParse(request);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid request");
  }
  if (
    !parsed.data.avatarGroupId &&
    !isHeyGenIntroVideoAvatarId(parsed.data.avatarId)
  ) {
    return introVideoPresenterAvatarUnavailable();
  }
  return {
    avatarId: parsed.data.avatarId,
    avatarGroupId: parsed.data.avatarGroupId,
    audioUrl: parsed.data.audioUrl,
    aspectRatio: "landscape",
    videoName: parsed.data.videoName,
  };
}

export const introVideoPresenterPricing$: Computed<
  Promise<IntroVideoPresenterPricingRow | null>
> = computed(async (get): Promise<IntroVideoPresenterPricingRow | null> => {
  const db = get(db$);
  const provider = resolveUsagePricingProvider(
    get(usagePricingResolution$),
    "video",
    HEYGEN_INTRO_VIDEO_PRESENTER_MODEL,
  );
  const [row] = await db
    .select({
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, provider),
        eq(
          usagePricing.category,
          HEYGEN_INTRO_VIDEO_PRESENTER_PRICING_CATEGORY,
        ),
      ),
    )
    .limit(1);

  return row
    ? {
        provider: HEYGEN_INTRO_VIDEO_PRESENTER_MODEL,
        category: HEYGEN_INTRO_VIDEO_PRESENTER_PRICING_CATEGORY,
        ...row,
      }
    : null;
});

export const checkIntroVideoPresenterCredits$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(checkBillableOperationCredits$, args, signal);
  },
);

export function parsedIntroVideoPresenterGeneration(args: {
  readonly videoBytes: Buffer;
  readonly contentType: "video/webm";
  readonly sourceUrl: string;
  readonly providerVideoId: string;
  readonly durationSeconds: number;
  readonly options: IntroVideoPresenterOptions;
}): ParsedIntroVideoPresenterGeneration {
  return {
    ...args,
    billingQuantity: Math.max(1, Math.ceil(args.durationSeconds)),
  };
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

function estimateCredits(
  billingQuantity: number,
  pricing: IntroVideoPresenterPricingRow,
): number {
  return Math.ceil((billingQuantity * pricing.unitPrice) / pricing.unitSize);
}

export const recordGeneratedIntroVideoPresenter$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string;
      readonly publicBrand: PublicBrand;
      readonly privateArtifacts: boolean;
      readonly pricing: IntroVideoPresenterPricingRow;
      readonly generation: ParsedIntroVideoPresenterGeneration;
      readonly usageIdempotency: BuiltInGenerationUsageIdempotency;
    },
    signal: AbortSignal,
  ): Promise<IntroVideoPresenterGenerateResponse> => {
    const writeDb = set(writeDb$);
    const artifact = await set(
      storeGeneratedArtifactObject$,
      {
        userId: params.userId,
        orgId: params.orgId,
        privateArtifacts: params.privateArtifacts,
        filenamePrefix: "intro-video-presenter",
        extension: "webm",
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
          generatedBy: "zero-internal-intro-video-presenter",
          provider: "heygen",
          model: HEYGEN_INTRO_VIDEO_PRESENTER_MODEL,
          providerVideoId: params.generation.providerVideoId,
          sourceUrl: artifact.isPrivate
            ? undefined
            : params.generation.sourceUrl,
          durationSeconds: params.generation.durationSeconds,
          avatarId: params.generation.options.avatarId,
          avatarGroupId: params.generation.options.avatarGroupId,
          inputType: "audio",
          aspectRatio: params.generation.options.aspectRatio,
          outputFormat: "webm",
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
        runId: params.runId,
        idempotencyKey: builtInGenerationUsageIdempotencyKey({
          ...params.usageIdempotency,
          category: params.pricing.category,
        }),
        orgId: params.orgId,
        userId: params.userId,
        kind: "video",
        provider: HEYGEN_INTRO_VIDEO_PRESENTER_MODEL,
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
      contentType: "video/webm",
      size: params.generation.videoBytes.byteLength,
      url: artifact.url,
      privateArtifacts: artifact.isPrivate,
      durationSeconds: params.generation.durationSeconds,
      creditsCharged: estimateCredits(
        params.generation.billingQuantity,
        params.pricing,
      ),
      avatarId: params.generation.options.avatarId,
    };
  },
);
