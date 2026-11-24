import {
  iosVoiceDraftTransforms,
  androidVoiceDraftTransforms,
} from "@okouai/api-contracts/client-transforms/voice-draft";
import { computed } from "ccstate";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { chatThreadNotFound } from "../../lib/error";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { chatThreadDraft } from "../services/chat-thread.service";
import type { RouteEntry } from "../route-entry";

function getThreadDraft(
  route:
    | typeof chatThreadDraftContract.get
    | typeof chatThreadDraftContract.readComposer,
) {
  const legacyMemberDraft = route === chatThreadDraftContract.get;
  return computed(async (get) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(route));
    const draft = await get(
      chatThreadDraft({
        threadId: params.id,
        orgId: auth.orgId,
        userId: auth.userId,
        legacyMemberDraft,
      }),
    );
    if (!draft && !legacyMemberDraft) {
      return chatThreadNotFound();
    }
    return {
      status: 200 as const,
      body: draft ?? { draftUserMessage: null, draftAttachments: null },
    };
  });
}

export const chatThreadDraftGetRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadDraftContract.get,
    responseTransforms: [
      iosVoiceDraftTransforms.thread,
      androidVoiceDraftTransforms.thread,
    ],
    handler: authRoute(
      { requireOrganization: true },
      getThreadDraft(chatThreadDraftContract.get),
    ),
  },
  {
    route: chatThreadDraftContract.readComposer,
    handler: authRoute(
      { requireOrganization: true },
      getThreadDraft(chatThreadDraftContract.readComposer),
    ),
  },
];
