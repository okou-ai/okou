import {
  voiceIoPolishContract,
  voiceIoPolishSegmentsContract,
} from "@okouai/api-contracts/contracts/voice-io-polish";
import { command } from "ccstate";

import { authRoute } from "../auth/auth-route";
import { organizationAuthContext$ } from "../auth/auth-context";
import {
  audioInputLifetimeQuota,
  recordAudioInputUsage$,
} from "../services/voice-io.service";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { polishVoiceTranscript$ } from "../services/voice-io-polish.service";

const voiceIoPolishBody$ = bodyResultOf(voiceIoPolishSegmentsContract.post);
const legacyPolishBody$ = bodyResultOf(voiceIoPolishContract.post);

// Keep the currently deployed text-only HTTP producer until the App floor and
// API rollback gate close. This adapter never reads retired IndexedDB state.
const postLegacyPolish$ = command(async ({ get, set }, signal: AbortSignal) => {
  const result = await get(legacyPolishBody$);
  signal.throwIfAborted();
  if (!result.ok) {
    return result.response;
  }
  return await set(
    polishVoiceTranscript$,
    {
      segments: [result.data.text],
      ...(result.data.lastAssistantMessage
        ? { lastAssistantMessage: result.data.lastAssistantMessage }
        : {}),
    },
    signal,
  );
});

const postVoiceIoPolish$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const bodyResult = await get(voiceIoPolishBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const auth = get(organizationAuthContext$);
    const quota = await get(audioInputLifetimeQuota(auth.orgId, auth.userId));
    signal.throwIfAborted();
    if (!quota.allowed) {
      return {
        status: 402 as const,
        body: {
          error: {
            code: "AUDIO_INPUT_QUOTA_EXCEEDED",
            message:
              "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
          },
          quota: { count: quota.count, limit: quota.limit },
        },
      };
    }
    const result = await set(polishVoiceTranscript$, bodyResult.data, signal);
    if (result.status === 200 && quota.limit !== null) {
      await set(recordAudioInputUsage$, auth.orgId, auth.userId, signal);
    }
    return result;
  },
);

export const voiceIoPolishRoutes: readonly RouteEntry[] = [
  {
    route: voiceIoPolishSegmentsContract.post,
    handler: authRoute(
      {
        accept: ["session"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      postVoiceIoPolish$,
    ),
  },
  {
    route: voiceIoPolishContract.post,
    handler: authRoute(
      {
        accept: ["session"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      postLegacyPolish$,
    ),
  },
];
