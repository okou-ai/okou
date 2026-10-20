import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { reconcileExistingMorningBrief$ } from "../services/morning-brief-recovery.service";
import {
  morningBriefPreference$,
  updateMorningBriefPreference$,
  type MorningBriefPreferenceFailure,
} from "../services/morning-brief-preference.service";

const morningBriefPreferenceReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const morningBriefPreferenceWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

function memberFromAuth(auth: {
  readonly userId: string;
  readonly orgRole?: string | null;
}) {
  return { userId: auth.userId, role: auth.orgRole ?? "member" };
}

function failureResponse(failure: MorningBriefPreferenceFailure) {
  return {
    status: failure.kind === "bad-request" ? (400 as const) : (409 as const),
    body: { error: { code: failure.code, message: failure.message } },
  };
}

const getMorningBriefPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    signal.throwIfAborted();
    const result = await set(
      morningBriefPreference$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.kind === "ok"
      ? { status: 200 as const, body: result.preference }
      : failureResponse(result);
  },
);

const updateBody$ = bodyResultOf(morningBriefPreferenceContract.update);
const retryMorningBriefPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const reconciled = await set(
      reconcileExistingMorningBrief$,
      { orgId: auth.orgId, member: memberFromAuth(auth) },
      signal,
    );
    signal.throwIfAborted();
    if (reconciled === "conflict" || reconciled === "ineligible") {
      return failureResponse({
        kind: "conflict",
        code: "MORNING_BRIEF_STATE_CONFLICT",
        message:
          "Morning Brief could not be reconciled. Retry after configuration is available.",
      });
    }
    return await set(getMorningBriefPreferenceInner$, signal);
  },
);

const updateMorningBriefPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    signal.throwIfAborted();
    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(
      updateMorningBriefPreference$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        enabled: body.data.enabled,
      },
      signal,
    );
    signal.throwIfAborted();
    return result.kind === "ok"
      ? { status: 200 as const, body: result.preference }
      : failureResponse(result);
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
