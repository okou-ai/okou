import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { standalonePreference$ } from "../services/proactive-dispatch-state.service";
import { proactivePreferenceAccess$ } from "../services/proactive-preference-access";
import {
  reconcileExistingMorningBrief$,
  updateMorningBriefPreference$,
} from "../services/morning-brief-preference.service";

const morningBriefPreferenceReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "suggestion:read",
} as const;

const morningBriefPreferenceWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "suggestion:write",
} as const;

function preferenceConflict(message: string) {
  return {
    status: 409 as const,
    body: { error: { code: "MORNING_BRIEF_STATE_CONFLICT" as const, message } },
  };
}

const getMorningBriefPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const denied = await set(proactivePreferenceAccess$, signal);
    if (denied) {
      return denied;
    }
    const owner = get(organizationAuthContext$);
    return {
      status: 200 as const,
      body: await set(standalonePreference$, owner, "morning-brief", signal),
    };
  },
);

const updateBody$ = bodyResultOf(morningBriefPreferenceContract.update);
const retryMorningBriefPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const denied = await set(proactivePreferenceAccess$, signal);
    if (denied) {
      return denied;
    }
    const owner = get(organizationAuthContext$);
    const reconciled = await set(reconcileExistingMorningBrief$, owner, signal);
    if (reconciled === "conflict") {
      return preferenceConflict(
        "Morning Brief could not be reconciled. Retry after configuration is available.",
      );
    }
    return {
      status: 200 as const,
      body: await set(standalonePreference$, owner, "morning-brief", signal),
    };
  },
);

const updateMorningBriefPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const denied = await set(proactivePreferenceAccess$, signal);
    if (denied) {
      return denied;
    }
    const auth = get(organizationAuthContext$);
    signal.throwIfAborted();
    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const saved = await set(
      updateMorningBriefPreference$,
      auth,
      body.data.enabled,
      signal,
    );
    if (!saved) {
      return preferenceConflict(
        "Morning Brief changed concurrently. Retry the preference update.",
      );
    }
    return {
      status: 200 as const,
      body: await set(standalonePreference$, auth, "morning-brief", signal),
    };
  },
);

export const morningBriefPreferenceRoutes: readonly RouteEntry[] = [
  {
    route: morningBriefPreferenceContract.retry,
    handler: authRoute(
      morningBriefPreferenceWriteAuth,
      retryMorningBriefPreferenceInner$,
    ),
  },
  {
    route: morningBriefPreferenceContract.get,
    handler: authRoute(
      morningBriefPreferenceReadAuth,
      getMorningBriefPreferenceInner$,
    ),
  },
  {
    route: morningBriefPreferenceContract.update,
    handler: authRoute(
      morningBriefPreferenceWriteAuth,
      updateMorningBriefPreferenceInner$,
    ),
  },
];
