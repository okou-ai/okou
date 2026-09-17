import { voiceIoPolishContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { command } from "ccstate";

import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { polishVoiceTranscript$ } from "../services/voice-io-polish.service";

const voiceIoPolishBody$ = bodyResultOf(voiceIoPolishContract.post);

const postVoiceIoPolish$ = command(
  async ({ get, set }, signal: AbortSignal) => {
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
