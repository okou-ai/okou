import { privateArtifactCreationEnabled } from "../services/private-artifact-storage.service";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { introVideoPresenterContract } from "@okouai/api-contracts/contracts/intro-video-presenter";
import type { BuiltInGenerationRealtimeSubscription } from "@okouai/api-contracts/contracts/built-in-generation";

import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import {
  builtInGenerationRequestWithInternal,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  mergeBuiltInGenerationJobInternal$,
} from "../services/built-in-generation.service";
import { heyGenBuiltInGenerationWebhookUrl } from "../services/built-in-generation-provider-webhooks.service";
import {
  generateHeyGenSpeech,
  isHeyGenErrorResponse,
  listHeyGenAvatarsWithVoiceSamples,
  listHeyGenPublicStyles,
  listHeyGenPublicVoicesWithSamples,
  submitHeyGenAvatarVideo,
  verifyHeyGenPublicAvatar,
  verifyHeyGenPublicVoice,
} from "../services/heygen.service";
import {
  checkIntroVideoPresenterCredits$,
  introVideoPresenterAvatarUnavailable,
  introVideoPresenterInsufficientCredits,
  introVideoPresenterPricing$,
  introVideoPresenterRequiresPaidPlan,
  introVideoPresenterServiceUnavailable,
  isIntroVideoPresenterErrorResponse,
  parseIntroVideoPresenterOptions,
  type IntroVideoPresenterOptions,
} from "../services/intro-video-presenter.service";
import {
  checkIntroVideoVoiceCredits$,
  introVideoVoiceInsufficientCredits,
  introVideoVoicePricing$,
  introVideoVoiceRequiresPaidPlan,
  introVideoVoiceServiceUnavailable,
  introVideoVoiceUnavailable,
  isIntroVideoVoiceErrorResponse,
  parseIntroVideoVoiceOptions,
  recordGeneratedIntroVideoVoice$,
} from "../services/intro-video-voice.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import { resolveProviderReferenceUrls$ } from "../services/provider-reference-url.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
} from "../services/run-built-in-admission.service";
import { onRejection } from "../utils";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import {
  introVideoDisabled,
  introVideoEnabled$,
} from "../services/intro-video-access.service";

const generateBody$ = bodyResultOf(introVideoPresenterContract.generate);
const avatarsQuery$ = queryOf(introVideoPresenterContract.avatars);
const stylesQuery$ = queryOf(introVideoPresenterContract.styles);
const voicesQuery$ = queryOf(introVideoPresenterContract.voices);
const voiceGenerateBody$ = bodyResultOf(
  introVideoPresenterContract.voiceGenerate,
);

function acceptedIntroVideoPresenterResponse(
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

function introVideoPresenterRequestRecord(
  options: IntroVideoPresenterOptions,
): Record<string, unknown> {
  return {
    purpose: "intro-video-presenter",
    avatarId: options.avatarId,
    ...(options.avatarGroupId ? { avatarGroupId: options.avatarGroupId } : {}),
    audioUrl: options.audioUrl,
    ...(options.videoName ? { videoName: options.videoName } : {}),
  };
}

const submitIntroVideoPresenterJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly options: IntroVideoPresenterOptions;
    },
    signal: AbortSignal,
  ) => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);
    const apiKey = env("HEYGEN_API_KEY");
    if (!apiKey) {
      const response = introVideoPresenterServiceUnavailable(
        "HeyGen Intro Video presenter generation is not configured",
      );
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: response.body.error },
        signal,
      );
      return response;
    }

    const references = await set(
      resolveProviderReferenceUrls$,
      {
        orgId: args.orgId,
        userId: args.userId,
        urls: [args.options.audioUrl],
      },
      signal,
    );
    if ("status" in references) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: references.body.error },
        signal,
      );
      return references;
    }
    const [audioUrl] = references;
    if (!audioUrl) {
      throw new Error("Expected one resolved Intro Video presenter audio URL");
    }
    const providerOptions = { ...args.options, audioUrl };
    const handle = await submitHeyGenAvatarVideo(
      providerOptions,
      {
        generationId: args.generationId,
        callbackUrl: heyGenBuiltInGenerationWebhookUrl({
          generationId: args.generationId,
        }),
      },
      apiKey,
      signal,
    );
    signal.throwIfAborted();
    if (isHeyGenErrorResponse(handle)) {
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
          provider: "heygen",
          providerJobId: handle.videoId,
          providerTask: "intro-video-presenter",
        },
      },
      signal,
    );
    return null;
  },
);

const getVoicesInner$ = command(async ({ get }, signal: AbortSignal) => {
  if (!(await get(introVideoEnabled$))) {
    return introVideoDisabled;
  }
  signal.throwIfAborted();
  const apiKey = env("HEYGEN_API_KEY");
  if (!apiKey) {
    return introVideoVoiceServiceUnavailable(
      "HeyGen Intro Video voices are not configured",
    );
  }
  const query = get(voicesQuery$);
  const result = await listHeyGenPublicVoicesWithSamples(
    {
      token: query.token,
      pageSize: query.pageSize ?? 24,
      language: query.language,
      gender: query.gender,
    },
    apiKey,
    signal,
  );
  if (isHeyGenErrorResponse(result)) {
    return result;
  }
  return { status: 200 as const, body: result };
});

const getAvatarsInner$ = command(async ({ get }, signal: AbortSignal) => {
  if (!(await get(introVideoEnabled$))) {
    return introVideoDisabled;
  }
  signal.throwIfAborted();
  const apiKey = env("HEYGEN_API_KEY");
  if (!apiKey) {
    return introVideoPresenterServiceUnavailable(
      "HeyGen Intro Video avatars are not configured",
    );
  }
  const query = get(avatarsQuery$);
  const result = await listHeyGenAvatarsWithVoiceSamples(
    {
      token: query.token,
      pageSize: query.pageSize ?? 24,
    },
    apiKey,
    signal,
  );
  if (isHeyGenErrorResponse(result)) {
    return result;
  }
  return { status: 200 as const, body: result };
});

const getStylesInner$ = command(async ({ get }, signal: AbortSignal) => {
  if (!(await get(introVideoEnabled$))) {
    return introVideoDisabled;
  }
  signal.throwIfAborted();
  const apiKey = env("HEYGEN_API_KEY");
  if (!apiKey) {
    return introVideoPresenterServiceUnavailable(
      "HeyGen Intro Video styles are not configured",
    );
  }
  const query = get(stylesQuery$);
  const result = await listHeyGenPublicStyles(
    {
      token: query.token,
      pageSize: query.pageSize ?? 24,
    },
    apiKey,
    signal,
  );
  if (isHeyGenErrorResponse(result)) {
    return result;
  }
  return { status: 200 as const, body: result };
});

const postVoiceGenerateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      throw new Error("Intro Video voice route requires run authentication");
    }
    if (!(await get(introVideoEnabled$))) {
      return introVideoDisabled;
    }
    signal.throwIfAborted();

    const capabilities = await loadOrgPlanCapabilities(get(db$), auth.orgId);
    signal.throwIfAborted();
    if (capabilities?.videoGenerationAllowed !== true) {
      return introVideoVoiceRequiresPaidPlan();
    }

    const bodyResult = await get(voiceGenerateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const options = parseIntroVideoVoiceOptions(bodyResult.data);
    if (isIntroVideoVoiceErrorResponse(options)) {
      return options;
    }

    const apiKey = env("HEYGEN_API_KEY");
    if (!apiKey) {
      return introVideoVoiceServiceUnavailable(
        "HeyGen Intro Video voices are not configured",
      );
    }
    const verified = await verifyHeyGenPublicVoice(
      options.voiceId,
      apiKey,
      signal,
    );
    if (isHeyGenErrorResponse(verified)) {
      return verified;
    }
    if (!verified) {
      return introVideoVoiceUnavailable();
    }

    const hasCredits = await set(
      checkIntroVideoVoiceCredits$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    if (!hasCredits) {
      return introVideoVoiceInsufficientCredits();
    }

    const pricing = await get(introVideoVoicePricing$);
    signal.throwIfAborted();
    if (!pricing) {
      return introVideoVoiceServiceUnavailable(
        "HeyGen Intro Video voice pricing is not configured",
      );
    }
    const admission = await set(
      startRunBuiltInAdmission$,
      { runId: auth.runId, kind: "voice" },
      signal,
    );
    if (isRunBuiltInAdmissionError(admission)) {
      return admission;
    }

    const privateArtifacts = await get(
      privateArtifactCreationEnabled(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();

    const response = await onRejection(
      (async () => {
        const speech = await generateHeyGenSpeech(options, apiKey, signal);
        signal.throwIfAborted();
        if (isHeyGenErrorResponse(speech)) {
          await set(completeRunBuiltInAdmission$, {
            admission,
            status: "failed",
          });
          signal.throwIfAborted();
          return speech;
        }
        const body = await set(
          recordGeneratedIntroVideoVoice$,
          {
            orgId: auth.orgId,
            userId: auth.userId,
            runId: auth.runId,
            publicBrand: PUBLIC_BRAND,
            privateArtifacts,
            pricing,
            options,
            speech,
          },
          signal,
        );
        await set(completeRunBuiltInAdmission$, {
          admission,
          status: "completed",
        });
        signal.throwIfAborted();
        return { status: 200 as const, body };
      })(),
      async () => {
        await set(completeRunBuiltInAdmission$, {
          admission,
          status: "failed",
        });
        signal.throwIfAborted();
      },
    );
    signal.throwIfAborted();
    return response;
  },
);

const postGenerateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      throw new Error(
        "Intro Video presenter route requires run authentication",
      );
    }
    if (!(await get(introVideoEnabled$))) {
      return introVideoDisabled;
    }
    signal.throwIfAborted();

    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    if (capabilities?.videoGenerationAllowed !== true) {
      return introVideoPresenterRequiresPaidPlan();
    }

    const bodyResult = await get(generateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const options = parseIntroVideoPresenterOptions(bodyResult.data);
    if (isIntroVideoPresenterErrorResponse(options)) {
      return options;
    }

    const apiKey = env("HEYGEN_API_KEY");
    if (!apiKey) {
      return introVideoPresenterServiceUnavailable(
        "HeyGen Intro Video presenter generation is not configured",
      );
    }
    if (options.avatarGroupId) {
      const verified = await verifyHeyGenPublicAvatar(
        options.avatarId,
        options.avatarGroupId,
        apiKey,
        signal,
      );
      if (isHeyGenErrorResponse(verified)) {
        return verified;
      }
      if (!verified) {
        return introVideoPresenterAvatarUnavailable();
      }
    }

    const hasCredits = await set(
      checkIntroVideoPresenterCredits$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    if (!hasCredits) {
      return introVideoPresenterInsufficientCredits();
    }

    const pricing = await get(introVideoPresenterPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      return introVideoPresenterServiceUnavailable(
        "HeyGen Intro Video presenter pricing is not configured",
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
      { runId: auth.runId, kind: "video" },
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
        userId: auth.userId,
        runId: auth.runId,
        request: builtInGenerationRequestWithInternal(
          introVideoPresenterRequestRecord(options),
          { admissionId: admission?.id, publicBrand: PUBLIC_BRAND },
        ),
      },
      signal,
    );
    const submitError = await set(
      submitIntroVideoPresenterJob$,
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

    return acceptedIntroVideoPresenterResponse(generationId, realtime);
  },
);

export const introVideoPresenterRoutes: readonly RouteEntry[] = [
  {
    route: introVideoPresenterContract.avatars,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      getAvatarsInner$,
    ),
  },
  {
    route: introVideoPresenterContract.styles,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      getStylesInner$,
    ),
  },
  {
    route: introVideoPresenterContract.voices,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      getVoicesInner$,
    ),
  },
  {
    route: introVideoPresenterContract.voiceGenerate,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postVoiceGenerateInner$,
    ),
  },
  {
    route: introVideoPresenterContract.generate,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postGenerateInner$,
    ),
  },
];
