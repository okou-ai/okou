import { command } from "ccstate";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import {
  readSuggestionManagement$,
  readSuggestions$,
} from "../services/agent-suggestion-read.service";
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
  const body = await get(bodyResultOf(feedContract.create));
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
  const body = await get(bodyResultOf(feedContract.update));
  signal.throwIfAborted();
  return body.ok
    ? await set(
        updateSuggestion$,
        owner,
        get(pathParamsOf(feedContract.update)).id,
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
        get(pathParamsOf(feedContract.remove)).id,
        signal,
      );
});
const consume$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(suggestionAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(feedContract.consume));
  signal.throwIfAborted();
  return body.ok
    ? await set(
        consumeSuggestion$,
        owner,
        get(pathParamsOf(feedContract.consume)).id,
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
export const feedRoutes: readonly RouteEntry[] = [
  {
    route: feedContract.manage,
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
              get(queryOf(feedContract.manage)).after,
              signal,
            );
      }),
    ),
  },
  {
    route: feedContract.feedback,
    handler: authRoute(
      { accept: ["session"], requireOrganization: true },
      command(async ({ get, set }, signal: AbortSignal) => {
        const owner = await set(suggestionAccess$, signal);
        if ("status" in owner) {
          return owner;
        }
        const body = await get(bodyResultOf(feedContract.feedback));
        signal.throwIfAborted();
        return body.ok
          ? await set(
              recordSuggestionFeedback$,
              owner,
              get(pathParamsOf(feedContract.feedback)).id,
              body.data,
              signal,
            )
          : body.response;
      }),
    ),
  },
  { route: feedContract.list, handler: authRoute(readAuth, list$) },
  { route: feedContract.create, handler: authRoute(writeAuth, create$) },
  { route: feedContract.update, handler: authRoute(writeAuth, update$) },
  { route: feedContract.remove, handler: authRoute(writeAuth, remove$) },
  {
    route: feedContract.consume,
    handler: authRoute(
      { accept: ["session"], requireOrganization: true },
      consume$,
    ),
  },
];
