import { computed } from "ccstate";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { audioInputQuota } from "../services/voice-io.service";

const voiceIoQuota$ = audioInputQuota(organizationAuthContext$);

const getVoiceIoQuotaInner$ = computed(async (get): Promise<unknown> => {
  const body = await get(voiceIoQuota$);
  return {
    status: 200 as const,
    body,
  };
});

export const voiceIoQuotaRoutes: readonly RouteEntry[] = [
  {
    route: voiceIoQuotaContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getVoiceIoQuotaInner$,
    ),
  },
];
