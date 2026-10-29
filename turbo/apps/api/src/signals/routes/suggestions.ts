import { command } from "ccstate";
import { suggestionsContract } from "@okouai/api-contracts/contracts/suggestions";
import { suggestionLearningContract } from "@okouai/api-contracts/contracts/suggestion-learning";
import {
  readSuggestionManagement$,
  readSuggestions$,
} from "../services/agent-suggestion-read.service";
import { prepareSuggestionLearning$ } from "../services/suggestion-learning.service";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import {
  suggestionAccess$,
  createSuggestion$,
  updateSuggestion$,
  removeSuggestion$,
  consumeSuggestion$,
  recordSuggestionFeedback$,
} from "../services/agent-suggestions.service";

const list$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await set(suggestionAccess$, signal);
  return "status" in owner ? owner : await set(readSuggestions$, owner, signal);
});
const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(suggestionAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(suggestionsContract.create));
  signal.throwIfAborted();
  return body.ok
    ? await set(createSuggestion$, owner, body.data, signal)
    : body.response;
});
const update$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(suggestionAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(suggestionsContract.update));
  signal.throwIfAborted();
  return body.ok
    ? await set(
        updateSuggestion$,
        owner,
        get(pathParamsOf(suggestionsContract.update)).id,
        body.data,
        signal,
      )
    : body.response;
});
const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(suggestionAccess$, signal);
  return "status" in owner
    ? owner
    : await set(
        removeSuggestion$,
        owner,
        get(pathParamsOf(suggestionsContract.remove)).id,
        signal,
      );
});
const consume$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(suggestionAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(suggestionsContract.consume));
  signal.throwIfAborted();
  return body.ok
    ? await set(
        consumeSuggestion$,
        owner,
        get(pathParamsOf(suggestionsContract.consume)).id,
        body.data,
        signal,
      )
    : body.response;
});
const readAuth = {
  accept: ["session", "agent"],
  requireOrganization: true,
  requiredCapability: "suggestion:read",
} as const;
const writeAuth = {
  accept: ["agent"],
  requireOrganization: true,
  requiredCapability: "suggestion:write",
} as const;
export const suggestionsRoutes: readonly RouteEntry[] = [
  {
    route: suggestionsContract.manage,
    handler: authRoute(
      { ...readAuth, accept: ["agent"] },
      command(async ({ get, set }, signal: AbortSignal) => {
        set(setResHeader$, "Cache-Control", "no-store");
        const owner = await set(suggestionAccess$, signal);
        return "status" in owner
          ? owner
          : await set(
              readSuggestionManagement$,
              owner,
              get(queryOf(suggestionsContract.manage)).after,
              signal,
            );
      }),
    ),
  },
  {
    route: suggestionLearningContract.prepare,
    handler: authRoute(
      writeAuth,
      command(async ({ set }, signal: AbortSignal) => {
        const owner = await set(suggestionAccess$, signal);
        return "status" in owner
          ? owner
          : await set(prepareSuggestionLearning$, owner, signal);
      }),
    ),
  },
  {
    route: suggestionsContract.feedback,
    handler: authRoute(
      { accept: ["session"], requireOrganization: true },
      command(async ({ get, set }, signal: AbortSignal) => {
        const owner = await set(suggestionAccess$, signal);
        if ("status" in owner) {
          return owner;
        }
        const body = await get(bodyResultOf(suggestionsContract.feedback));
        signal.throwIfAborted();
        return body.ok
          ? await set(
              recordSuggestionFeedback$,
              owner,
              get(pathParamsOf(suggestionsContract.feedback)).id,
              body.data,
              signal,
            )
          : body.response;
      }),
    ),
  },
  { route: suggestionsContract.list, handler: authRoute(readAuth, list$) },
  { route: suggestionsContract.create, handler: authRoute(writeAuth, create$) },
  { route: suggestionsContract.update, handler: authRoute(writeAuth, update$) },
  { route: suggestionsContract.remove, handler: authRoute(writeAuth, remove$) },
  {
    route: suggestionsContract.consume,
    handler: authRoute(
      { accept: ["session"], requireOrganization: true },
      consume$,
    ),
  },
];
