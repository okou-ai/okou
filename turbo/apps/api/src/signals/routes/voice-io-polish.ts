import { voiceIoPolishContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { polishVoiceTranscript$ } from "../services/voice-io-polish.service";

const voiceIoPolishBody$ = bodyResultOf(voiceIoPolishContract.post);

const voiceIoPolishFeatureContext$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  return await loadUserFeatureSwitchContext(get(db$), auth.orgId, auth.userId);
});

const postVoiceIoPolish$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const featureContext = await get(voiceIoPolishFeatureContext$);
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.VoiceInputV2, featureContext)) {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN" as const,
            message: "Voice draft cleanup is not enabled",
          },
        },
      };
    }
    signal.throwIfAborted();
    const bodyResult = await get(voiceIoPolishBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(polishVoiceTranscript$, bodyResult.data, signal);
  },
);

export const voiceIoPolishRoutes: readonly RouteEntry[] = [
  {
    route: voiceIoPolishContract.post,
    handler: authRoute(
      {
        accept: ["session"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      postVoiceIoPolish$,
    ),
  },
];
