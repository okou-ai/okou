import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { command } from "ccstate";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { replaceThreadDraft$ } from "../services/composer-draft-write.service";
import {
  conditionalComposerDraftsEnabled$,
  conditionalDraftReferencesAllowed$,
} from "../services/composer-draft-access";
import type { RouteEntry } from "../route-entry";

const replace$ = command(async ({ get, set }, signal: AbortSignal) => {
  const enabled = await get(conditionalComposerDraftsEnabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return notFound("Conditional composer drafts unavailable");
  }
  const auth = get(authContext$);
  const { id } = get(pathParamsOf(chatThreadDraftContract.replace));
  const body = await get(bodyResultOf(chatThreadDraftContract.replace));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const references = await set(
    conditionalDraftReferencesAllowed$,
    body.data.draft.draftUserMessage,
    signal,
  );
  if (!references) {
    return badRequestMessage("Projects unavailable");
  }
  if (
    !(await set(
      replaceThreadDraft$,
      { userId: auth.userId, threadId: id },
      body.data,
      signal,
    ))
  ) {
    return conflict("Composer draft changed; reload before replacing it");
  }
  return { status: 204 as const, body: undefined };
});

export const chatThreadDraftReplaceRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadDraftContract.replace,
    handler: authRoute({}, replace$),
  },
];
