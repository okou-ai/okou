import {
  iosVoiceDraftTransforms,
  androidVoiceDraftTransforms,
} from "@okouai/api-contracts/client-transforms/voice-draft";
import { computed } from "ccstate";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { chatThreadDraft } from "../services/chat-thread.service";
import type { RouteEntry } from "../route-entry";

const getThreadDraftInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadDraftContract.get));
  const draft = await get(
    chatThreadDraft({
      threadId: params.id,
      orgId: auth.orgId,
      userId: auth.userId,
    }),
  );
  return {
    status: 200 as const,
    body: draft,
  };
});

export const chatThreadDraftGetRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadDraftContract.get,
    responseTransforms: [
      iosVoiceDraftTransforms.thread,
      androidVoiceDraftTransforms.thread,
    ],
    handler: authRoute({ requireOrganization: true }, getThreadDraftInner$),
  },
];
