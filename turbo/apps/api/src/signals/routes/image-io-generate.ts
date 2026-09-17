import {
  artifactVisibilityUnavailable,
  type badRequestMessage,
} from "../../lib/error";
import { privateArtifactCreationEnabled } from "../services/private-artifact-storage.service";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { imageIoGenerateContract } from "@okouai/api-contracts/contracts/image-io-generate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { BuiltInGenerationRealtimeSubscription } from "@okouai/api-contracts/contracts/built-in-generation";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { settle } from "../utils";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route-entry";
import { env } from "../../lib/env";
import { db$, type ReadonlyDb } from "../external/db";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import {
  checkImageCredits$,
  generateBytePlusImage,
  generateOpenAiImage,
  getMissingImagePricing,
  imagePricing$,
  insufficientCredits,
  parseImageOptions,
  recordGeneratedImage$,
  serviceUnavailable,
  submitFalImageQueueGeneration,
  type ImageOptions,
  type ImagePricing,
  type ImageProviderReferences,
} from "../services/image-generation.service";
import {
  builtInGenerationRequestWithInternal,
  completeBuiltInGenerationJob$,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  mergeBuiltInGenerationJobInternal$,
} from "../services/built-in-generation.service";
import { falBuiltInGenerationWebhookUrl } from "../services/built-in-generation-provider-webhooks.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "../services/run-built-in-admission.service";
import { resolveProviderReferenceUrls$ } from "../services/provider-reference-url.service";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const L = logger("ImageGeneration");
const imageBody$ = bodyResultOf(imageIoGenerateContract.post);

interface GenerationError {
  readonly message: string;
  readonly code: string;
}

interface GenerationErrorResponse {
  readonly status: number;
  readonly body: {
    readonly error: GenerationError;
  };
}

interface ImageJobArgs {
  readonly generationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly publicBrand: PublicBrand;
  readonly privateArtifacts: boolean;
  readonly admission: RunBuiltInAdmission | null;
  readonly options: ImageOptions;
  readonly pricing: ImagePricing;
}

async function loadRunImageModelDefault(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
  runId: string | undefined,
  signal: AbortSignal,
): Promise<ImageModel | null> {
  if (!runId) {
    return null;
  }

  const [run] = await db
    .select({ selectedImageModel: agentRuns.selectedImageModel })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.userId, userId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return null;
  }
  return isImageModelId(run.selectedImageModel) ? run.selectedImageModel : null;
}

function isGenerationError(value: unknown): value is GenerationError {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    "code" in value
  );
}

function isErrorResponse(value: unknown): value is GenerationErrorResponse {
  if (typeof value !== "object" || value === null || !("body" in value)) {
    return false;
  }
  const body = value.body;
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    isGenerationError(body.error)
  );
}

function imageRequestRecord(options: ImageOptions): Record<string, unknown> {
  return {
    model: options.model,
    provider: options.provider,
    prompt: options.prompt,
    size: options.size,
    quality: options.quality,
    background: options.background,
    outputFormat: options.outputFormat,
    ...(options.outputCompression !== undefined
      ? { outputCompression: options.outputCompression }
      : {}),
    moderation: options.moderation,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    safetyTolerance: options.safetyTolerance,
    enhancePrompt: options.enhancePrompt,
    sourceImageUrls: options.sourceImageUrls,
    maskImageUrl: options.maskImageUrl,
    inputFidelity: options.inputFidelity,
    imagePromptStrength: options.imagePromptStrength,
  };
}

function acceptedImageResponse(
  generationId: string,
  realtime: BuiltInGenerationRealtimeSubscription,
) {
  return {
    status: 202 as const,
    body: {
      generationId,
      type: "image" as const,
      status: "queued" as const,
      realtime,
    },
  };
}

const resolveImageProviderReferences$ = command(
  async (
    { set },
    args: Pick<ImageJobArgs, "orgId" | "userId" | "options">,
    signal: AbortSignal,
  ): Promise<
    ImageProviderReferences | ReturnType<typeof badRequestMessage>
  > => {
    const sourceCount = args.options.sourceImageUrls.length;
    const urls = [
      ...args.options.sourceImageUrls,
      ...(args.options.maskImageUrl ? [args.options.maskImageUrl] : []),
    ];
    const resolved = await set(
      resolveProviderReferenceUrls$,
      { orgId: args.orgId, userId: args.userId, urls },
      signal,
    );
    if ("status" in resolved) {
      return resolved;
    }
    return {
      sourceImageUrls: resolved.slice(0, sourceCount),
      maskImageUrl: args.options.maskImageUrl
        ? resolved[sourceCount]
        : undefined,
    };
  },
);

const submitImageProviderWebhookJob$ = command(
  async (
    { set },
    args: ImageJobArgs,
    signal: AbortSignal,
  ): Promise<GenerationErrorResponse | null> => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);

    const falKey = env("FAL_KEY");
    if (!falKey) {
      return serviceUnavailable(
        "Fal image generation is not configured",
        "NOT_CONFIGURED",
      );
    }
    const references = await set(resolveImageProviderReferences$, args, signal);
    if ("status" in references) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: references.body.error },
        signal,
      );
      return references;
    }
    const handle = await submitFalImageQueueGeneration(
      args.options,
      references,
      falKey,
      falBuiltInGenerationWebhookUrl({ generationId: args.generationId }),
      signal,
    );
    signal.throwIfAborted();
    if (isErrorResponse(handle)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: handle.body.error },
        signal,
      );
      return handle;
    }
    await set(
      mergeBuiltInGenerationJobInternal$,
      {
        generationId: args.generationId,
        internal: {
          provider: "fal",
          providerJobId: handle.requestId,
          providerStatusUrl: handle.statusUrl,
          providerResponseUrl: handle.responseUrl,
          providerTask: "image",
        },
      },
      signal,
    );
    return null;
  },
);

const executeDirectImageProviderJob$ = command(
  async ({ set }, args: ImageJobArgs, signal: AbortSignal): Promise<void> => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);
    signal.throwIfAborted();
    const isOpenAi = args.options.provider === "openai";
    const apiKey = env(isOpenAi ? "OPENAI_API_KEY" : "BYTEPLUS_API_KEY");
    if (!apiKey) {
      const unavailable = serviceUnavailable(
        `${isOpenAi ? "OpenAI" : "BytePlus"} image generation is not configured`,
        "NOT_CONFIGURED",
      );
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: unavailable.body.error },
        signal,
      );
      signal.throwIfAborted();
      await set(completeRunBuiltInAdmission$, {
        admission: args.admission,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }

    const references = await set(resolveImageProviderReferences$, args, signal);
    const generation =
      "status" in references
        ? references
        : await (isOpenAi ? generateOpenAiImage : generateBytePlusImage)(
            args.options,
            references,
            apiKey,
            signal,
          );
    signal.throwIfAborted();
    if (isErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: generation.body.error },
        signal,
      );
      signal.throwIfAborted();
      await set(completeRunBuiltInAdmission$, {
        admission: args.admission,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }

    const result = await set(
      recordGeneratedImage$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        billingRunId: args.runId ?? null,
        billingContext: args.runId ? "run" : "runless",
        publicBrand: args.publicBrand,
        privateArtifacts: args.privateArtifacts,
        pricing: args.pricing,
        generation,
        usageIdempotency: {
          generationId: args.generationId,
          scope: "image",
        },
      },
      signal,
    );
    signal.throwIfAborted();
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.generationId, result },
      signal,
    );
    signal.throwIfAborted();
    await set(completeRunBuiltInAdmission$, {
      admission: args.admission,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

const runDirectImageProviderJob$ = command(
  async ({ set }, args: ImageJobArgs, signal: AbortSignal): Promise<void> => {
    const execution = await settle(
      set(executeDirectImageProviderJob$, args, signal),
      signal,
    );
    signal.throwIfAborted();
    if (execution.ok) {
      return;
    }

    L.error("Image generation failed", {
      generationId: args.generationId,
      model: args.options.model,
      provider: args.options.provider,
      error:
        execution.error instanceof Error
          ? execution.error.message
          : String(execution.error),
    });
    await set(
      failBuiltInGenerationJob$,
      {
        generationId: args.generationId,
        error: {
          message: "Image generation failed",
          code:
            args.options.provider === "openai"
              ? "OPENAI_IMAGE_REQUEST_FAILED"
              : "BYTEPLUS_IMAGE_REQUEST_FAILED",
        },
      },
      signal,
    );
    signal.throwIfAborted();
    await set(completeRunBuiltInAdmission$, {
      admission: args.admission,
      status: "failed",
    });
    signal.throwIfAborted();
  },
);

const startImageProviderJob$ = command(
  async (
    { set },
    args: ImageJobArgs,
    signal: AbortSignal,
  ): Promise<GenerationErrorResponse | null> => {
    if (args.options.provider !== "fal") {
      waitUntil(
        set(runDirectImageProviderJob$, args, new AbortController().signal),
      );
      return null;
    }
    return await set(submitImageProviderWebhookJob$, args, signal);
  },
);

const prepareImageRequest$ = command(
  async ({ get }, requirePrivateArtifact: boolean, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const db = get(db$);
    const bodyResult = await get(imageBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const privacyRequired =
      requirePrivateArtifact || bodyResult.data.requirePrivateArtifact === true;
    const requiredPrivateArtifacts = privacyRequired
      ? await get(privateArtifactCreationEnabled(auth.orgId, auth.userId))
      : undefined;
    signal.throwIfAborted();
    if (privacyRequired && !requiredPrivateArtifacts) {
      return artifactVisibilityUnavailable();
    }

    const runId =
      auth.tokenType === "agent" || auth.tokenType === "sandbox"
        ? auth.runId
        : undefined;
    const runImageModelDefault = await loadRunImageModelDefault(
      db,
      auth.orgId,
      auth.userId,
      runId,
      signal,
    );
    const options = parseImageOptions(bodyResult.data, {
      defaultModel: runImageModelDefault ?? DEFAULT_IMAGE_MODEL,
    });
    if ("status" in options) {
      return options;
    }

    return { auth, runId, requiredPrivateArtifacts, options };
  },
);

const postImageInner$ = command(
  async (
    { get, set },
    requirePrivateArtifact: boolean,
    signal: AbortSignal,
  ) => {
    const prepared = await set(
      prepareImageRequest$,
      requirePrivateArtifact,
      signal,
    );
    if ("status" in prepared) {
      return prepared;
    }
    const { auth, runId, requiredPrivateArtifacts, options } = prepared;
    const publicBrand = PUBLIC_BRAND;

    const hasCredits = await set(
      checkImageCredits$,
      { orgId: auth.orgId, userId: auth.userId, runId },
      signal,
    );
    if (!hasCredits) {
      return insufficientCredits();
    }

    const pricing = await get(imagePricing$);
    signal.throwIfAborted();
    const missingPricing = getMissingImagePricing(pricing, options.model);
    if (missingPricing.length > 0) {
      L.error("Image generation pricing is not configured", {
        model: options.model,
        missingPricing,
      });
      return serviceUnavailable(
        "Image generation pricing is not configured",
        "NOT_CONFIGURED",
      );
    }

    if (options.provider === "fal" && !env("FAL_KEY")) {
      return serviceUnavailable(
        "Fal image generation is not configured",
        "NOT_CONFIGURED",
      );
    }
    if (options.provider === "byteplus" && !env("BYTEPLUS_API_KEY")) {
      return serviceUnavailable(
        "BytePlus image generation is not configured",
        "NOT_CONFIGURED",
      );
    }
    if (options.provider === "openai" && !env("OPENAI_API_KEY")) {
      return serviceUnavailable(
        "OpenAI image generation is not configured",
        "NOT_CONFIGURED",
      );
    }

    const generationId = randomUUID();
    const realtime = await createBuiltInGenerationRealtimeSubscription(
      auth.userId,
      generationId,
    );
    signal.throwIfAborted();
    const admission = await set(
      startRunBuiltInAdmission$,
      { runId, kind: "image" },
      signal,
    );
    if (isRunBuiltInAdmissionError(admission)) {
      return admission;
    }

    const { privateArtifacts } = await set(
      createBuiltInGenerationJob$,
      {
        generationId,
        type: "image",
        orgId: auth.orgId,
        privateArtifacts: requiredPrivateArtifacts,
        userId: auth.userId,
        runId,
        request: builtInGenerationRequestWithInternal(
          imageRequestRecord(options),
          {
            admissionId: admission?.id,
            publicBrand,
            provider: options.provider,
            providerTask: "image",
          },
        ),
      },
      signal,
    );

    const submitError = await set(
      startImageProviderJob$,
      {
        generationId,
        orgId: auth.orgId,
        userId: auth.userId,
        runId,
        publicBrand,
        privateArtifacts,
        admission,
        options,
        pricing,
      },
      signal,
    );
    signal.throwIfAborted();
    if (submitError) {
      await set(completeRunBuiltInAdmission$, {
        admission,
        status: "failed",
      });
      signal.throwIfAborted();
      return submitError;
    }

    return acceptedImageResponse(generationId, realtime);
  },
);

export const imageIoGenerateRoutes: readonly RouteEntry[] = [
  {
    route: imageIoGenerateContract.postPrivate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      command(({ set }, signal: AbortSignal) => {
        return set(postImageInner$, true, signal);
      }),
    ),
  },
  {
    route: imageIoGenerateContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      command(({ set }, signal: AbortSignal) => {
        return set(postImageInner$, false, signal);
      }),
    ),
  },
];
