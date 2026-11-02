import { projectAwareUserMessageDocumentSchema } from "@okouai/api-contracts/contracts/project-readers";
import { userMessageInputDocumentSchema } from "@okouai/api-contracts/validators/chat-threads";
import { computed } from "ccstate";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { chatThreadDraft } from "../services/chat-thread.service";
import type { RouteEntry } from "../route-entry";

const getThreadDraftInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadDraftContract.get));
  const draft = await get(
    chatThreadDraft({ threadId: params.id, userId: auth.userId }),
  );
  return {
    status: 200 as const,
    body: {
      ...draft,
      draftUserMessage:
        draft.draftUserMessage === null
          ? null
          : userMessageInputDocumentSchema.parse(
              projectAwareUserMessageDocumentSchema.parse(
                draft.draftUserMessage,
              ),
            ),
    },
  };
});

export const chatThreadDraftGetRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadDraftContract.get,
    handler: authRoute({}, getThreadDraftInner$),
  },
];
