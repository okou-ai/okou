import { privateArtifactCreationEnabled } from "../services/private-artifact-storage.service";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  videoIoGenerateContract,
  type VideoIoGenerateRequest,
} from "@okouai/api-contracts/contracts/video-io-generate";
import type { BuiltInGenerationRealtimeSubscription } from "@okouai/api-contracts/contracts/built-in-generation";
import { VIDEO_MODEL_CONFIGS } from "@okouai/core/video-model-catalog";
import {
  isVideoModelId,
  type VideoModelId,
} from "@okouai/api-contracts/contracts/video-models";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { env } from "../../lib/env";
import {
  artifactVisibilityUnavailable,
  badRequestMessage,
} from "../../lib/error";
import { db$, type ReadonlyDb } from "../external/db";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import {
  bytePlusBuiltInGenerationWebhookUrl,
  falBuiltInGenerationWebhookUrl,
  miniMaxBuiltInGenerationWebhookUrl,
} from "../services/built-in-generation-provider-webhooks.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import {
  checkVideoCredits$,
  getMissingVideoPricing,
  namesVideoModel,
  parseVideoOptions,
  submitBytePlusVideoGeneration,
  submitFalVideoGeneration,
  submitMiniMaxVideoGeneration,
  type VideoOptions,
  videoProviderForModel,
  videoInsufficientCredits,
  videoPricing$,
  videoRequiresPaidPlan,
  videoServiceUnavailable,
} from "../services/video-generation.service";
import {
  builtInGenerationRequestWithInternal,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  mergeBuiltInGenerationJobInternal$,
} from "../services/built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
} from "../services/run-built-in-admission.service";
import { resolveProviderReferenceUrls$ } from "../services/provider-reference-url.service";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const videoBody$ = bodyResultOf(videoIoGenerateContract.post);

async function loadRunVideoModel(
  db: ReadonlyDb,
  runId: string,
): Promise<VideoModelId | null> {
  const [run] = await db
    .select({ selectedVideoModel: agentRuns.selectedVideoModel })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  if (!run) {
    throw new Error("Expected an agent run row for the default video model");
  }
  if (run.selectedVideoModel === null) {
    return null;
  }
  if (!isVideoModelId(run.selectedVideoModel)) {
    throw new Error("Run has an unsupported video model snapshot");
  }
  return run.selectedVideoModel;
}

async function loadDefaultRunVideoModel(
  db: ReadonlyDb,
  runId: string | undefined,
  signal: AbortSignal,
): Promise<VideoModelId | null> {
  if (!runId) {
    return null;
  }
  const runVideoModel = await loadRunVideoModel(db, runId);
  signal.throwIfAborted();
  return runVideoModel;
}

/**
 * Fill in the run's pinned model and drop any caller parameter the pin cannot
 * honour.
 *
 * Only reached when the request names no model. The caller still picks aspect
 * ratio, duration, and resolution, and it sized them for whichever model it
 * assumed it would get, so those values can be valid for that assumption and
 * invalid for the pin — a caller sizing for `dreamina-seedance-2.0-fast` at
 * 720p against a `MiniMax-H3` pin used to get
 * `Unsupported video resolution for minimax-h3: 720p`, an error about a model
 * it never named. Dropping the field lets the pinned model's own default apply
 * instead of failing a request the caller could not have written correctly.
 *
 * A request that does name a model keeps its parameters untouched: that caller
 * chose both, so the normal validation error is the right answer.
 *
 * The effective values come back on the response, so the caller can report what
 * was actually used.
 */
function withDefaultRunVideoModel(
  body: VideoIoGenerateRequest,
  runVideoModel: VideoModelId,
): VideoIoGenerateRequest {
  const config = VIDEO_MODEL_CONFIGS[runVideoModel];
  const honours = <T>(
    supported: readonly T[],
    value: string | undefined,
  ): boolean => {
    return (
      value !== undefined &&
      supported.some((entry) => {
        return entry === (value as T);
      })
    );
  };
  return {
    ...body,
    model: runVideoModel,
    ...(honours(config.aspectRatios, body.aspectRatio)
      ? {}
      : { aspectRatio: undefined }),
    ...(honours(config.durations, body.duration)
      ? {}
      : { duration: undefined }),
    ...(honours(config.resolutions, body.resolution)
      ? {}
      : { resolution: undefined }),
  };
}

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

interface VideoJobArgs {
  readonly generationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly options: VideoOptions;
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

function videoRequestRecord(options: VideoOptions): Record<string, unknown> {
  return {
    model: options.model,
    prompt: options.prompt,
    aspectRatio: options.aspectRatio,
    duration: options.duration,
    resolution: options.resolution,
    generateAudio: options.generateAudio,
    ...(options.negativePrompt
      ? { negativePrompt: options.negativePrompt }
      : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    autoFix: options.autoFix,
    safetyTolerance: options.safetyTolerance,
    ...(options.referenceImageUrls.length > 0
      ? { referenceImageUrls: options.referenceImageUrls }
      : {}),
    ...(options.inputVideoUrls.length > 0
      ? { inputVideoUrls: options.inputVideoUrls }
      : {}),
    ...(options.referenceAudioUrls.length > 0
      ? { referenceAudioUrls: options.referenceAudioUrls }
      : {}),
    ...(options.firstFrameImageUrl
      ? { firstFrameImageUrl: options.firstFrameImageUrl }
      : {}),
    ...(options.lastFrameImageUrl
      ? { lastFrameImageUrl: options.lastFrameImageUrl }
      : {}),
  };
}

function acceptedVideoResponse(
  generationId: string,
  realtime: BuiltInGenerationRealtimeSubscription,
) {
  return {
    status: 202 as const,
    body: {
      generationId,
      type: "video" as const,
      status: "queued" as const,
      realtime,
    },
  };
}

const resolveVideoProviderOptions$ = command(
  async (
    { set },
    args: Pick<VideoJobArgs, "orgId" | "userId" | "options">,
    signal: AbortSignal,
  ): Promise<VideoOptions | ReturnType<typeof badRequestMessage>> => {
    const { options } = args;
    const urls = [
      ...(options.firstFrameImageUrl ? [options.firstFrameImageUrl] : []),
      ...(options.lastFrameImageUrl ? [options.lastFrameImageUrl] : []),
      ...options.referenceImageUrls,
      ...options.inputVideoUrls,
      ...options.referenceAudioUrls,
    ];
    const resolved = await set(
      resolveProviderReferenceUrls$,
      { orgId: args.orgId, userId: args.userId, urls },
      signal,
    );
    if ("status" in resolved) {
      return resolved;
    }
    let index = 0;
    const next = (): string => {
      const value = resolved[index];
      index += 1;
      if (!value) {
        throw new Error("Expected a resolved provider reference URL");
      }
      return value;
    };
    return {
      ...options,
      firstFrameImageUrl: options.firstFrameImageUrl ? next() : undefined,
      lastFrameImageUrl: options.lastFrameImageUrl ? next() : undefined,
      referenceImageUrls: options.referenceImageUrls.map(next),
      inputVideoUrls: options.inputVideoUrls.map(next),
      referenceAudioUrls: options.referenceAudioUrls.map(next),
    };
  },
);

const submitMiniMaxVideoProviderJob$ = command(
  async (
    { set },
    args: VideoJobArgs,
    signal: AbortSignal,
  ): Promise<GenerationErrorResponse | null> => {
    const apiKey = env("MINIMAX_API_KEY");
    if (!apiKey) {
      const response = videoServiceUnavailable(
        "MiniMax H3 video generation is not configured",
        "NOT_CONFIGURED",
      );
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: response.body.error },
        signal,
      );
      return response;
    }
    const handle = await submitMiniMaxVideoGeneration(
      args.options,
      apiKey,
      signal,
      miniMaxBuiltInGenerationWebhookUrl({
        generationId: args.generationId,
      }),
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
          provider: "minimax",
          providerJobId: handle.taskId,
          providerTask: "video",
        },
      },
      signal,
    );
    return null;
  },
);

const submitVideoProviderWebhookJob$ = command(
  async (
    { set },
    args: VideoJobArgs,
    signal: AbortSignal,
  ): Promise<GenerationErrorResponse | null> => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);
    const provider = videoProviderForModel(args.options.model);
    const providerOptions = await set(
      resolveVideoProviderOptions$,
      args,
      signal,
    );
    if ("status" in providerOptions) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: providerOptions.body.error },
        signal,
      );
      return providerOptions;
    }
    if (provider === "fal") {
      const apiKey = env("FAL_KEY");
      if (!apiKey) {
        const response = videoServiceUnavailable(
          "Fal video generation is not configured",
          "NOT_CONFIGURED",
        );
        await set(
          failBuiltInGenerationJob$,
          { generationId: args.generationId, error: response.body.error },
          signal,
        );
        return response;
      }
      const handle = await submitFalVideoGeneration(
        providerOptions,
        apiKey,
        signal,
        falBuiltInGenerationWebhookUrl({
          generationId: args.generationId,
        }),
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
            providerTask: "video",
          },
        },
        signal,
      );
      return null;
    }

    if (provider === "minimax") {
      return await set(
        submitMiniMaxVideoProviderJob$,
        { ...args, options: providerOptions },
        signal,
      );
    }

    const apiKey = env("BYTEPLUS_API_KEY");
    if (!apiKey) {
      const response = videoServiceUnavailable(
        "BytePlus video generation is not configured",
        "NOT_CONFIGURED",
      );
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: response.body.error },
        signal,
      );
      return response;
    }
    const handle = await submitBytePlusVideoGeneration(
      providerOptions,
      apiKey,
      signal,
      bytePlusBuiltInGenerationWebhookUrl({
        generationId: args.generationId,
      }),
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
          provider: "byteplus",
          providerJobId: handle.taskId,
          providerTask: "video",
        },
      },
      signal,
    );
    return null;
  },
);

function parseVideoSubmissionOptions(body: VideoIoGenerateRequest) {
  const options = parseVideoOptions(body);
  if ("status" in options) {
    return options;
  }
  if (
    videoProviderForModel(options.model) === "byteplus" &&
    (options.firstFrameImageUrl || options.lastFrameImageUrl) &&
    (options.referenceImageUrls.length > 0 ||
      options.inputVideoUrls.length > 0 ||
      options.referenceAudioUrls.length > 0)
  ) {
    return badRequestMessage(
      "BytePlus frame images and reference media cannot be combined. Choose either first/last frames or reference images, videos, and audio.",
    );
  }
  return options;
}

const prepareVideoRequest$ = command(
  async ({ get }, requirePrivateArtifact: boolean, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    // Existing callers receive the plan error before body validation. The
    // guarded route reports unavailable private creation before the plan gate.
    if (
      !requirePrivateArtifact &&
      capabilities?.videoGenerationAllowed !== true
    ) {
      return videoRequiresPaidPlan();
    }
    const bodyResult = await get(videoBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const privacyRequired =
      requirePrivateArtifact || bodyResult.data.requirePrivateArtifact === true;
    const privateArtifacts = privacyRequired
      ? await get(privateArtifactCreationEnabled(auth.orgId, auth.userId))
      : undefined;
    signal.throwIfAborted();
    if (privacyRequired && !privateArtifacts) {
      return artifactVisibilityUnavailable();
    }

    if (
      requirePrivateArtifact &&
      capabilities?.videoGenerationAllowed !== true
    ) {
      return videoRequiresPaidPlan();
    }

    const runId =
      auth.tokenType === "agent" || auth.tokenType === "sandbox"
        ? auth.runId
        : undefined;
    const runVideoModel = await loadDefaultRunVideoModel(db, runId, signal);
    // The run's model is a default, not an override: it applies only when the
    // request names no model of its own. A caller that asks for a specific model
    // — because the user asked for it in the prompt — gets that model.
    const options = parseVideoSubmissionOptions(
      runVideoModel === null || namesVideoModel(bodyResult.data)
        ? bodyResult.data
        : withDefaultRunVideoModel(bodyResult.data, runVideoModel),
    );
    if ("status" in options) {
      return options;
    }

    return { auth, runId, privateArtifacts, options };
  },
);

const postVideoInner$ = command(
  async (
    { get, set },
    requirePrivateArtifact: boolean,
    signal: AbortSignal,
  ) => {
    const prepared = await set(
      prepareVideoRequest$,
      requirePrivateArtifact,
      signal,
    );
    if ("status" in prepared) {
      return prepared;
    }
    const { auth, runId, privateArtifacts, options } = prepared;
    const publicBrand = PUBLIC_BRAND;

    const hasCredits = await set(
      checkVideoCredits$,
      { orgId: auth.orgId, userId: auth.userId, runId },
      signal,
    );
    if (!hasCredits) {
      return videoInsufficientCredits();
    }

    const pricing = await get(videoPricing$);
    signal.throwIfAborted();
    if (getMissingVideoPricing(pricing, options).length > 0) {
      return videoServiceUnavailable(
        "Video generation pricing is not configured",
        "NOT_CONFIGURED",
      );
    }

    const provider = videoProviderForModel(options.model);
    if (provider === "fal" && !env("FAL_KEY")) {
      return videoServiceUnavailable(
        "Fal video generation is not configured",
        "NOT_CONFIGURED",
      );
    }
    if (provider === "byteplus" && !env("BYTEPLUS_API_KEY")) {
      return videoServiceUnavailable(
        "BytePlus video generation is not configured",
        "NOT_CONFIGURED",
      );
    }
    if (provider === "minimax" && !env("MINIMAX_API_KEY")) {
      return videoServiceUnavailable(
        "MiniMax H3 video generation is not configured",
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
      { runId, kind: "video" },
      signal,
    );
    if (isRunBuiltInAdmissionError(admission)) {
      return admission;
    }

    await set(
      createBuiltInGenerationJob$,
      {
        generationId,
        type: "video",
        orgId: auth.orgId,
        privateArtifacts,
        userId: auth.userId,
        runId,
        request: builtInGenerationRequestWithInternal(
          videoRequestRecord(options),
          {
            admissionId: admission?.id,
            publicBrand,
          },
        ),
      },
      signal,
    );
    const submitError = await set(
      submitVideoProviderWebhookJob$,
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

    return acceptedVideoResponse(generationId, realtime);
  },
);

export const videoIoGenerateRoutes: readonly RouteEntry[] = [
  {
    route: videoIoGenerateContract.postPrivate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      command(({ set }, signal: AbortSignal) => {
        return set(postVideoInner$, true, signal);
      }),
    ),
  },
  {
    route: videoIoGenerateContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      command(({ set }, signal: AbortSignal) => {
        return set(postVideoInner$, false, signal);
      }),
    ),
  },
];
