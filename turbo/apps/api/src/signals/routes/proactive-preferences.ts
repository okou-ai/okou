import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { command } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { publishAgentSuggestionsChangedSafely } from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import {
  standalonePreference$,
  saveStandaloneSuggestions$,
} from "../services/proactive-dispatch-state.service";
import { proactivePreferenceAccess$ } from "../services/proactive-preference-access";

const preferenceRoute$ = command(
  async (
    { get, set },
    operation: "read" | "update" | "withFeed",
    signal: AbortSignal,
  ) => {
    const denied = await set(proactivePreferenceAccess$, signal);
    if (denied) {
      return denied;
    }
    const auth = get(organizationAuthContext$);
    const owner = { orgId: auth.orgId, userId: auth.userId };
    if (operation !== "read") {
      const withFeed = operation === "withFeed";
      const body = await get(
        bodyResultOf(
          withFeed
            ? proactiveSuggestionsContract.updateWithFeed
            : proactiveSuggestionsContract.update,
        ),
      );
      signal.throwIfAborted();
      if (!body.ok) {
        return body.response;
      }
      await set(
        saveStandaloneSuggestions$,
        owner,
        body.data.enabled,
        withFeed,
        signal,
      );
      if (withFeed) {
        await publishAgentSuggestionsChangedSafely(owner);
      }
    }
    return {
      status: 200 as const,
      body: await set(standalonePreference$, owner, "suggestions", signal),
    };
  },
);

const read$ = command(async ({ set }, signal: AbortSignal) => {
  return await set(preferenceRoute$, "read", signal);
});
const update$ = command(async ({ set }, signal: AbortSignal) => {
  return await set(preferenceRoute$, "update", signal);
});
const readAuth = {
  accept: ["session", "agent"],
  requireOrganization: true,
  requiredCapability: "suggestion:read",
} as const;
const writeAuth = {
  ...readAuth,
  requiredCapability: "suggestion:write",
} as const;
export const proactiveSuggestionsRoutes: readonly RouteEntry[] = [
  {
    route: proactiveSuggestionsContract.get,
    handler: authRoute(readAuth, read$),
  },
  {
    route: proactiveSuggestionsContract.update,
    handler: authRoute(writeAuth, update$),
  },
  {
    route: proactiveSuggestionsContract.updateWithFeed,
    handler: authRoute(
      writeAuth,
      command(async ({ set }, signal: AbortSignal) => {
        return await set(preferenceRoute$, "withFeed", signal);
      }),
    ),
  },
];
