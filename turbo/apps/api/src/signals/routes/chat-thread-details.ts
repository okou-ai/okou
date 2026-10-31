import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { computed } from "ccstate";
import { string } from "zod";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  chatThreadDetail,
  chatThreadDraftIds,
} from "../services/chat-thread.service";
import { chatThreadNotFound } from "./chat-thread-not-found";

const chatThreadIdSchema = string().uuid();

function isValidChatThreadId(id: string): boolean {
  return chatThreadIdSchema.safeParse(id).success;
}

const getChatThreadInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadByIdContract.get));

  if (!isValidChatThreadId(params.id)) {
    return chatThreadNotFound();
  }

  const thread = await get(
    chatThreadDetail({ threadId: params.id, userId: auth.userId }),
  );
  if (!thread) {
    return chatThreadNotFound();
  }

  return { status: 200 as const, body: thread };
});

const listChatThreadDraftsInner$ = computed(async (get) => {
  const auth = get(authContext$);

  const draftThreadIds = await get(
    chatThreadDraftIds({
      userId: auth.userId,
    }),
  );

  return {
    status: 200 as const,
    body: { draftThreadIds: [...draftThreadIds] },
  };
});

export const chatThreadDetailRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.drafts,
    handler: authRoute({}, listChatThreadDraftsInner$),
  },
  {
    route: chatThreadByIdContract.get,
    handler: authRoute({}, getChatThreadInner$),
  },
];
