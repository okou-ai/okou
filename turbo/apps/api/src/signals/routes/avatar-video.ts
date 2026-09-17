import { artifactVisibilityUnavailable } from "../../lib/error";
import { privateArtifactCreationEnabled } from "../services/private-artifact-storage.service";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { avatarVideoContract } from "@okouai/api-contracts/contracts/avatar-video";
import type { BuiltInGenerationRealtimeSubscription } from "@okouai/api-contracts/contracts/built-in-generation";

import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import {
  avatarVideoInsufficientCredits,
  avatarVideoPricing$,
  avatarVideoRequiresPaidPlan,
  avatarVideoServiceUnavailable,
  checkAvatarVideoCredits$,
  isAvatarVideoErrorResponse,
  listJoggAiPublicAvatars,
  listJoggAiPublicVoices,
  parseAvatarVideoOptions,
  submitJoggAiAvatarVideo,
  type AvatarVideoOptions,
} from "../services/avatar-video.service";
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

const generateBody$ = bodyResultOf(avatarVideoContract.generate);
const avatarsQuery$ = queryOf(avatarVideoContract.avatars);
const voicesQuery$ = queryOf(avatarVideoContract.voices);

function avatarVideoRequestRecord(
  options: AvatarVideoOptions,
): Record<string, unknown> {
  return {
    avatarId: options.avatarId,
    voiceId: options.voiceId,
    ...(options.script ? { script: options.script } : {}),
    ...(options.audioUrl ? { audioUrl: options.audioUrl } : {}),
    aspectRatio: options.aspectRatio,
    screenStyle: options.screenStyle,
    caption: options.caption,
    ...(options.videoName ? { videoName: options.videoName } : {}),
  };
}

function acceptedAvatarVideoResponse(
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

const submitAvatarVideoJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly options: AvatarVideoOptions;
    },
    signal: AbortSignal,
  ) => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);
    const apiKey = env("JOGGAI_API_KEY");
    if (!apiKey) {
      const response = avatarVideoServiceUnavailable(
        "JoggAI avatar video generation is not configured",
      );
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: response.body.error },
        signal,
      );
      return response;
    }

    const references = args.options.audioUrl
      ? await set(
          resolveProviderReferenceUrls$,
          {
            orgId: args.orgId,
            userId: args.userId,
            urls: [args.options.audioUrl],
          },
          signal,
        )
      : [];
    if ("status" in references) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: references.body.error },
        signal,
      );
      return references;
    }
    const providerOptions = args.options.audioUrl
      ? { ...args.options, audioUrl: references[0] }
      : args.options;
    const handle = await submitJoggAiAvatarVideo(
      providerOptions,
      apiKey,
      signal,
    );
    signal.throwIfAborted();
    if (isAvatarVideoErrorResponse(handle)) {
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
          provider: "joggai",
          providerJobId: handle.videoId,
          providerTask: "avatar-video",
        },
      },
      signal,
    );
    return null;
  },
);

const prepareAvatarVideoRequest$ = command(
  async ({ get }, requirePrivateArtifact: boolean, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    // Keep the existing route's plan-before-validation response ordering.
    if (
      !requirePrivateArtifact &&
      capabilities?.videoGenerationAllowed !== true
    ) {
      return avatarVideoRequiresPaidPlan();
    }
    const bodyResult = await get(generateBody$);
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
      return avatarVideoRequiresPaidPlan();
    }
    const options = parseAvatarVideoOptions(bodyResult.data);
    if (isAvatarVideoErrorResponse(options)) {
      return options;
    }

    const runId =
      auth.tokenType === "agent" || auth.tokenType === "sandbox"
        ? auth.runId
        : undefined;
    return { auth, runId, privateArtifacts, options };
  },
);

const postGenerateInner$ = command(
  async (
    { get, set },
    requirePrivateArtifact: boolean,
    signal: AbortSignal,
  ) => {
    const prepared = await set(
      prepareAvatarVideoRequest$,
      requirePrivateArtifact,
      signal,
    );
    if ("status" in prepared) {
      return prepared;
    }
    const { auth, runId, privateArtifacts, options } = prepared;

    const hasCredits = await set(
      checkAvatarVideoCredits$,
      { orgId: auth.orgId, userId: auth.userId, runId },
      signal,
    );
    if (!hasCredits) {
      return avatarVideoInsufficientCredits();
    }

    const pricing = await get(avatarVideoPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      return avatarVideoServiceUnavailable(
        "JoggAI avatar video pricing is not configured",
      );
    }
    if (!env("JOGGAI_API_KEY")) {
      return avatarVideoServiceUnavailable(
        "JoggAI avatar video generation is not configured",
      );
    }

    const generationId = randomUUID();
    const realtime = await createBuiltInGenerationRealtimeSubscription(
      auth.userId,
      generationId,
    );
    signal.throwIfAborted();
    const publicBrand = PUBLIC_BRAND;
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
          avatarVideoRequestRecord(options),
          { admissionId: admission?.id, publicBrand },
        ),
      },
      signal,
    );
    const submitError = await set(
      submitAvatarVideoJob$,
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

    return acceptedAvatarVideoResponse(generationId, realtime);
  },
);

const getAvatarsInner$ = command(async ({ get }, signal: AbortSignal) => {
  const apiKey = env("JOGGAI_API_KEY");
  if (!apiKey) {
    return avatarVideoServiceUnavailable(
      "JoggAI avatar video generation is not configured",
    );
  }
  const result = await listJoggAiPublicAvatars(
    get(avatarsQuery$),
    apiKey,
    signal,
  );
  if (isAvatarVideoErrorResponse(result)) {
    return result;
  }
  return { status: 200 as const, body: result };
});

const getVoicesInner$ = command(async ({ get }, signal: AbortSignal) => {
  const apiKey = env("JOGGAI_API_KEY");
  if (!apiKey) {
    return avatarVideoServiceUnavailable(
      "JoggAI avatar video generation is not configured",
    );
  }
  const result = await listJoggAiPublicVoices(
    get(voicesQuery$),
    apiKey,
    signal,
  );
  if (isAvatarVideoErrorResponse(result)) {
    return result;
  }
  return { status: 200 as const, body: result };
});

export const avatarVideoRoutes: readonly RouteEntry[] = [
  {
    route: avatarVideoContract.generatePrivate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      command(({ set }, signal: AbortSignal) => {
        return set(postGenerateInner$, true, signal);
      }),
    ),
  },
  {
    route: avatarVideoContract.generate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      command(({ set }, signal: AbortSignal) => {
        return set(postGenerateInner$, false, signal);
      }),
    ),
  },
  {
    route: avatarVideoContract.avatars,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      getAvatarsInner$,
    ),
  },
  {
    route: avatarVideoContract.voices,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      getVoicesInner$,
    ),
  },
];
