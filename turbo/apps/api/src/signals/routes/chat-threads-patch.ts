import { command } from "ccstate";
import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { updateChatThreadDraft$ } from "../services/chat-thread.service";
import { projectReferenceWritesEnabled } from "../services/project-reference.service";
import { badRequestMessage } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const patchInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadByIdContract.patch));

  const bodyResult = await get(bodyResultOf(chatThreadByIdContract.patch));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  if (
    !(await get(
      projectReferenceWritesEnabled(auth, bodyResult.data.draftUserMessage),
    ))
  ) {
    return badRequestMessage("Projects unavailable");
  }
  signal.throwIfAborted();
  await set(
    updateChatThreadDraft$,
    {
      threadId: params.id,
      userId: auth.userId,
      draftUserMessage: bodyResult.data.draftUserMessage ?? null,
      draftAttachments: bodyResult.data.draftAttachments ?? null,
    },
    signal,
  );
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

export const chatThreadPatchRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadByIdContract.patch,
    handler: authRoute({}, patchInner$),
  },
];
