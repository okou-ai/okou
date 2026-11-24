import { command } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
} from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { updateChatThreadDraft$ } from "../services/chat-thread.service";
import { canWriteProjectReferences } from "../services/project-reference.service";
import { badRequestMessage, chatThreadNotFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

function patchDraft(
  route:
    | typeof chatThreadByIdContract.patch
    | typeof chatThreadDraftContract.saveComposer,
) {
  const legacyMemberDraft = route === chatThreadByIdContract.patch;
  return command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(route));

    const bodyResult = await get(bodyResultOf(route));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    if (!canWriteProjectReferences(auth, bodyResult.data.draftUserMessage)) {
      return badRequestMessage("Projects unavailable");
    }
    signal.throwIfAborted();
    const saved = await set(
      updateChatThreadDraft$,
      {
        legacyMemberDraft,
        threadId: params.id,
        orgId: auth.orgId,
        userId: auth.userId,
        suggestionPreset: bodyResult.data.suggestionPreset,
        draftUserMessage: bodyResult.data.draftUserMessage ?? null,
        draftAttachments: bodyResult.data.draftAttachments ?? null,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!saved && !legacyMemberDraft) {
      return chatThreadNotFound();
    }
    return { status: 204 as const, body: undefined };
  });
}

export const chatThreadPatchRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadByIdContract.patch,
    handler: authRoute(
      { requireOrganization: true },
      patchDraft(chatThreadByIdContract.patch),
    ),
  },
  {
    route: chatThreadDraftContract.saveComposer,
    handler: authRoute(
      { requireOrganization: true },
      patchDraft(chatThreadDraftContract.saveComposer),
    ),
  },
];
