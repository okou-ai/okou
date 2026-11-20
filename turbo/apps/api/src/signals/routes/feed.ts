import { command } from "ccstate";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import {
  readSuggestionManagement$,
  readFeedItems$,
} from "../services/agent-suggestion-read.service";
import { authRoute } from "../auth/auth-route";
import { organizationAuthContext$ } from "../auth/auth-context";
import { proactivePreferenceAccess$ } from "../services/proactive-preference-access";
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
import { dismissFeedEvent$ } from "../services/feed-events.service";
import {
  readFeedSources$,
  updateFeedSources$,
  readFeedSummary$,
  markFeedItemRead$,
} from "../services/feed-sources.service";

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await set(suggestionAccess$, signal);
  return "status" in owner
    ? owner
    : await set(
        readFeedItems$,
        owner,
        get(queryOf(feedContract.list)).type,
        signal,
      );
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
const sourcesAccess$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    return await set(suggestionAccess$, signal);
  }
  const denied = await set(proactivePreferenceAccess$, signal);
  return denied ?? { userId: auth.userId, orgId: auth.orgId };
});

export const feedRoutes: readonly RouteEntry[] = [
  {
    route: feedContract.sources,
    handler: authRoute(
      readAuth,
      command(async ({ get, set }, signal: AbortSignal) => {
        set(setResHeader$, "Cache-Control", "no-store");
        const owner = await set(sourcesAccess$, signal);
        return "status" in owner
          ? owner
          : {
              status: 200 as const,
              body: await get(readFeedSources$),
            };
      }),
    ),
  },
  {
    route: feedContract.updateSources,
    handler: authRoute(
      { ...readAuth, requiredCapability: "suggestion:write" },
      command(async ({ get, set }, signal: AbortSignal) => {
        const owner = await set(sourcesAccess$, signal);
        if ("status" in owner) {
          return owner;
        }
        const body = await get(bodyResultOf(feedContract.updateSources));
        signal.throwIfAborted();
        return body.ok
          ? {
              status: 200 as const,
              body: await set(updateFeedSources$, owner, body.data, signal),
            }
          : body.response;
      }),
    ),
  },
  {
    route: feedContract.summary,
    handler: authRoute(
      { accept: ["session"], requireOrganization: true },
      command(async ({ get, set }, signal: AbortSignal) => {
        set(setResHeader$, "Cache-Control", "no-store");
        const owner = await set(suggestionAccess$, signal);
        return "status" in owner
          ? owner
          : {
              status: 200 as const,
              body: await get(readFeedSummary$),
            };
      }),
    ),
  },
  {
    route: feedContract.markRead,
    handler: authRoute(
      { accept: ["session"], requireOrganization: true },
      command(async ({ get, set }, signal: AbortSignal) => {
        const owner = await set(suggestionAccess$, signal);
        return "status" in owner
          ? owner
          : await set(
              markFeedItemRead$,
              owner,
              get(pathParamsOf(feedContract.markRead)).id,
              signal,
            );
      }),
    ),
  },
  {
    route: feedContract.dismiss,
    handler: authRoute(
      { accept: ["session"], requireOrganization: true },
      command(async ({ get, set }, signal: AbortSignal) => {
        const owner = await set(suggestionAccess$, signal);
        return "status" in owner
          ? owner
          : await set(
              dismissFeedEvent$,
              owner,
              get(pathParamsOf(feedContract.dismiss)).id,
              signal,
            );
      }),
    ),
  },
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
