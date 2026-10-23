import { resourceUnavailable, type badRequestMessage } from "../../lib/error";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { imageIoGenerateContract } from "@okouai/api-contracts/contracts/image-io-generate";
import type { BuiltInGenerationRealtimeSubscription } from "@okouai/api-contracts/contracts/built-in-generation";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { DEFAULT_IMAGE_MODEL } from "@okouai/core/image-model-catalog";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route-entry";
import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import {
  checkImageCredits$,
  getMissingImagePricing,
  imagePricing$,
  insufficientCredits,
  parseImageOptions,
  serviceUnavailable,
  submitFalImageQueueGeneration,
  type ImageOptions,
  type ImageProviderReferences,
} from "../services/image-generation.service";
import {
  builtInGenerationRequestWithInternal,
  createImageGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  mergeBuiltInGenerationJobInternal$,
} from "../services/built-in-generation.service";
import { falBuiltInGenerationWebhookUrl } from "../services/built-in-generation-provider-webhooks.service";
import {
  openAiImageOrchestrationPricing$,
  submitOpenAiImageJob$,
} from "../services/openai-image-generation.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
} from "../services/run-built-in-admission.service";
import { userModelPreference } from "../services/user-data.service";
import { resolveProviderReferenceUrls$ } from "../services/provider-reference-url.service";

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
  readonly options: ImageOptions;
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
  clientReconciliation: boolean,
) {
  return {
    status: 202 as const,
    body: {
      generationId,
      type: "image" as const,
      status: "queued" as const,
      realtime,
      ...(clientReconciliation ? { clientReconciliation: true as const } : {}),
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

const startImageProviderJob$ = command(
  async (
    { set },
    args: ImageJobArgs,
    signal: AbortSignal,
  ): Promise<GenerationErrorResponse | null> => {
    if (args.options.provider === "openai") {
      return await set(submitOpenAiImageJob$, args.generationId, signal);
    }
    return await set(submitImageProviderWebhookJob$, args, signal);
  },
);

const prepareImageRequest$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  const bodyResult = await get(imageBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const runId =
    auth.tokenType === "agent" || auth.tokenType === "sandbox"
      ? auth.runId
      : undefined;
  const orgId = auth.orgId;
  const userId = auth.userId;
  const runImageModel = await (async (querySignal: AbortSignal) => {
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
    querySignal.throwIfAborted();
    if (!run) {
      return null;
    }
    return isImageModelId(run.selectedImageModel)
      ? run.selectedImageModel
      : null;
  })(signal);
  const memberImageModel =
    runImageModel === null
      ? (
          await get(
            userModelPreference({ orgId: auth.orgId, userId: auth.userId }),
          )
        ).selectedImageModel
      : null;
  signal.throwIfAborted();
  const model = runImageModel ?? memberImageModel ?? DEFAULT_IMAGE_MODEL;
  const options = parseImageOptions(bodyResult.data, { model });
  if ("status" in options) {
    return options;
  }

  return { auth, runId, options };
});

const postImageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const prepared = await set(prepareImageRequest$, signal);
  if ("status" in prepared) {
    return prepared;
  }
  const { auth, runId, options } = prepared;

  const hasCredits = await set(
    checkImageCredits$,
    { orgId: auth.orgId, userId: auth.userId, runId },
    signal,
  );
  if (hasCredits === "closed") {
    return resourceUnavailable("Official Workflow run is no longer active");
  }
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
  if (options.provider === "openai" && !env("OPENAI_API_KEY")) {
    return serviceUnavailable(
      "OpenAI image generation is not configured",
      "NOT_CONFIGURED",
    );
  }

  if (options.provider === "openai") {
    await get(openAiImageOrchestrationPricing$);
    signal.throwIfAborted();
  }

  const generationId = randomUUID();
  const realtime = await createBuiltInGenerationRealtimeSubscription(
    auth.userId,
    generationId,
  );
  signal.throwIfAborted();
  const admission = await set(startRunBuiltInAdmission$, { runId }, signal);
  if (isRunBuiltInAdmissionError(admission)) {
    return admission;
  }

  await set(
    createImageGenerationJob$,
    {
      generationId,
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      request: builtInGenerationRequestWithInternal(
        imageRequestRecord(options),
        {
          admissionId: admission?.id,
          provider: options.provider,
          providerTask:
            options.provider === "openai" ? "image-response" : "image",
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
      options,
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

  return acceptedImageResponse(
    generationId,
    realtime,
    options.provider === "openai",
  );
});

export const imageIoGenerateRoutes: readonly RouteEntry[] = [
  {
    route: imageIoGenerateContract.postPrivate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      postImageInner$,
    ),
  },
  {
    route: imageIoGenerateContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postImageInner$,
    ),
  },
];
